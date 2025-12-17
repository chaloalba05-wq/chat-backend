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

// ===== NEW: Configuration =====
const MIN_MESSAGES_FOR_PERSISTENCE = 7; // Only save chats with 7+ messages
const AUTO_CLEANUP_DAYS = 30; // Auto-delete chats older than 30 days with < 7 messages

// ---- Enhanced Helper Functions ----
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
    
    // Create indexes for better performance
    await conversationsCollection.createIndex({ whatsapp: 1 });
    await conversationsCollection.createIndex({ "messages.timestamp": 1 });
    await conversationsCollection.createIndex({ lastUpdated: -1 });
    await conversationsCollection.createIndex({ "messages.readBy": 1 });
    await agentsCollection.createIndex({ name: 1 }, { unique: true });
    
    console.log("✓ Connected to MongoDB");
    
    // Run cleanup on startup
    await cleanupOldChats();
    
    return true;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    return false;
  }
}

// NEW: Clean up old chats with few messages
async function cleanupOldChats() {
  try {
    if (!conversationsCollection) return;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - AUTO_CLEANUP_DAYS);
    
    const result = await conversationsCollection.deleteMany({
      $and: [
        { lastUpdated: { $lt: cutoffDate } },
        { $expr: { $lt: [{ $size: "$messages" }, MIN_MESSAGES_FOR_PERSISTENCE] } }
      ]
    });
    
    if (result.deletedCount > 0) {
      console.log(`🗑️  Cleaned up ${result.deletedCount} old chats with < ${MIN_MESSAGES_FOR_PERSISTENCE} messages`);
    }
  } catch (error) {
    console.error("Error cleaning up old chats:", error);
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

// ===== ENHANCED: Save ALL messages to MongoDB =====
async function saveMessageToMongoDB(whatsapp, message, forceSave = false) {
  try {
    if (!conversationsCollection) return false;
    
    const conversation = await conversationsCollection.findOne({ whatsapp });
    
    if (conversation) {
      // Update existing conversation
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
      return true;
    } else {
      // Only save new conversations if they have enough messages OR forceSave is true
      if (forceSave || MIN_MESSAGES_FOR_PERSISTENCE <= 1) {
        await conversationsCollection.insertOne({
          whatsapp,
          messages: [message],
          createdAt: new Date(),
          lastUpdated: new Date(),
          lastMessage: message.text || (message.attachment ? `[${message.attachment.mimetype?.split('/')[0] || 'File'}]` : ''),
          lastMessageTime: message.timestamp,
          archived: false,
          messageCount: 1
        });
        return true;
      } else {
        // Store temporarily in memory only (not in DB)
        console.log(`📝 Chat with ${whatsapp} has < ${MIN_MESSAGES_FOR_PERSISTENCE} messages, not saving to DB yet`);
        return false; // Not saved to DB
      }
    }
  } catch (error) {
    console.error("Error saving message to MongoDB:", error);
    return false;
  }
}

// ===== NEW: Function to check if chat should be moved from memory to DB =====
async function checkAndSaveChatToDB(whatsapp) {
  try {
    if (!conversationsCollection) return false;
    
    // Check if chat exists in memory (activeChats)
    const chatInMemory = activeChats.get(whatsapp);
    if (!chatInMemory) return false;
    
    // For now, we'll save all active chats to DB for persistence
    // But we can add logic here to check message count if we track it
    return true;
  } catch (error) {
    console.error("Error checking chat:", error);
    return false;
  }
}

// ===== NEW: Broadcast message to ALL agents =====
async function broadcastToAllAgents(messageData, excludeSocketId = null) {
  try {
    // Send to all non-muted agents
    agents.forEach((agent, agentId) => {
      if (!agent.muted && agent.socketId && agent.socketId !== excludeSocketId) {
        io.to(agent.socketId).emit("new_message", {
          ...messageData,
          isBroadcast: true,
          timestamp: messageData.timestamp || new Date().toISOString()
        });
      }
    });
    
    return true;
  } catch (error) {
    console.error("Error broadcasting to agents:", error);
    return false;
  }
}

// ===== NEW: Send all active chats to an agent when they login =====
async function sendAllActiveChatsToAgent(agentSocketId) {
  try {
    if (!conversationsCollection) return;
    
    // Get all conversations from DB
    const conversations = await conversationsCollection.find({ 
      archived: { $ne: true },
      "messages.0": { $exists: true } // Has at least one message
    })
    .sort({ lastUpdated: -1 })
    .limit(50) // Limit to recent 50 chats
    .toArray();
    
    // Send each chat's messages to the agent
    conversations.forEach(conv => {
      if (conv.messages && conv.messages.length > 0) {
        conv.messages.forEach(message => {
          io.to(agentSocketId).emit("new_message", {
            ...message,
            whatsapp: conv.whatsapp,
            isHistorical: true
          });
        });
      }
    });
    
    console.log(`📨 Sent ${conversations.length} chat histories to agent`);
  } catch (error) {
    console.error("Error sending chat history to agent:", error);
  }
}

// ===== NEW: Delete entire chat =====
async function deleteChatFromDB(whatsapp) {
  try {
    if (!conversationsCollection) return false;
    
    const result = await conversationsCollection.deleteOne({ whatsapp });
    
    if (result.deletedCount > 0) {
      // Remove from active chats
      activeChats.delete(whatsapp);
      
      // Notify all agents and admins
      io.emit("chat_deleted", { whatsapp });
      
      logActivity('chat_deleted', { whatsapp, messagesDeleted: true });
      console.log(`🗑️  Deleted chat: ${whatsapp}`);
      
      return true;
    }
    
    return false;
  } catch (error) {
    console.error("Error deleting chat from DB:", error);
    return false;
  }
}

// ===== NEW: Archive chat (soft delete) =====
async function archiveChat(whatsapp) {
  try {
    if (!conversationsCollection) return false;
    
    const result = await conversationsCollection.updateOne(
      { whatsapp },
      { $set: { archived: true, archivedAt: new Date() } }
    );
    
    if (result.modifiedCount > 0) {
      // Notify all agents and admins
      io.emit("chat_archived", { whatsapp });
      
      logActivity('chat_archived', { whatsapp });
      console.log(`📁 Archived chat: ${whatsapp}`);
      
      return true;
    }
    
    return false;
  } catch (error) {
    console.error("Error archiving chat:", error);
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

// New route: Fetch all conversations for agent dashboard
app.get("/agent/conversations", async (req, res) => {
  try {
    if (!conversationsCollection) {
      return res.status(500).json({ success: false, message: "Database not connected" });
    }
    
    const conversations = await conversationsCollection.find({ archived: { $ne: true } })
      .sort({ lastUpdated: -1 })
      .project({ 
        whatsapp: 1, 
        lastMessage: 1, 
        lastMessageTime: 1, 
        createdAt: 1,
        lastUpdated: 1,
        messageCount: { $size: "$messages" } 
      })
      .toArray();
    res.json({ success: true, conversations });
  } catch (error) {
    console.error("Error fetching conversations:", error);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ===== NEW ROUTE: Delete chat =====
app.delete("/chat/:whatsapp", async (req, res) => {
  try {
    const { whatsapp } = req.params;
    const { archive } = req.query; // Optional: archive instead of delete
    
    if (!conversationsCollection) {
      return res.status(500).json({ success: false, message: "Database not connected" });
    }
    
    let success;
    if (archive === 'true') {
      success = await archiveChat(whatsapp);
    } else {
      success = await deleteChatFromDB(whatsapp);
    }
    
    if (success) {
      res.json({ 
        success: true, 
        message: archive === 'true' ? "Chat archived" : "Chat deleted" 
      });
    } else {
      res.status(404).json({ 
        success: false, 
        message: "Chat not found" 
      });
    }
  } catch (error) {
    console.error("Error deleting chat:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== NEW ROUTE: Get archived chats =====
app.get("/chats/archived", async (req, res) => {
  try {
    if (!conversationsCollection) {
      return res.status(500).json({ success: false, message: "Database not connected" });
    }
    
    const archivedChats = await conversationsCollection.find({ archived: true })
      .sort({ archivedAt: -1 })
      .project({ 
        whatsapp: 1, 
        lastMessage: 1, 
        lastMessageTime: 1,
        archivedAt: 1,
        messageCount: { $size: "$messages" } 
      })
      .toArray();
    
    res.json({ success: true, chats: archivedChats });
  } catch (error) {
    console.error("Error fetching archived chats:", error);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ===== NEW ROUTE: Restore archived chat =====
app.post("/chat/:whatsapp/restore", async (req, res) => {
  try {
    const { whatsapp } = req.params;
    
    if (!conversationsCollection) {
      return res.status(500).json({ success: false, message: "Database not connected" });
    }
    
    const result = await conversationsCollection.updateOne(
      { whatsapp },
      { $unset: { archived: "", archivedAt: "" } }
    );
    
    if (result.modifiedCount > 0) {
      res.json({ success: true, message: "Chat restored" });
    } else {
      res.status(404).json({ success: false, message: "Chat not found" });
    }
  } catch (error) {
    console.error("Error restoring chat:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
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
      minMessagesForPersistence: MIN_MESSAGES_FOR_PERSISTENCE,
      recentConversations: recentMessages.map(c => ({
        whatsapp: c.whatsapp,
        messageCount: c.messages?.length || 0,
        lastMessage: c.lastMessage,
        lastUpdated: c.lastUpdated,
        archived: c.archived || false
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

  // ===== ENHANCED: AGENT EVENTS =====
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
    
    // Send all active chats history to this agent
    await sendAllActiveChatsToAgent(socket.id);
    
    socket.emit("agent_login_response", {
      success: true,
      name: agent.name,
      muted: agent.muted || false,
      config: {
        minMessagesForPersistence: MIN_MESSAGES_FOR_PERSISTENCE
      }
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

  // ===== ENHANCED: Agent sends message =====
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
    
    const whatsapp = data.whatsapp || 'unknown';
    const messageId = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create message object
    const message = {
      sender: 'agent',
      agentId: userData.agentId,
      agentName: agent.name,
      text: data.message || '',
      timestamp: new Date().toISOString(),
      read: true,
      id: messageId,
      whatsapp: whatsapp,
      messageType: 'agent_message'
    };
    
    if (data.attachment) {
      message.attachment = data.attachment;
      message.type = data.attachment.mimetype?.startsWith('image/') ? 'image' : 'file';
    }
    
    // ===== SAVE TO MONGODB (ALWAYS for agent messages) =====
    if (conversationsCollection) {
      await saveMessageToMongoDB(whatsapp, message, true); // forceSave = true for agent messages
      console.log("✓ Agent message saved to MongoDB");
    }
    
    // ===== BROADCAST TO ALL AGENTS, ADMINS, AND SUPER ADMINS =====
    
    // 1. Send to super_admin and admin
    io.to("super_admin").to("admin").emit("new_message", message);
    
    // 2. Send to the specific user if we have their whatsapp
    if (whatsapp !== 'unknown') {
      io.to(whatsapp).emit("new_message", {
        ...message,
        // Don't include agent details to user
        agentId: undefined,
        agentName: undefined
      });
    }
    
    // 3. Broadcast to all other agents (excluding the sender)
    await broadcastToAllAgents(message, socket.id);
    
    // Update active chats
    activeChats.set(whatsapp, {
      whatsapp: whatsapp,
      lastMessage: data.message || (data.attachment ? `[${data.attachment.mimetype?.split('/')[0] || 'File'}]` : ''),
      lastMessageTime: message.timestamp,
      unread: false,
      lastAgent: userData.agentId
    });
    
    logActivity('agent_message_sent', {
      agentId: userData.agentId,
      agentName: agent.name,
      message: data.message ? data.message.substring(0, 50) + '...' : '[Attachment]',
      to: whatsapp,
      savedToDB: true
    });
  });

  // ===== ENHANCED: USER MESSAGES =====
  socket.on("user_message", async (data) => {
    console.log("📨 Received user_message event:", data);
    
    // Ensure we have whatsapp/userId
    const whatsapp = data.whatsapp || data.userId;
    if (!whatsapp) {
      console.error("No whatsapp/userId provided");
      return;
    }
    
    const messageId = `${whatsapp}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create a clean message object
    const message = {
      whatsapp: whatsapp,
      userId: data.userId || whatsapp,
      message: data.message || '',
      timestamp: new Date().toISOString(),
      id: messageId,
      sender: "user",
      type: data.type || "text",
      read: false,
      readBy: [],
      messageType: 'user_message'
    };
    
    // Handle attachments
    if (data.attachment) {
      message.attachment = data.attachment;
      message.type = data.attachment.mimetype?.startsWith('image/') ? 'image' : 'file';
    }
    
    // ===== SAVE TO MONGODB =====
    let savedToDB = false;
    if (conversationsCollection) {
      savedToDB = await saveMessageToMongoDB(whatsapp, message);
      console.log(`✓ User message ${savedToDB ? 'saved to MongoDB' : 'stored in memory only'}`);
    }
    
    // ===== BROADCAST TO EVERYONE =====
    
    // 1. Send confirmation to the user who sent it
    socket.emit("new_message", {
      ...message,
      sender: "user",
      savedToDB: savedToDB
    });
    
    // 2. Send to super_admin and admin
    io.to("super_admin").to("admin").emit("new_message", {
      ...message,
      sender: "user",
      savedToDB: savedToDB
    });
    
    // 3. Broadcast to all agents
    await broadcastToAllAgents({
      ...message,
      sender: "user",
      savedToDB: savedToDB
    });
    
    console.log(`📢 Broadcast to: Super Admin, Admin, and all agents`);
    
    // Update active chats
    activeChats.set(whatsapp, {
      whatsapp: whatsapp,
      lastMessage: data.message || (data.attachment ? `[${data.attachment.mimetype?.split('/')[0] || 'File'}]` : ''),
      lastMessageTime: message.timestamp,
      unread: true,
      savedToDB: savedToDB
    });
    
    logActivity('user_message_received', {
      from: whatsapp,
      message: data.message ? data.message.substring(0, 50) + '...' : '[Attachment]',
      hasAttachment: !!data.attachment,
      savedToDB: savedToDB,
      forwardedToAllAgents: true
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
        const conversationsFromDB = await conversationsCollection.find({ archived: { $ne: true } }).toArray();
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
    console.log("⚠️ LEGACY send_message event received - converting to appropriate format");
    
    if (!whatsapp) return;
    
    // Convert legacy format
    const userData = users.get(socket.id);
    
    if (sender === "user" || !sender) {
      // Use user_message format
      socket.emit("user_message", {
        whatsapp: whatsapp,
        userId: whatsapp,
        message: text || '',
        attachment: attachment || null
      });
    } 
    else if (sender === "agent" || sender === "admin") {
      // Use agent_message format
      const messageData = {
        whatsapp: whatsapp,
        message: text || '',
        timestamp: new Date().toISOString(),
        attachment: attachment || null
      };
      
      // Save to MongoDB
      if (conversationsCollection) {
        const message = {
          sender: sender,
          agentId: agentId || 'admin',
          agentName: agentName || 'Admin',
          text: text,
          timestamp: new Date().toISOString(),
          read: true,
          id: `legacy_${Date.now()}`
        };
        
        if (attachment) {
          message.attachment = attachment;
        }
        
        await saveMessageToMongoDB(whatsapp, message, true);
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
      
      // Send to super_admin and admin
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
      
      // Broadcast to all agents
      await broadcastToAllAgents({
        sender: sender,
        agentId: agentId,
        agentName: agentName,
        message: text,
        whatsapp: whatsapp,
        timestamp: new Date().toISOString(),
        attachment: attachment || null,
        messageType: 'agent_message'
      }, socket.id);
    }
  });

  // Get messages - ENHANCED VERSION with read tracking
  socket.on("get_messages", async ({ whatsapp, agentId, markAsRead = true }) => {
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
      
      // Mark unread messages as read by this agent
      if (markAsRead && agentId) {
        const messagesToUpdate = [];
        conversation.messages.forEach((msg, index) => {
          if (msg.sender === "user" && (!msg.readBy || !msg.readBy.includes(agentId))) {
            messagesToUpdate.push(index);
          }
        });
        
        if (messagesToUpdate.length > 0) {
          const updatePromises = messagesToUpdate.map(async (index) => {
            await conversationsCollection.updateOne(
              { whatsapp, [`messages.${index}.sender`]: "user" },
              { 
                $addToSet: { [`messages.${index}.readBy`]: agentId },
                $set: { [`messages.${index}.read`]: true }
              }
            );
          });
          
          await Promise.all(updatePromises);
          
          // Refresh conversation after updates
          const updatedConversation = await conversationsCollection.findOne({ whatsapp });
          if (updatedConversation) {
            socket.emit("message_history", updatedConversation.messages);
          } else {
            socket.emit("message_history", conversation.messages);
          }
        } else {
          socket.emit("message_history", conversation.messages);
        }
      } else {
        socket.emit("message_history", conversation.messages);
      }
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
      
      const conversations = await conversationsCollection.find({ archived: { $ne: true } }).toArray();
      const usersList = conversations.map(c => ({
        whatsapp: c.whatsapp,
        lastMessage: c.lastMessage,
        lastMessageTime: c.lastUpdated,
        messageCount: c.messages?.length || 0,
        archived: c.archived || false
      }));
      
      socket.emit("existing_users", usersList);
    } catch (error) {
      console.error("Error fetching existing users:", error);
      socket.emit("existing_users", []);
    }
  });

  // ===== NEW: Delete entire chat =====
  socket.on("delete_chat", async ({ whatsapp, archiveOnly = false }) => {
    try {
      const userData = users.get(socket.id);
      
      // Only super_admin and admin can delete chats
      if (!userData || (userData.type !== 'super_admin' && userData.type !== 'admin')) {
        socket.emit("delete_chat_response", { 
          success: false, 
          message: "Unauthorized: Only admins can delete chats" 
        });
        return;
      }
      
      let success;
      if (archiveOnly) {
        success = await archiveChat(whatsapp);
      } else {
        success = await deleteChatFromDB(whatsapp);
      }
      
      if (success) {
        socket.emit("delete_chat_response", { 
          success: true, 
          message: archiveOnly ? "Chat archived successfully" : "Chat deleted permanently" 
        });
        
        logActivity('chat_deletion', {
          whatsapp,
          by: userData.type === 'agent' ? userData.agentId : userData.type,
          archiveOnly,
          permanent: !archiveOnly
        });
      } else {
        socket.emit("delete_chat_response", { 
          success: false, 
          message: "Chat not found" 
        });
      }
    } catch (error) {
      console.error("Error deleting chat:", error);
      socket.emit("delete_chat_response", { 
        success: false, 
        message: "Database error" 
      });
    }
  });

  // Delete individual message
  socket.on("delete_message", async ({ whatsapp, messageId, deleteForAll = false }) => {
    try {
      const userData = users.get(socket.id);
      if (!userData) {
        socket.emit("delete_message_response", { success: false, message: "User not authenticated" });
        return;
      }
      
      if (!conversationsCollection) {
        socket.emit("delete_message_response", { success: false, message: "Database not connected" });
        return;
      }
      
      let updateOperation;
      
      if (deleteForAll || userData.type === 'super_admin' || userData.type === 'admin') {
        // Super admin or admin can delete any message for everyone
        updateOperation = { $pull: { messages: { id: messageId } } };
      } else if (userData.type === 'agent') {
        // Agents can only delete their own messages
        updateOperation = { 
          $pull: { 
            messages: { 
              id: messageId,
              sender: "agent",
              agentId: userData.agentId
            } 
          } 
        };
      } else {
        socket.emit("delete_message_response", { success: false, message: "Unauthorized" });
        return;
      }
      
      const result = await conversationsCollection.updateOne(
        { whatsapp },
        updateOperation
      );
      
      if (result.modifiedCount > 0) {
        // Notify all connected clients about the deletion
        io.to(whatsapp).emit("message_deleted", { whatsapp, messageId });
        io.to("super_admin").to("admin").emit("message_deleted", { whatsapp, messageId });
        
        // Notify all agents
        agents.forEach((agent, agentId) => {
          if (agent.socketId) {
            io.to(agent.socketId).emit("message_deleted", { whatsapp, messageId });
          }
        });
        
        socket.emit("delete_message_response", { success: true });
        
        logActivity('message_deleted', { 
          whatsapp, 
          messageId, 
          by: userData.type === 'agent' ? userData.agentId : userData.type,
          deleteForAll 
        });
      } else {
        socket.emit("delete_message_response", { success: false, message: "Message not found or unauthorized" });
      }
    } catch (error) {
      console.error("Error deleting message:", error);
      socket.emit("delete_message_response", { success: false, message: "Database error" });
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

  // ===== NEW: Get chat statistics =====
  socket.on("get_chat_stats", async () => {
    try {
      const userData = users.get(socket.id);
      if (!userData || (userData.type !== 'super_admin' && userData.type !== 'admin')) {
        return;
      }
      
      if (!conversationsCollection) {
        socket.emit("chat_stats", { error: "Database not connected" });
        return;
      }
      
      const totalChats = await conversationsCollection.countDocuments({ archived: { $ne: true } });
      const archivedChats = await conversationsCollection.countDocuments({ archived: true });
      const totalMessages = await conversationsCollection.aggregate([
        { $match: { archived: { $ne: true } } },
        { $project: { messageCount: { $size: "$messages" } } },
        { $group: { _id: null, total: { $sum: "$messageCount" } } }
      ]).toArray();
      
      const chatsByMessageCount = await conversationsCollection.aggregate([
        { $match: { archived: { $ne: true } } },
        { $project: { messageCount: { $size: "$messages" } } },
        { $group: { 
          _id: { 
            $cond: [
              { $lt: ["$messageCount", MIN_MESSAGES_FOR_PERSISTENCE] },
              "below_threshold",
              "above_threshold"
            ]
          }, 
          count: { $sum: 1 } 
        }}
      ]).toArray();
      
      socket.emit("chat_stats", {
        totalChats,
        archivedChats,
        totalMessages: totalMessages[0]?.total || 0,
        minMessagesForPersistence: MIN_MESSAGES_FOR_PERSISTENCE,
        chatsByMessageCount: chatsByMessageCount.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {}),
        autoCleanupDays: AUTO_CLEANUP_DAYS
      });
    } catch (error) {
      console.error("Error getting chat stats:", error);
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
      console.log(`   /agent/conversations - Get all conversations`);
      console.log(`   DELETE /chat/:whatsapp - Delete a chat`);
      console.log(`   GET /chats/archived - Get archived chats`);
      console.log(`   POST /chat/:whatsapp/restore - Restore archived chat`);
      console.log(`📂 Uploads directory: ${UPLOADS_DIR}`);
      console.log(`🔍 Test MongoDB: http://localhost:${PORT}/test-mongo`);
      console.log(`\n✅ System is ready with ALL functionality!`);
      console.log(`🔧 Permanent Agent System: Agents auto-register via agentX.html files`);
      console.log(`🔍 NEW FEATURES IMPLEMENTED:`);
      console.log(`   • ALL messages saved to MongoDB under WhatsApp numbers`);
      console.log(`   • Chat persistence across sessions`);
      console.log(`   • Only save chats with ≥ ${MIN_MESSAGES_FOR_PERSISTENCE} messages`);
      console.log(`   • Auto-delete old chats (< ${MIN_MESSAGES_FOR_PERSISTENCE} messages, > ${AUTO_CLEANUP_DAYS} days)`);
      console.log(`   • Delete chat option for admins`);
      console.log(`   • Archive chat option (soft delete)`);
      console.log(`   • ALL agents see ALL messages in real-time`);
      console.log(`   • Broadcast messages to all agents automatically`);
      console.log(`   • Agents get chat history when they login`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();