const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const { MongoClient } = require("mongodb");
const multer = require("multer");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

// ===== SUPER ADMIN CONFIGURATION =====
const SUPER_ADMIN_PASSWORD = "SUPER.ADMIN"; // Change this if needed
// =====================================

// ===== MongoDB Configuration =====
const MONGO_URI = "mongodb+srv://chaloalba05_db_user:lam08Xnkf8v0zV3W@albastuzbackup.frhubzf.mongodb.net/?appName=Albastuzbackup";
const DB_NAME = "chat_system";
// =================================

// ===== File Upload Configuration =====
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueName = uuidv4() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});
// =====================================

// ---- In-memory storage (for active connections) ----
const users = new Map();          // socketId -> { whatsapp, type }
const agents = new Map();         // agentId -> { name, password, restrictions, isOnline, socketId, lastSeen }
const userAssignments = new Map(); // whatsapp -> agentId
const agentUsers = new Map();     // agentId -> Set(whatsapp)
const activityLog = [];           // Array of activity events

// ---- MongoDB Collections ----
let db;
let conversationsCollection;

// ---- Setup server ----
const app = express();
const server = http.createServer(app);

// CORS configuration
const io = new Server(server, {
  cors: {
    origin: ["https://chat-backend-p2b9.onrender.com", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST"]
  }
});

app.use(cors({
  origin: ["https://chat-backend-p2b9.onrender.com", "http://localhost:3000"],
  credentials: true
}));

app.use(express.json());
app.use("/uploads", express.static(UPLOADS_DIR));

// ---- Serve HTML files ----
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.send("Chat backend running"));

// Explicit routes for easy links
app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/agentadmin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "agentadmin.html"));
});
app.get("/superadmin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "superadmin.html"));
});

// File upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const fileInfo = {
      filename: req.file.filename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: `/uploads/${req.file.filename}`,
      uploadDate: new Date()
    };

    res.json({
      success: true,
      file: fileInfo
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ success: false, message: "Upload failed" });
  }
});

// Helper function to log activity
function logActivity(type, details) {
  const log = {
    type,
    details,
    timestamp: new Date().toISOString()
  };
  activityLog.push(log);
  // Keep only last 1000 activities
  if (activityLog.length > 1000) {
    activityLog.shift();
  }
  return log;
}

// Generate unique agent ID
function generateAgentId() {
  return 'agent_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// MongoDB Helper Functions
async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    conversationsCollection = db.collection("conversations");
    
    // Create indexes for better performance
    await conversationsCollection.createIndex({ whatsapp: 1 });
    await conversationsCollection.createIndex({ "messages.timestamp": 1 });
    await conversationsCollection.createIndex({ whatsapp: 1, "messages.timestamp": 1 });
    
    console.log("✓ Connected to MongoDB");
    return true;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    // Don't crash the server, just log the error
    return false;
  }
}

async function saveMessageToMongoDB(whatsapp, message) {
  try {
    if (!conversationsCollection) {
      console.error("MongoDB not connected, message not saved");
      return false;
    }
    
    // Find or create conversation document
    const conversation = await conversationsCollection.findOne({ whatsapp });
    
    if (conversation) {
      // Add message to existing conversation
      await conversationsCollection.updateOne(
        { whatsapp },
        {
          $push: {
            messages: {
              $each: [message],
              $sort: { timestamp: 1 }
            }
          },
          $set: { lastUpdated: new Date() }
        }
      );
    } else {
      // Create new conversation document
      await conversationsCollection.insertOne({
        whatsapp,
        messages: [message],
        createdAt: new Date(),
        lastUpdated: new Date()
      });
    }
    
    return true;
  } catch (error) {
    console.error("Error saving message to MongoDB:", error);
    return false;
  }
}

async function getMessagesFromMongoDB(whatsapp, agentId = null) {
  try {
    if (!conversationsCollection) {
      console.error("MongoDB not connected");
      return [];
    }
    
    const conversation = await conversationsCollection.findOne(
      { whatsapp },
      { projection: { messages: 1 } }
    );
    
    if (!conversation || !conversation.messages) {
      return [];
    }
    
    // Filter messages by agent if specified
    let messages = conversation.messages;
    if (agentId) {
      messages = messages.filter(msg => 
        msg.sender !== "agent" || msg.agentId === agentId
      );
    }
    
    // Sort by timestamp (already sorted by MongoDB index)
    return messages;
  } catch (error) {
    console.error("Error fetching messages from MongoDB:", error);
    return [];
  }
}

