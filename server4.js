const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
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

// ---- In-memory storage ----
const users = new Map();          // socketId -> { type, agentId, whatsapp }
const agents = new Map();         // agentId -> { name, password, muted, socketId, filename?, restrictions? }
const agentUsers = new Map();     // agentId -> Set(whatsapp)
const userAssignments = new Map(); // whatsapp -> agentId
const activeChats = new Map();    // whatsapp -> { lastMessage, lastMessageTime }
const userMessages = [];          // All user messages for Super Admin
const activityLog = [];           // Activity log

// ---- MongoDB Collections ----
let db;
let conversationsCollection;
let agentsCollection;

// ---- Helper Functions ----
function logActivity(type, details) {
  const log = {
    type,
    details,
    timestamp: new Date().toISOString()
  };
  activityLog.push(log);
  if (activityLog.length > 1000) activityLog.shift();
  console.log(`[Activity] ${type}:`, details);
  return log;
}

async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    conversationsCollection = db.collection("conversations");
    agentsCollection = db.collection("agents");
    
    await conversationsCollection.createIndex({ whatsapp: 1 });
    await conversationsCollection.createIndex({ "messages.timestamp": 1 });
    await agentsCollection.createIndex({ name: 1 }, { unique: true });
    
    console.log("✓ Connected to MongoDB");
    return true;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    return false;
  }
}

async function loadAgentsFromDB() {
  try {
    if (!agentsCollection) return;
    
    const agentsFromDB = await agentsCollection.find({}).toArray();
    agentsFromDB.forEach(agentDoc => {
      const agentId = agentDoc._id.toString();
      agents.set(agentId, {
        ...agentDoc,
        muted: agentDoc.muted || false,
        socketId: null,
        lastSeen: null
      });
      
      if (!agentUsers.has(agentId)) {
        agentUsers.set(agentId, new Set());
      }
    });
    
    console.log(`✓ Loaded ${agentsFromDB.length} agents from DB`);
  } catch (error) {
    console.error("Error loading agents from DB:", error);
  }
}

async function saveAgentToDB(agentId, agentData) {
  try {
    if (!agentsCollection) return false;
    
    await agentsCollection.updateOne(
      { _id: new ObjectId(agentId) },
      { $set: { ...agentData, updatedAt: new Date() } },
      { upsert: true }
    );
    return true;
  } catch (error) {
    console.error("Error saving agent to DB:", error);
    return false;
  }
}

async function saveMessageToMongoDB(whatsapp, message) {
  try {
    if (!conversationsCollection) return false;
    
    const conversation = await conversationsCollection.findOne({ whatsapp });
    
    if (conversation) {
      await conversationsCollection.updateOne(
        { whatsapp },
        {
          $push: { messages: message },
          $set: { 
            lastUpdated: new Date(),
            lastMessage: message.text || (message.attachment ? `[${message.attachment.mimetype?.split('/')[0] || 'File'}]` : ''),
            lastMessageTime: message.timestamp
          }
        }
      );
    } else {
      await conversationsCollection.insertOne({
        whatsapp,
        messages: [message],
        createdAt: new Date(),
        lastUpdated: new Date(),
        lastMessage: message.text || (message.attachment ? `[${message.attachment.mimetype?.split('/')[0] || 'File'}]` : ''),
        lastMessageTime: message.timestamp
      });
    }
    
    return true;
  } catch (error) {
    console.error("Error saving message to MongoDB:", error);
    return false;
  }
}

// ---- Setup server ----
const app = express();
const server = http.createServer(app);

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
app.use(express.static(path.join(__dirname, "public")));

// ---- Routes ----
app.get("/", (req, res) => res.send("Chat backend running"));
app.get("/chat", (req, res) => res.sendFile(path.join(__dirname, "public", "chat.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/superadmin", (req, res) => res.sendFile(path.join(__dirname, "public", "superadmin.html")));
app.get("/agent", (req, res) => res.sendFile(path.join(__dirname, "public", "agent.html")));

// Agent files
app.get("/agent:num.html", (req, res) => {
  const filename = `agent${req.params.num}.html`;
  const filePath = path.join(__dirname, filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Agent file not found");
  }
});

// File upload endpoint - UPDATED to provide full URL
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
      // Add full URL for client-side access
      url: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`,
      uploadDate: new Date()
    };

    res.json({ success: true, file: fileInfo });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ success: false, message: "Upload failed" });
  }
});

// Test MongoDB route
app.get("/test-mongo", async (req, res) => {
  try {
    if (!conversationsCollection) {
      return res.json({ status: "MongoDB not connected" });
    }
    
    const count = await conversationsCollection.countDocuments();
    const recentMessages = await conversationsCollection.find({})
      .sort({ lastUpdated: -1 })
      .limit(5)
      .toArray();
    
    res.json({
      status: "MongoDB connected",
      totalConversations: count,
      recentConversations: recentMessages.map(c => ({
        whatsapp: c.whatsapp,
        messageCount: c.messages?.length || 0,
        lastMessage: c.lastMessage,
        lastUpdated: c.lastUpdated
      }))
    });
  } catch (error) {
    res.json({ status: "Error", error: error.message });
  }
});

// ---- Socket.IO events ----
io.on("connection", (socket) => {
  console.log("New connection:", socket.id);
  users.set(socket.id, { type: 'unknown' });

  // ===== SUPER ADMIN EVENTS =====
  socket.on("super_admin_login", async ({ password }) => {
    if (password === SUPER_ADMIN_PASSWORD) {
      users.set(socket.id, { type: 'super_admin' });
      socket.join("super_admin");
      
      logActivity('super_admin_login', { socketId: socket.id });
      console.log("✓ Super Admin connected:", socket.id);
      
      // Send agents list to Super Admin
      const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
        id,
        name: agent.name,
        muted: agent.muted || false,
        isOnline: agent.socketId ? true : false,
        socketId: agent.socketId,
        filename: agent.filename || null
      }));
      
      socket.emit("super_admin_login_response", { success: true });
      socket.emit("agents_list", agentsList);
      socket.emit("activity_update", activityLog.slice(-50));
      
    } else {
      socket.emit("super_admin_login_response", { 
        success: false, 
        message: "Invalid super admin password" 
      });
    }
  });

  // ===== PERMANENT AGENT REGISTRATION =====
  socket.on("register_permanent_agent", async (data) => {
    const { id, name, password, filename } = data;
    
    if (!id || !name || !password) {
      socket.emit("agent_registered", { 
        success: false, 
        message: "Missing required fields" 
      });
      return;
    }
    
    try {
      // Check if agent already exists
      const existingAgent = agents.get(id);
      
      if (existingAgent) {
        // Update existing agent with new data if needed
        if (!existingAgent.filename && filename) {
          existingAgent.filename = filename;
        }
        
        socket.emit("agent_registered", { 
          success: true, 
          message: "Agent already exists",
          agentId: id
        });
        
        logActivity('agent_updated', { 
          agentId: id, 
          name: name,
          filename: filename || existingAgent.filename 
        });
      } else {
        // Create new permanent agent
        agents.set(id, {
          name,
          password,
          muted: false,
          socketId: null,
          filename: filename || null,
          createdAt: new Date(),
          lastSeen: null
        });
        
        // Initialize agent users set
        if (!agentUsers.has(id)) {
          agentUsers.set(id, new Set());
        }
        
        // Save to MongoDB
        await saveAgentToDB(id, {
          name,
          password,
          muted: false,
          filename: filename || null,
          createdAt: new Date(),
          updatedAt: new Date()
        });
        
        socket.emit("agent_registered", { 
          success: true, 
          message: "Agent registered successfully",
          agentId: id
        });
        
        logActivity('permanent_agent_created', { 
          agentId: id, 
          name: name,
          filename: filename || 'no file'
        });
      }
      
      // Notify Super Admin if connected
      const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
        id,
        name: agent.name,
        muted: agent.muted || false,
        isOnline: agent.socketId ? true : false,
        socketId: agent.socketId,
        filename: agent.filename || null
      }));
      
      io.to("super_admin").emit("agents_list", agentsList);
      
    } catch (error) {
      console.error("Error registering permanent agent:", error);
      socket.emit("agent_registered", { 
        success: false, 
        message: "Registration failed" 
      });
    }
  });

  // Get agents list
  socket.on("get_agents", () => {
    const userData = users.get(socket.id);
    if (userData?.type === 'super_admin') {
      const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
        id,
        name: agent.name,
        muted: agent.muted || false,
        isOnline: agent.socketId ? true : false,
        socketId: agent.socketId,
        filename: agent.filename || null
      }));
      socket.emit("agents_list", agentsList);
    }
  });

  // Save/Update agent credentials
  socket.on("save_agent", async ({ name, id, password }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    let agentId = id;
    const existingAgent = agents.get(id);
    
    if (existingAgent) {
      // Update existing agent
      existingAgent.name = name;
      existingAgent.password = password;
      
      // Save to MongoDB
      await saveAgentToDB(agentId, {
        name,
        password,
        muted: existingAgent.muted || false,
        updatedAt: new Date()
      });
    } else {
      // Create new agent
      agentId = id || `agent_${Date.now()}`;
      agents.set(agentId, {
        name,
        password,
        muted: false,
        socketId: null,
        createdAt: new Date()
      });
      
      // Initialize agent users set
      if (!agentUsers.has(agentId)) {
        agentUsers.set(agentId, new Set());
      }
      
      // Save to MongoDB
      await saveAgentToDB(agentId, {
        name,
        password,
        muted: false,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }
    
    logActivity('agent_saved', { agentId, name, by: socket.id });
    
    // Send updated list to Super Admin
    const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
      id,
      name: agent.name,
      muted: agent.muted || false,
      isOnline: agent.socketId ? true : false,
      socketId: agent.socketId,
      filename: agent.filename || null
    }));
    
    io.to("super_admin").emit("agents_list", agentsList);
    socket.emit("agent_updated", { success: true });
  });

  // Toggle agent mute status
  socket.on("toggle_agent_mute", async ({ agentId }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    const agent = agents.get(agentId);
    if (!agent) return;
    
    // Toggle mute status
    agent.muted = !agent.muted;
    
    // Save to MongoDB
    await saveAgentToDB(agentId, {
      muted: agent.muted,
      updatedAt: new Date()
    });
    
    logActivity('agent_mute_toggled', { 
      agentId, 
      name: agent.name, 
      muted: agent.muted,
      by: socket.id 
    });
    
    // Send mute status to agent if online
    if (agent.socketId) {
      io.to(agent.socketId).emit("mute_status", {
        agentId,
        muted: agent.muted
      });
    }
    
    // Send updated list to Super Admin
    const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
      id,
      name: agent.name,
      muted: agent.muted || false,
      isOnline: agent.socketId ? true : false,
      socketId: agent.socketId,
      filename: agent.filename || null
    }));
    
    io.to("super_admin").emit("agents_list", agentsList);
    io.to("super_admin").emit("agent_updated", { agentId });
  });

  // Forward messages to agents
  socket.on("forward_to_agents", (data) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    // Send to all non-muted agents
    agents.forEach((agent, agentId) => {
      if (!agent.muted && agent.socketId) {
        io.to(agent.socketId).emit("forwarded_message", data);
      }
    });
    
    // Also send to all Super Admins for monitoring
    io.to("super_admin").emit("forwarded_message", data);
    
    logActivity('message_forwarded', {
      type: data.type,
      toAgents: true,
      by: socket.id
    });
  });

  // Get super admin data with ALL info
  socket.on("get_super_admin_data", async () => {
    const userData = users.get(socket.id);
    if (userData?.type === 'super_admin') {
      try {
        const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
          id,
          name: agent.name,
          muted: agent.muted || false,
          isOnline: agent.socketId ? true : false,
          socketId: agent.socketId,
          filename: agent.filename || null,
          userCount: agentUsers.get(id) ? agentUsers.get(id).size : 0
        }));
        
        const activeChatsList = Array.from(activeChats.values());
        
        socket.emit("super_admin_data", {
          agents: agentsList,
          activeChats: activeChatsList,
          activity: activityLog.slice(-100),
          stats: {
            totalAgents: agents.size,
            onlineAgents: Array.from(agents.values()).filter(a => a.socketId).length,
            activeChats: activeChatsList.length,
            mutedAgents: Array.from(agents.values()).filter(a => a.muted).length
          }
        });
      } catch (error) {
        console.error("Error getting super admin data:", error);
      }
    }
  });

  // ===== AGENT EVENTS =====
  socket.on("agent_login", async ({ agentId, password }) => {
    const agent = agents.get(agentId);
    
    if (!agent) {
      socket.emit("agent_login_response", {
        success: false,
        message: "Agent not found. Please refresh the agent page to auto-register."
      });
      return;
    }
    
    if (agent.password !== password) {
      socket.emit("agent_login_response", {
        success: false,
        message: "Invalid password"
      });
      return;
    }
    
    // Check if agent is muted
    if (agent.muted) {
      socket.emit("agent_login_response", {
        success: false,
        message: "Agent account is muted. Contact super admin."
      });
      return;
    }
    
    // Update agent status
    agent.socketId = socket.id;
    agent.lastSeen = new Date();
    users.set(socket.id, { type: 'agent', agentId });
    
    logActivity('agent_login', { 
      agentId, 
      name: agent.name, 
      socketId: socket.id,
      filename: agent.filename || 'no file'
    });
    
    socket.emit("agent_login_response", {
      success: true,
      name: agent.name,
      muted: agent.muted || false
    });
    
    // Notify Super Admin
    const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
      id,
      name: agent.name,
      muted: agent.muted || false,
      isOnline: agent.socketId ? true : false,
      socketId: agent.socketId,
      filename: agent.filename || null
    }));
    
    io.to("super_admin").emit("agents_list", agentsList);
    io.to("super_admin").emit("agent_updated", { agentId });
  });

  // Agent sends message
  socket.on("agent_message", async (data) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'agent') return;
    
    const agent = agents.get(userData.agentId);
    if (!agent) return;
    
    // Check if agent is muted
    if (agent.muted) {
      socket.emit("agent_message_error", {
        message: "Cannot send messages while muted"
      });
      return;
    }
    
    // Save agent message to MongoDB if we have user context
    if (data.whatsapp && conversationsCollection) {
      const message = {
        sender: 'agent',
        agentId: userData.agentId,
        agentName: agent.name,
        text: data.message,
        timestamp: new Date().toISOString(),
        read: true
      };
      await saveMessageToMongoDB(data.whatsapp, message);
    }
    
    // Send to super_admin in consistent format
    io.to("super_admin").emit("new_message", {
      sender: 'agent',
      agentId: userData.agentId,
      agentName: agent.name,
      message: data.message,
      whatsapp: data.whatsapp || 'unknown',
      timestamp: new Date().toISOString(),
      id: `agent_${Date.now()}`,
      messageType: 'agent_message'
    });
    
    // Also send to the specific user if we have their whatsapp
    if (data.whatsapp) {
      io.to(data.whatsapp).emit("new_message", {
        sender: 'agent',
        agentId: userData.agentId,
        agentName: agent.name,
        message: data.message,
        whatsapp: data.whatsapp,
        timestamp: new Date().toISOString()
      });
    }
    
    logActivity('agent_message_sent', {
      agentId: userData.agentId,
      agentName: agent.name,
      message: data.message,
      to: data.whatsapp || 'broadcast'
    });
  });

  // ===== USER MESSAGES - FIXED VERSION (NO DUPLICATES) =====
  socket.on("user_message", async (data) => {
    console.log("📨 Received user_message event:", data);
    
    // Ensure we have whatsapp/userId
    const whatsapp = data.whatsapp || data.userId;
    if (!whatsapp) {
      console.error("No whatsapp/userId provided");
      return;
    }
    
    // Create a clean message object
    const message = {
      whatsapp: whatsapp,
      userId: data.userId || whatsapp,
      message: data.message,
      timestamp: new Date().toISOString(),
      id: `${whatsapp}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, // Unique ID
      sender: "user",
      type: data.type || "text"
    };
    
    // Handle attachments - KEEP ORIGINAL ATTACHMENT DATA AS IS
    if (data.attachment) {
      message.attachment = data.attachment;
      message.type = data.attachment.mimetype?.startsWith('image/') ? 'image' : 'file';
    }
    
    // Save to MongoDB
    if (conversationsCollection) {
      const dbMessage = {
        ...message,
        sender: 'user',
        text: data.message || '',
        timestamp: message.timestamp
      };
      
      if (data.attachment) {
        dbMessage.attachment = data.attachment;
      }
      
      await saveMessageToMongoDB(whatsapp, dbMessage);
      console.log("✓ Message saved to MongoDB");
    }
    
    // ===== FIXED BROADCASTING - NO DUPLICATES =====
    
    // 1. Send confirmation to the user who sent it
    socket.emit("new_message", {
      ...message,
      sender: "user",
      text: data.message || '',
      attachment: data.attachment || null
    });
    
    // 2. Create ONE broadcast message
    const broadcastMessage = {
      ...message,
      sender: "user",
      text: data.message || '',
      attachment: data.attachment || null,
      // Add messageType to distinguish from agent messages
      messageType: 'user_message'
    };
    
    // 3. Send to super_admin and admin as ONE event (not multiple)
    // Use chained .to() to send to multiple rooms with ONE emit
    io.to("super_admin").to("admin").emit("new_message", broadcastMessage);
    
    // 4. Send to non-muted agents as ONE event type
    const onlineAgents = [];
    agents.forEach((agent, agentId) => {
      if (!agent.muted && agent.socketId) {
        io.to(agent.socketId).emit("new_message", broadcastMessage);
        onlineAgents.push(agentId);
      }
    });
    
    console.log(`📢 Broadcast to: Super Admin, Admin, and ${onlineAgents.length} agents`);
    console.log(`📎 Attachment sent:`, data.attachment ? `Type: ${data.attachment.mimetype}, URL: ${data.attachment.url || data.attachment.path}` : 'No attachment');
    
    // Update active chats
    activeChats.set(whatsapp, {
      whatsapp: whatsapp,
      lastMessage: data.message || (data.attachment ? `[${data.attachment.mimetype?.split('/')[0] || 'File'}]` : ''),
      lastMessageTime: message.timestamp,
      unread: true
    });
    
    logActivity('user_message_received', {
      from: whatsapp,
      message: data.message ? data.message.substring(0, 50) + '...' : '[Attachment]',
      hasAttachment: !!data.attachment,
      attachmentType: data.attachment?.mimetype || 'none',
      forwardedToAgents: onlineAgents.length
    });
  });

  // ===== OLD FUNCTIONALITY (RETAINED) =====
  
  // Admin connect
  socket.on("admin_connect", async () => {
    console.log("✓ Admin connected:", socket.id);
    users.set(socket.id, { type: 'admin' });
    socket.join("admin");

    try {
      if (conversationsCollection) {
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

  // User register (with whatsapp)
  socket.on("register", ({ whatsapp }) => {
    if (!whatsapp) return;
    users.set(socket.id, { whatsapp, type: 'user' });
    socket.join(whatsapp);
    socket.emit("registered", { success: true });
    console.log(`✓ Registered: ${whatsapp} with socket ${socket.id}`);
  });

  // LEGACY: send_message handler for backward compatibility
  socket.on("send_message", async ({ whatsapp, sender, text, agentId, agentName, attachment }) => {
    console.log("⚠️ LEGACY send_message event received - converting to user_message");
    
    if (!whatsapp) return;
    
    // Convert legacy format to user_message format
    const userData = users.get(socket.id);
    
    // If sender is user, use user_message format
    if (sender === "user" || !sender) {
      socket.emit("user_message", {
        whatsapp: whatsapp,
        userId: whatsapp,
        message: text || '',
        attachment: attachment || null
      });
    } 
    // If sender is agent/admin, use agent_message format
    else if (sender === "agent" || sender === "admin") {
      const messageData = {
        whatsapp: whatsapp,
        message: text || '',
        timestamp: new Date().toISOString()
      };
      
      if (attachment) {
        messageData.attachment = attachment;
      }
      
      // Save to MongoDB
      if (conversationsCollection) {
        const message = {
          sender: sender,
          agentId: agentId || 'admin',
          agentName: agentName || 'Admin',
          text: text,
          timestamp: new Date().toISOString(),
          read: true
        };
        
        if (attachment) {
          message.attachment = attachment;
        }
        
        await saveMessageToMongoDB(whatsapp, message);
      }
      
      // Send to user
      io.to(whatsapp).emit("new_message", {
        sender: sender,
        agentId: agentId,
        agentName: agentName,
        message: text,
        whatsapp: whatsapp,
        timestamp: new Date().toISOString(),
        attachment: attachment || null,
        messageType: 'agent_message'
      });
      
      // Send to super_admin and admin as ONE event
      io.to("super_admin").to("admin").emit("new_message", {
        sender: sender,
        agentId: agentId,
        agentName: agentName,
        message: text,
        whatsapp: whatsapp,
        timestamp: new Date().toISOString(),
        attachment: attachment || null,
        messageType: 'agent_message'
      });
    }
  });

  // Get messages
  socket.on("get_messages", async ({ whatsapp, agentId, markAsRead = false }) => {
    try {
      if (!conversationsCollection) {
        socket.emit("message_history", []);
        return;
      }
      
      const conversation = await conversationsCollection.findOne({ whatsapp });
      if (!conversation || !conversation.messages) {
        socket.emit("message_history", []);
        return;
      }
      
      socket.emit("message_history", conversation.messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      socket.emit("message_history", []);
    }
  });

  // Get existing users for agent interface
  socket.on("get_existing_users", async () => {
    try {
      if (!conversationsCollection) {
        socket.emit("existing_users", []);
        return;
      }
      
      const conversations = await conversationsCollection.find({}).toArray();
      const usersList = conversations.map(c => ({
        whatsapp: c.whatsapp,
        lastMessage: c.lastMessage,
        lastMessageTime: c.lastUpdated,
        messageCount: c.messages?.length || 0
      }));
      
      socket.emit("existing_users", usersList);
    } catch (error) {
      console.error("Error fetching existing users:", error);
      socket.emit("existing_users", []);
    }
  });

  // Clear chat
  socket.on("clear_chat", async ({ whatsapp }) => {
    try {
      if (conversationsCollection) {
        await conversationsCollection.updateOne(
          { whatsapp },
          { 
            $set: { 
              messages: [], 
              lastUpdated: new Date(),
              lastMessage: null,
              lastMessageTime: null
            } 
          }
        );
        
        activeChats.delete(whatsapp);
        
        socket.emit("clear_chat_response", { success: true });
        io.to(whatsapp).emit("chat_cleared", { whatsapp });
        
        logActivity('chat_cleared', { whatsapp, by: socket.id });
      } else {
        socket.emit("clear_chat_response", { 
          success: false, 
          message: "Database not connected" 
        });
      }
    } catch (error) {
      console.error("Error clearing chat:", error);
      socket.emit("clear_chat_response", { 
        success: false, 
        message: "Failed to clear chat" 
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
          agent.socketId = null;
          agent.lastSeen = new Date();
          console.log(`✗ Agent disconnected: ${agent.name} (${socket.id})`);
          
          // Notify Super Admin
          io.to("super_admin").emit("agent_updated", { agentId: user.agentId });
        }
      } else if (user.type === 'super_admin') {
        console.log(`✗ Super Admin disconnected: ${socket.id}`);
      } else if (user.type === 'admin') {
        console.log(`✗ Admin disconnected: ${socket.id}`);
      } else if (user.type === 'user') {
        console.log(`✗ User disconnected: ${user.whatsapp} (${socket.id})`);
      }
    }
    
    users.delete(socket.id);
  });
});

// Initialize and start server
async function startServer() {
  const PORT = process.env.PORT || 3000;
  
  try {
    const mongoConnected = await connectToMongoDB();
    if (!mongoConnected) {
      console.error("❌ Failed to connect to MongoDB. Server will still run but messages won't be saved.");
    } else {
      console.log("✓ MongoDB connected successfully");
      await loadAgentsFromDB();
    }

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔐 Super Admin password: ${SUPER_ADMIN_PASSWORD}`);
      console.log(`📁 Available routes:`);
      console.log(`   /chat - User chat interface`);
      console.log(`   /admin - Original admin panel`);
      console.log(`   /superadmin - Super admin panel`);
      console.log(`   /agent - Agent panel`);
      console.log(`📂 Uploads directory: ${UPLOADS_DIR}`);
      console.log(`🔍 Test MongoDB: http://localhost:${PORT}/test-mongo`);
      console.log(`\n✅ System is ready with ALL functionality!`);
      console.log(`🔧 Permanent Agent System: Agents auto-register via agentX.html files`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();