async function clearChatInMongoDB(whatsapp) {
  try {
    if (!conversationsCollection) {
      console.error("MongoDB not connected");
      return false;
    }
    
    await conversationsCollection.updateOne(
      { whatsapp },
      { $set: { messages: [], lastUpdated: new Date() } }
    );
    return true;
  } catch (error) {
    console.error("Error clearing chat in MongoDB:", error);
    return false;
  }
}

// ---- Socket.IO events ----
io.on("connection", (socket) => {
  console.log("Incoming connection from:", socket.id);
  users.set(socket.id, { type: 'unknown' });

  // ===== SUPER ADMIN CONNECTION =====
  socket.on("super_admin_login", async ({ password }) => {
    if (password === SUPER_ADMIN_PASSWORD) {
      users.set(socket.id, { type: 'super_admin' });
      socket.join("super_admin");
      
      logActivity('super_admin_login', { socketId: socket.id });
      console.log("✓ Super Admin connected:", socket.id);
      
      try {
        // Get all conversations from MongoDB for stats
        let conversationsFromDB = [];
        if (conversationsCollection) {
          conversationsFromDB = await conversationsCollection.find({}).toArray();
        }
        
        const allUsers = conversationsFromDB.map(conv => ({
          whatsapp: conv.whatsapp,
          assignedAgent: userAssignments.get(conv.whatsapp),
          messageCount: conv.messages?.length || 0,
          lastMessage: conv.messages?.[conv.messages.length - 1]?.timestamp
        }));
        
        const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
          id,
          name: agent.name,
          isOnline: agent.isOnline,
          socketId: agent.socketId,
          lastSeen: agent.lastSeen,
          restrictions: agent.restrictions,
          userCount: agentUsers.get(id) ? agentUsers.get(id).size : 0
        }));
        
        socket.emit("super_admin_data", {
          agents: agentsList,
          users: allUsers,
          activity: activityLog.slice(-100),
          stats: {
            totalAgents: agents.size,
            onlineAgents: Array.from(agents.values()).filter(a => a.isOnline).length,
            totalUsers: conversationsFromDB.length,
            activeChats: conversationsFromDB.filter(conv => conv.messages?.length > 0).length
          }
        });
        
        socket.emit("super_admin_login_response", { success: true });
      } catch (error) {
        console.error("Error loading super admin data:", error);
        socket.emit("super_admin_login_response", { 
          success: false, 
          message: "Error loading data from database" 
        });
      }
    } else {
      socket.emit("super_admin_login_response", { 
        success: false, 
        message: "Invalid super admin password" 
      });
    }
  });

  // Super admin requests
  socket.on("get_super_admin_data", async () => {
    const userData = users.get(socket.id);
    if (userData?.type === 'super_admin') {
      const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
        id,
        name: agent.name,
        isOnline: agent.isOnline,
        socketId: agent.socketId,
        lastSeen: agent.lastSeen,
        restrictions: agent.restrictions,
        userCount: agentUsers.get(id) ? agentUsers.get(id).size : 0
      }));
      
      socket.emit("super_admin_update", {
        agents: agentsList,
        activity: activityLog.slice(-100)
      });
    }
  });

  // Create new agent
  socket.on("create_agent", ({ name, password, restrictions }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    // Check if agent name already exists
    const existingAgent = Array.from(agents.values()).find(a => a.name === name);
    if (existingAgent) {
      socket.emit("agent_creation_response", {
        success: false,
        message: "Agent name already exists"
      });
      return;
    }
    
    const agentId = generateAgentId();
    agents.set(agentId, {
      name,
      password,
      restrictions: restrictions || {},
      isOnline: false,
      socketId: null,
      lastSeen: null
    });
    
    agentUsers.set(agentId, new Set());
    
    logActivity('agent_created', { agentId, agentName: name, by: socket.id });
    
    // Notify all super admins
    io.to("super_admin").emit("agent_created", {
      id: agentId,
      name,
      restrictions: restrictions || {},
      isOnline: false,
      userCount: 0
    });
    
    socket.emit("agent_creation_response", {
      success: true,
      agentId,
      message: "Agent created successfully"
    });
  });

  // Update agent
  socket.on("update_agent", ({ agentId, name, password, restrictions }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    const agent = agents.get(agentId);
    if (!agent) return;
    
    if (name) agent.name = name;
    if (password) agent.password = password;
    if (restrictions) agent.restrictions = restrictions;
    
    // Update online agent if connected
    if (agent.isOnline && agent.socketId) {
      io.to(agent.socketId).emit("agent_restrictions_updated", restrictions);
    }
    
    logActivity('agent_updated', { agentId, agentName: name, by: socket.id });
    
    io.to("super_admin").emit("agent_updated", {
      id: agentId,
      name: agent.name,
      restrictions: agent.restrictions
    });
    
    socket.emit("agent_update_response", { success: true });
  });

  // Delete agent
  socket.on("delete_agent", ({ agentId }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    const agent = agents.get(agentId);
    if (!agent) return;
    
    // Unassign all users from this agent
    const assignedUsers = agentUsers.get(agentId);
    if (assignedUsers) {
      assignedUsers.forEach(whatsapp => {
        userAssignments.delete(whatsapp);
      });
    }
    
    // Disconnect agent if online
    if (agent.socketId) {
      io.to(agent.socketId).emit("agent_deleted");
    }
    
    agents.delete(agentId);
    agentUsers.delete(agentId);
    
    logActivity('agent_deleted', { agentId, agentName: agent.name, by: socket.id });
    
    io.to("super_admin").emit("agent_deleted", { agentId });
    socket.emit("agent_delete_response", { success: true });
  });

  // Assign user to agent
  socket.on("assign_user", ({ whatsapp, agentId }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    // If agentId is null, unassign
    if (!agentId) {
      const currentAgentId = userAssignments.get(whatsapp);
      if (currentAgentId) {
        const userSet = agentUsers.get(currentAgentId);
        if (userSet) userSet.delete(whatsapp);
        
        // Notify the agent
        const agent = agents.get(currentAgentId);
        if (agent?.socketId) {
          io.to(agent.socketId).emit("user_unassigned", { whatsapp, agentId: currentAgentId });
        }
      }
      userAssignments.delete(whatsapp);
      
      logActivity('user_unassigned', { whatsapp, by: socket.id });
      socket.emit("user_assignment_response", { success: true });
      return;
    }
    
    const agent = agents.get(agentId);
    if (!agent) return;
    
    // Check agent's user limit restriction
    const userSet = agentUsers.get(agentId);
    if (agent.restrictions.maxUsers && userSet && userSet.size >= agent.restrictions.maxUsers) {
      socket.emit("user_assignment_response", {
        success: false,
        message: `Agent has reached maximum user limit (${agent.restrictions.maxUsers})`
      });
      return;
    }
    
    // Unassign from current agent if any
    const currentAgentId = userAssignments.get(whatsapp);
    if (currentAgentId && currentAgentId !== agentId) {
      const currentUserSet = agentUsers.get(currentAgentId);
      if (currentUserSet) currentUserSet.delete(whatsapp);
      
      // Notify previous agent
      const prevAgent = agents.get(currentAgentId);
      if (prevAgent?.socketId) {
        io.to(prevAgent.socketId).emit("user_unassigned", { whatsapp, agentId: currentAgentId });
      }
    }
    
    // Assign to new agent
    userAssignments.set(whatsapp, agentId);
    if (!userSet) agentUsers.set(agentId, new Set([whatsapp]));
    else userSet.add(whatsapp);
    
    // Notify the agent
    if (agent.socketId) {
      io.to(agent.socketId).emit("user_assigned", { whatsapp, agentId });
      
      // Send system message
      io.to(agent.socketId).emit("new_message", {
        whatsapp,
        sender: "system",
        text: `User ${whatsapp} has been assigned to you`,
        timestamp: new Date().toISOString()
      });
    }
    
    logActivity('user_assigned', { whatsapp, agentId, agentName: agent.name, by: socket.id });
    
    socket.emit("user_assignment_response", { success: true });
  });

  // ===== AGENT CONNECTION =====
  socket.on("agent_login", ({ agentName, password, socketId }) => {
    // Find agent by name and password
    const agentEntry = Array.from(agents.entries()).find(([id, agent]) => 
      agent.name === agentName && agent.password === password
    );
    
    if (agentEntry) {
      const [agentId, agent] = agentEntry;
      
      // Update agent status
      agent.isOnline = true;
      agent.socketId = socket.id;
      agent.lastSeen = new Date().toISOString();
      
      users.set(socket.id, { type: 'agent', agentId });
      socket.join(`agent_${agentId}`);
      
      logActivity('agent_login', { agentId, agentName, socketId: socket.id });
      console.log(`✓ Agent logged in: ${agentName} (${agentId})`);
      
      // Send agent their data and assigned users
      const assignedUsers = Array.from(agentUsers.get(agentId) || []);
      socket.emit("agent_login_response", {
        success: true,
        agentId,
        restrictions: agent.restrictions,
        assignedUsers
      });
      
      // Notify super admins
      io.to("super_admin").emit("agent_status_change", {
        agentId,
        isOnline: true,
        socketId: socket.id
      });
    } else {
      socket.emit("agent_login_response", {
        success: false,
        message: "Invalid agent name or password"
      });
    }
  });

  socket.on("agent_online", ({ agentId, agentName, restrictions }) => {
    const agent = agents.get(agentId);
    if (agent) {
      agent.isOnline = true;
      agent.socketId = socket.id;
      agent.lastSeen = new Date().toISOString();
      
      users.set(socket.id, { type: 'agent', agentId });
      socket.join(`agent_${agentId}`);
      
      // Send assigned users
      const assignedUsers = Array.from(agentUsers.get(agentId) || []);
      socket.emit("assigned_users", assignedUsers);
      
      io.to("super_admin").emit("agent_status_change", {
        agentId,
        isOnline: true,
        socketId: socket.id
      });
    }
  });

  socket.on("agent_heartbeat", ({ agentId }) => {
    const agent = agents.get(agentId);
    if (agent) {
      agent.lastSeen = new Date().toISOString();
    }
  });

  socket.on("agent_offline", ({ agentId }) => {
    const agent = agents.get(agentId);
    if (agent) {
      agent.isOnline = false;
      agent.lastSeen = new Date().toISOString();
      
      io.to("super_admin").emit("agent_status_change", {
        agentId,
        isOnline: false,
        socketId: null
      });
    }
  });

  // ===== REGULAR ADMIN CONNECTION =====
  socket.on("admin_connect", async () => {
    console.log("✓ Admin connected:", socket.id);
    users.set(socket.id, { type: 'admin' });
    socket.join("admin");

    try {
      if (conversationsCollection) {
        // Send all past conversations to admin
        const conversationsFromDB = await conversationsCollection.find({}).toArray();
        conversationsFromDB.forEach(conv => {
          if (conv.messages) {
            conv.messages.forEach(msg => socket.emit("new_message", msg));
          }
        });
      }
    } catch (error) {
      console.error("Error loading messages for admin:", error);
    }
  });

  // ===== USER CONNECTION =====
  socket.on("register", ({ whatsapp }) => {
    if (!whatsapp) return;

    users.set(socket.id, { whatsapp, type: 'user' });

    socket.join(whatsapp);
    socket.emit("registered", { success: true });
    console.log(`✓ Registered: ${whatsapp} with socket ${socket.id}`);
  });

  // ===== MESSAGE HANDLING =====
  socket.on("send_message", async ({ whatsapp, sender, text, agentId, agentName, attachment }) => {
    if (!whatsapp || (!text && !attachment)) return;

    const message = { 
      sender: sender || "user", 
      whatsapp, 
      text: text || "",
      timestamp: new Date().toISOString(),
      agentId,
      agentName
    };

    // Add attachment if present
    if (attachment) {
      message.attachment = attachment;
      console.log(`\n📎 Attachment sent from ${message.sender} to ${whatsapp}: ${attachment.filename}`);
    } else {
      console.log(`\n📨 Message from ${message.sender} to ${whatsapp}: "${text}"`);
    }

    // Save to MongoDB if connected
    if (conversationsCollection) {
      const savedToDB = await saveMessageToMongoDB(whatsapp, message);
      if (!savedToDB) {
        console.error("Failed to save message to MongoDB");
        // Still send to users but log the error
      }
    } else {
      console.log("⚠️ MongoDB not connected, message not saved to database");
    }

    logActivity('message_sent', { 
      whatsapp, 
      sender: message.sender, 
      agentId, 
      agentName,
      hasAttachment: !!attachment 
    });

    // Send to user's room
    io.to(whatsapp).emit("new_message", message);
    
    if (message.sender === "user") {
      // User sent message - check if assigned to agent
      const assignedAgentId = userAssignments.get(whatsapp);
      if (assignedAgentId) {
        const agent = agents.get(assignedAgentId);
        if (agent?.socketId) {
          io.to(agent.socketId).emit("new_message", message);
        } else {
          // If agent offline, notify super admins
          io.to("super_admin").emit("new_message", { ...message, assignedAgentId, agentOffline: true });
        }
      } else {
        // Not assigned - notify super admins
        io.to("super_admin").emit("new_message", { ...message, unassigned: true });
      }
    } else if (message.sender === "agent") {
      // Agent sent message - also send to super admins for monitoring
      io.to("super_admin").emit("new_message", message);
    } else if (message.sender !== "admin") {
      // Regular user message to admin channel
      io.to("admin").emit("new_message", message);
    }
  });

  // Get message history
  socket.on("get_messages", async ({ whatsapp, agentId }) => {
    const userData = users.get(socket.id);
    
    // Check if agent is authorized to view these messages
    if (agentId) {
      const assignedAgentId = userAssignments.get(whatsapp);
      if (assignedAgentId !== agentId) {
        socket.emit("message_history", []);
        return;
      }
    }
    
    const messages = await getMessagesFromMongoDB(whatsapp, agentId);
    socket.emit("message_history", messages);
  });

  // Clear chat
  socket.on("clear_chat", async ({ whatsapp, agentId }) => {
    const userData = users.get(socket.id);
    const agent = agents.get(agentId);
    
    // Check if agent can clear chats
    if (agent && agent.restrictions.canClear === false) {
      socket.emit("clear_chat_response", { 
        success: false, 
        message: "You are not allowed to clear chats" 
      });
      return;
    }
    
    if (conversationsCollection) {
      const cleared = await clearChatInMongoDB(whatsapp);
      if (cleared) {
        logActivity('chat_cleared', { whatsapp, by: agentId || 'admin' });
        
        socket.emit("clear_chat_response", { success: true });
        
        // Notify all parties
        io.to(whatsapp).emit("chat_cleared", { whatsapp });
        if (agentId) {
          const agentSocket = agent?.socketId;
          if (agentSocket) io.to(agentSocket).emit("chat_cleared", { whatsapp });
        }
      } else {
        socket.emit("clear_chat_response", { 
          success: false, 
          message: "Failed to clear chat from database" 
        });
      }
    } else {
      socket.emit("clear_chat_response", { 
        success: false, 
        message: "Database not connected" 
      });
    }
  });

  // ===== DISCONNECTION =====
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      if (user.type === 'agent' && user.agentId) {
        const agent = agents.get(user.agentId);
        if (agent) {
          agent.isOnline = false;
          agent.lastSeen = new Date().toISOString();
          
          io.to("super_admin").emit("agent_status_change", {
            agentId: user.agentId,
            isOnline: false,
            socketId: null
          });
          
          console.log(`✗ Agent disconnected: ${agent.name} (${socket.id})`);
        }
      } else if (user.type === 'user') {
        console.log(`✗ User disconnected: ${user.whatsapp} (${socket.id})`);
      } else {
        console.log(`✗ Disconnected: ${socket.id} (${user.type})`);
      }
    } else {
      console.log(`✗ Disconnected: ${socket.id} (unknown)`);
    }
    
    users.delete(socket.id);
  });

  // Periodically clean up old data
  setInterval(() => {
    const now = Date.now();
    // Could implement cleanup logic here if needed
  }, 60000); // Every minute
});

// Initialize MongoDB connection and start server
async function startServer() {
  const PORT = process.env.PORT || 3000;
  
  try {
    const mongoConnected = await connectToMongoDB();
    if (!mongoConnected) {
      console.error("❌ Failed to connect to MongoDB. Server will still run but messages won't be saved.");
    } else {
      console.log("✓ MongoDB connected successfully");
    }

    // Start the server
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔐 Super Admin password: ${SUPER_ADMIN_PASSWORD}`);
      console.log(`📁 Available routes:`);
      console.log(`   /chat - User chat interface`);
      console.log(`   /admin - Original admin panel`);
      console.log(`   /agentadmin - Agent admin panel`);
      console.log(`   /superadmin - Super admin panel`);
      console.log(`📂 Uploads directory: ${UPLOADS_DIR}`);
      console.log(`🗄️  MongoDB collection: conversations`);
      console.log(`\n✅ System is ready!`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();