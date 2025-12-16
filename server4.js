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
const agents = new Map();         // agentId -> { name, password, restrictions, isOnline, socketId, lastSeen, filename }
const userAssignments = new Map(); // whatsapp -> agentId
const agentUsers = new Map();     // agentId -> Set(whatsapp)
const activeChats = new Map();    // whatsapp -> { lastMessage, lastMessageTime, messageCount, agentId, unread }
const activityLog = [];           // Array of activity events

// ---- MongoDB Collections ----
let db;
let conversationsCollection;
let agentsCollection; // NEW: For storing agent credentials

// ---- Helper Functions ----

// Get list of existing agent files
function getExistingAgentFiles() {
  const files = [];
  const publicDir = path.join(__dirname, "public");
  
  if (fs.existsSync(publicDir)) {
    const allFiles = fs.readdirSync(publicDir);
    const agentFiles = allFiles.filter(file => 
      file.startsWith('agent') && file.endsWith('.html')
    );
    files.push(...agentFiles);
  }
  
  // Also check root directory
  const rootFiles = fs.readdirSync(__dirname);
  const rootAgentFiles = rootFiles.filter(file => 
    file.startsWith('agent') && file.endsWith('.html')
  );
  files.push(...rootAgentFiles.filter(f => !files.includes(f)));
  
  return [...new Set(files)]; // Remove duplicates
}

// Check if agent file already has credentials
function getAgentByFilename(filename) {
  return Array.from(agents.entries()).find(([id, agent]) => 
    agent.filename === filename
  );
}

// Generate unique agent ID
function generateAgentId() {
  return 'agent_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

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

// ---- MongoDB Helper Functions ----

async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    conversationsCollection = db.collection("conversations");
    agentsCollection = db.collection("agents"); // NEW: For storing agents
    
    // Create indexes for better performance
    await conversationsCollection.createIndex({ whatsapp: 1 });
    await conversationsCollection.createIndex({ "messages.timestamp": 1 });
    await conversationsCollection.createIndex({ whatsapp: 1, "messages.timestamp": 1 });
    await conversationsCollection.createIndex({ "messages.read": 1 });
    
    // Index for agents collection
    await agentsCollection.createIndex({ name: 1 }, { unique: true });
    await agentsCollection.createIndex({ filename: 1 }, { unique: true, sparse: true });
    
    console.log("✓ Connected to MongoDB");
    return true;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    // Don't crash the server, just log the error
    return false;
  }
}

// Load agents from MongoDB on startup
async function loadAgentsFromDB() {
  try {
    if (!agentsCollection) return;
    
    const agentsFromDB = await agentsCollection.find({}).toArray();
    
    agentsFromDB.forEach(agentDoc => {
      const agentId = agentDoc._id.toString();
      agents.set(agentId, {
        ...agentDoc,
        isOnline: false,
        socketId: null,
        lastSeen: null
      });
      
      // Initialize agent users set
      if (!agentUsers.has(agentId)) {
        agentUsers.set(agentId, new Set());
      }
      
      console.log(`✓ Loaded agent from DB: ${agentDoc.name} (${agentDoc.filename || 'no file'})`);
    });
    
    // Load user assignments
    if (conversationsCollection) {
      const conversations = await conversationsCollection.find({}).toArray();
      conversations.forEach(conv => {
        if (conv.assignedAgent) {
          userAssignments.set(conv.whatsapp, conv.assignedAgent);
          const userSet = agentUsers.get(conv.assignedAgent);
          if (userSet) {
            userSet.add(conv.whatsapp);
          }
        }
      });
    }
    
  } catch (error) {
    console.error("Error loading agents from DB:", error);
  }
}

async function saveAgentToDB(agentId, agentData) {
  try {
    if (!agentsCollection) return false;
    
    await agentsCollection.updateOne(
      { _id: agentId },
      { $set: { ...agentData, updatedAt: new Date() } },
      { upsert: true }
    );
    return true;
  } catch (error) {
    console.error("Error saving agent to DB:", error);
    return false;
  }
}

async function deleteAgentFromDB(agentId) {
  try {
    if (!agentsCollection) return false;
    
    await agentsCollection.deleteOne({ _id: agentId });
    return true;
  } catch (error) {
    console.error("Error deleting agent from DB:", error);
    return false;
  }
}

async function saveMessageToMongoDB(whatsapp, message) {
  try {
    if (!conversationsCollection) {
      console.error("MongoDB not connected, message not saved");
      return false;
    }
    
    // Add read status for user messages (default: unread)
    if (message.sender === "user") {
      message.read = false;
    } else {
      message.read = true; // Agent/admin messages are auto-read
      message.readBy = message.sender;
      message.readAt = new Date();
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
          $set: { 
            lastUpdated: new Date(),
            lastMessage: message.text,
            lastMessageTime: message.timestamp
          }
        }
      );
    } else {
      // Create new conversation document
      await conversationsCollection.insertOne({
        whatsapp,
        messages: [message],
        createdAt: new Date(),
        lastUpdated: new Date(),
        lastMessage: message.text,
        lastMessageTime: message.timestamp,
        messageCount: 1,
        unreadCount: message.sender === 'user' && !message.read ? 1 : 0
      });
    }
    
    // Update active chats tracking
    updateActiveChat(whatsapp, message);
    
    return true;
  } catch (error) {
    console.error("Error saving message to MongoDB:", error);
    return false;
  }
}

function updateActiveChat(whatsapp, message) {
  let chat = activeChats.get(whatsapp);
  
  if (!chat) {
    chat = {
      whatsapp,
      agentId: message.assignedAgent || userAssignments.get(whatsapp),
      sender: message.sender,
      lastMessage: message.text,
      lastMessageTime: message.timestamp,
      messageCount: 1,
      unread: message.sender === 'user' && !message.read ? 1 : 0
    };
    activeChats.set(whatsapp, chat);
  } else {
    chat.lastMessage = message.text;
    chat.lastMessageTime = message.timestamp;
    chat.messageCount = (chat.messageCount || 0) + 1;
    if (message.sender === 'user' && !message.read) {
      chat.unread = (chat.unread || 0) + 1;
    }
    chat.agentId = message.assignedAgent || userAssignments.get(whatsapp) || chat.agentId;
  }
}

async function markMessagesAsRead(whatsapp, readerType, readerId = null) {
  try {
    if (!conversationsCollection) return false;
    
    const query = { whatsapp };
    const update = {
      $set: {
        "messages.$[elem].read": true,
        "messages.$[elem].readBy": readerType,
        "messages.$[elem].readAt": new Date(),
        ...(readerId && { "messages.$[elem].readerId": readerId })
      }
    };
    
    const options = {
      arrayFilters: [
        { 
          "elem.sender": "user",
          "elem.read": { $ne: true }
        }
      ]
    };
    
    await conversationsCollection.updateOne(query, update, options);
    
    // Update unread count in conversation document
    await conversationsCollection.updateOne(
      { whatsapp },
      { $set: { unreadCount: 0 } }
    );
    
    // Update active chat
    const chat = activeChats.get(whatsapp);
    if (chat) {
      chat.unread = 0;
    }
    
    return true;
  } catch (error) {
    console.error("Error marking messages as read:", error);
    return false;
  }
}

async function getMessagesFromMongoDB(whatsapp, agentId = null, markAsRead = false) {
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
    
    // Mark messages as read if requested
    if (markAsRead && agentId) {
      await markMessagesAsRead(whatsapp, 'agent', agentId);
    } else if (markAsRead) {
      await markMessagesAsRead(whatsapp, 'admin');
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
      { 
        $set: { 
          messages: [], 
          lastUpdated: new Date(),
          lastMessage: null,
          lastMessageTime: null,
          messageCount: 0,
          unreadCount: 0
        } 
      }
    );
    
    // Remove from active chats
    activeChats.delete(whatsapp);
    
    return true;
  } catch (error) {
    console.error("Error clearing chat in MongoDB:", error);
    return false;
  }
}

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

// Serve agent files
app.get("/agent:num.html", (req, res) => {
  const filename = `agent${req.params.num}.html`;
  const filePath = path.join(__dirname, filename);
  
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Agent file not found");
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
          assignedAgent: userAssignments.get(conv.whatsapp) || conv.assignedAgent,
          messageCount: conv.messageCount || conv.messages?.length || 0,
          lastMessage: conv.lastMessageTime || conv.messages?.[conv.messages.length - 1]?.timestamp,
          unread: conv.unreadCount || conv.messages?.filter(m => m.sender === 'user' && !m.read)?.length || 0
        }));
        
        const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
          id,
          name: agent.name,
          filename: agent.filename,
          isOnline: agent.isOnline,
          socketId: agent.socketId,
          lastSeen: agent.lastSeen,
          restrictions: agent.restrictions || {},
          userCount: agentUsers.get(id) ? agentUsers.get(id).size : 0
        }));
        
        // Get active chats
        const activeChatsList = Array.from(activeChats.values());
        
        socket.emit("super_admin_data", {
          agents: agentsList,
          users: allUsers,
          activeChats: activeChatsList,
          activity: activityLog.slice(-100),
          agentFiles: getExistingAgentFiles(),
          stats: {
            totalAgents: agents.size,
            onlineAgents: Array.from(agents.values()).filter(a => a.isOnline).length,
            totalUsers: conversationsFromDB.length,
            activeChats: activeChatsList.length,
            mutedAgents: Array.from(agents.values()).filter(a => a.restrictions?.muted === true).length
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

  // Get agent files list
  socket.on("get_agent_files", () => {
    const userData = users.get(socket.id);
    if (userData?.type === 'super_admin') {
      socket.emit("agent_files_list", getExistingAgentFiles());
    }
  });

  // Check agent file info
  socket.on("check_agent_file", ({ filename }) => {
    const userData = users.get(socket.id);
    if (userData?.type === 'super_admin') {
      const agentEntry = getAgentByFilename(filename);
      
      if (agentEntry) {
        const [agentId, agent] = agentEntry;
        socket.emit("agent_file_info", {
          id: agentId,
          name: agent.name,
          filename: agent.filename,
          isOnline: agent.isOnline,
          userCount: agentUsers.get(agentId) ? agentUsers.get(agentId).size : 0,
          lastActive: agent.lastSeen
        });
      } else {
        socket.emit("agent_file_info", null);
      }
    }
  });

  // Set agent credentials for existing file
  socket.on("set_agent_credentials", async ({ filename, username, password, restrictions }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    // Check if file exists
    const existingFiles = getExistingAgentFiles();
    if (!existingFiles.includes(filename)) {
      socket.emit("agent_credentials_response", {
        success: false,
        message: `Agent file ${filename} not found`
      });
      return;
    }
    
    // Check if username already exists
    const existingAgentByName = Array.from(agents.values()).find(a => a.name === username);
    if (existingAgentByName) {
      socket.emit("agent_credentials_response", {
        success: false,
        message: "Agent username already exists"
      });
      return;
    }
    
    // Check if file already has credentials
    const existingAgentByFile = getAgentByFilename(filename);
    
    if (existingAgentByFile) {
      // Update existing agent
      const [agentId, agent] = existingAgentByFile;
      agent.name = username;
      agent.password = password;
      agent.restrictions = restrictions || {};
      agent.filename = filename;
      
      // Save to MongoDB
      await saveAgentToDB(agentId, {
        name: username,
        password: password,
        restrictions: restrictions || {},
        filename: filename,
        updatedAt: new Date()
      });
      
      // Update online agent if connected
      if (agent.isOnline && agent.socketId) {
        io.to(agent.socketId).emit("agent_restrictions_updated", restrictions);
        io.to(agent.socketId).emit("agent_info_updated", { name: username });
      }
      
      logActivity('agent_updated', { agentId, agentName: username, by: socket.id });
      
      io.to("super_admin").emit("agent_updated", {
        id: agentId,
        name: username,
        filename: filename,
        restrictions: restrictions || {},
        isOnline: agent.isOnline,
        userCount: agentUsers.get(agentId) ? agentUsers.get(agentId).size : 0
      });
      
    } else {
      // Create new agent for this file
      const agentId = generateAgentId();
      agents.set(agentId, {
        name: username,
        password,
        restrictions: restrictions || {},
        filename: filename,
        isOnline: false,
        socketId: null,
        lastSeen: null
      });
      
      agentUsers.set(agentId, new Set());
      
      // Save to MongoDB
      await saveAgentToDB(agentId, {
        name: username,
        password: password,
        restrictions: restrictions || {},
        filename: filename,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      
      logActivity('agent_created', { agentId, agentName: username, filename, by: socket.id });
    }
    
    socket.emit("agent_credentials_set", {
      success: true,
      agentName: username,
      filename: filename
    });
    
    io.to("super_admin").emit("agent_credentials_set", {
      name: username,
      filename: filename,
      restrictions: restrictions || {}
    });
  });

  // Update agent permissions
  socket.on("update_agent_permissions", async ({ agentId, password, restrictions }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    const agent = agents.get(agentId);
    if (!agent) {
      socket.emit("agent_update_response", {
        success: false,
        message: "Agent not found"
      });
      return;
    }
    
    // Update agent data
    if (password) agent.password = password;
    if (restrictions) {
      agent.restrictions = { ...agent.restrictions, ...restrictions };
      
      // If agent is being muted, disconnect them
      if (restrictions.muted === true && agent.socketId) {
        io.to(agent.socketId).emit("agent_disconnected", { reason: "muted" });
        io.sockets.sockets.get(agent.socketId)?.disconnect();
        agent.isOnline = false;
        agent.socketId = null;
      }
    }
    
    // Save to MongoDB
    await saveAgentToDB(agentId, {
      name: agent.name,
      password: agent.password,
      restrictions: agent.restrictions,
      filename: agent.filename,
      updatedAt: new Date()
    });
    
    // Notify agent if online (except if muted)
    if (agent.socketId && !agent.restrictions?.muted) {
      io.to(agent.socketId).emit("agent_restrictions_updated", agent.restrictions);
    }
    
    logActivity('agent_permissions_updated', { 
      agentId, 
      agentName: agent.name, 
      by: socket.id,
      restrictions: agent.restrictions 
    });
    
    io.to("super_admin").emit("agent_updated", {
      id: agentId,
      name: agent.name,
      filename: agent.filename,
      restrictions: agent.restrictions,
      isOnline: agent.isOnline,
      userCount: agentUsers.get(agentId) ? agentUsers.get(agentId).size : 0
    });
    
    socket.emit("agent_update_response", { success: true });
  });

  // Mute/Unmute agent
  socket.on("mute_agent", async ({ agentId }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    const agent = agents.get(agentId);
    if (!agent) return;
    
    // Set mute restriction
    if (!agent.restrictions) agent.restrictions = {};
    agent.restrictions.muted = true;
    
    // Save to MongoDB
    await saveAgentToDB(agentId, {
      restrictions: agent.restrictions,
      updatedAt: new Date()
    });
    
    // Disconnect agent if online
    if (agent.socketId) {
      io.to(agent.socketId).emit("agent_disconnected", { reason: "muted" });
      io.sockets.sockets.get(agent.socketId)?.disconnect();
      agent.isOnline = false;
      agent.socketId = null;
    }
    
    logActivity('agent_muted', { agentId, agentName: agent.name, by: socket.id });
    
    io.to("super_admin").emit("agent_muted", {
      agentId,
      agentName: agent.name
    });
    
    io.to("super_admin").emit("agent_status_change", {
      agentId,
      isOnline: false,
      socketId: null
    });
  });

  socket.on("unmute_agent", async ({ agentId }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    const agent = agents.get(agentId);
    if (!agent) return;
    
    // Remove mute restriction
    if (agent.restrictions) {
      agent.restrictions.muted = false;
    }
    
    // Save to MongoDB
    await saveAgentToDB(agentId, {
      restrictions: agent.restrictions,
      updatedAt: new Date()
    });
    
    logActivity('agent_unmuted', { agentId, agentName: agent.name, by: socket.id });
    
    io.to("super_admin").emit("agent_unmuted", {
      agentId,
      agentName: agent.name
    });
  });

  // Disconnect agent (for muting)
  socket.on("disconnect_agent", ({ agentId, socketId }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    const agent = agents.get(agentId);
    if (agent && agent.socketId === socketId) {
      io.to(socketId).emit("agent_disconnected", { reason: "admin_action" });
      io.sockets.sockets.get(socketId)?.disconnect();
      agent.isOnline = false;
      agent.socketId = null;
      
      io.to("super_admin").emit("agent_status_change", {
        agentId,
        isOnline: false,
        socketId: null
      });
    }
  });

  // Get super admin data
  socket.on("get_super_admin_data", async () => {
    const userData = users.get(socket.id);
    if (userData?.type === 'super_admin') {
      try {
        const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
          id,
          name: agent.name,
          filename: agent.filename,
          isOnline: agent.isOnline,
          socketId: agent.socketId,
          lastSeen: agent.lastSeen,
          restrictions: agent.restrictions || {},
          userCount: agentUsers.get(id) ? agentUsers.get(id).size : 0
        }));
        
        const activeChatsList = Array.from(activeChats.values());
        
        socket.emit("super_admin_data", {
          agents: agentsList,
          activeChats: activeChatsList,
          activity: activityLog.slice(-100),
          stats: {
            totalAgents: agents.size,
            onlineAgents: Array.from(agents.values()).filter(a => a.isOnline).length,
            activeChats: activeChatsList.length,
            mutedAgents: Array.from(agents.values()).filter(a => a.restrictions?.muted === true).length
          }
        });
      } catch (error) {
        console.error("Error getting super admin data:", error);
      }
    }
  });

  // Assign user to agent
  socket.on("assign_user", async ({ whatsapp, agentId, forceReassign = false }) => {
    const userData = users.get(socket.id);
    const isSuperAdmin = userData?.type === 'super_admin';
    const isAgent = userData?.type === 'agent';
    
    if (!isSuperAdmin && !isAgent) return;
    
    // If agent is trying to self-assign, check if allowed
    if (isAgent && !forceReassign) {
      const agent = agents.get(userData.agentId);
      if (agent?.restrictions?.canAssign === false) {
        socket.emit("user_assignment_response", {
          success: false,
          message: "You are not allowed to assign users to yourself"
        });
        return;
      }
    }
    
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
      
      // Update in MongoDB
      if (conversationsCollection) {
        await conversationsCollection.updateOne(
          { whatsapp },
          { $set: { assignedAgent: null } }
        );
      }
      
      // Update active chat
      const chat = activeChats.get(whatsapp);
      if (chat) {
        chat.agentId = null;
      }
      
      logActivity('user_unassigned', { whatsapp, by: socket.id });
      
      if (isSuperAdmin) {
        socket.emit("user_assignment_response", { success: true });
      }
      return;
    }
    
    const agent = agents.get(agentId);
    if (!agent) {
      socket.emit("user_assignment_response", {
        success: false,
        message: "Agent not found"
      });
      return;
    }
    
    // Check if agent is muted
    if (agent.restrictions?.muted === true) {
      socket.emit("user_assignment_response", {
        success: false,
        message: "Cannot assign to muted agent"
      });
      return;
    }
    
    // Check agent's user limit restriction
    const userSet = agentUsers.get(agentId);
    if (agent.restrictions?.maxUsers && userSet && userSet.size >= agent.restrictions.maxUsers) {
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
    
    // Update in MongoDB
    if (conversationsCollection) {
      await conversationsCollection.updateOne(
        { whatsapp },
        { $set: { assignedAgent: agentId } }
      );
    }
    
    // Update active chat
    const chat = activeChats.get(whatsapp);
    if (chat) {
      chat.agentId = agentId;
    }
    
    // Notify the agent
    if (agent.socketId) {
      io.to(agent.socketId).emit("user_assigned", { whatsapp, agentId });
      
      // Send any unread messages to agent
      if (conversationsCollection) {
        const conversation = await conversationsCollection.findOne({ whatsapp });
        if (conversation?.messages) {
          const unreadMessages = conversation.messages.filter(m => 
            m.sender === 'user' && !m.read
          );
          unreadMessages.forEach(msg => {
            io.to(agent.socketId).emit("new_message", msg);
          });
        }
      }
    }
    
    logActivity('user_assigned', { 
      whatsapp, 
      agentId, 
      agentName: agent.name, 
      by: socket.id 
    });
    
    if (isSuperAdmin) {
      socket.emit("user_assignment_response", { success: true });
      io.to("super_admin").emit("user_assigned", {
        whatsapp,
        agentId,
        agentName: agent.name
      });
    }
  });

  // ===== AGENT CONNECTION =====
  socket.on("agent_login", async ({ agentName, password, socketId }) => {
    // Find agent by name and password
    const agentEntry = Array.from(agents.entries()).find(([id, agent]) => 
      agent.name === agentName && agent.password === password
    );
    
    if (agentEntry) {
      const [agentId, agent] = agentEntry;
      
      // Check if agent is muted
      if (agent.restrictions?.muted === true) {
        socket.emit("agent_login_response", {
          success: false,
          message: "Agent account is muted. Contact super admin."
        });
        return;
      }
      
      // Update agent status
      agent.isOnline = true;
      agent.socketId = socket.id;
      agent.lastSeen = new Date().toISOString();
      
      users.set(socket.id, { type: 'agent', agentId });
      socket.join(`agent_${agentId}`);
      
      logActivity('agent_login', { agentId, agentName, socketId: socket.id });
      console.log(`✓ Agent logged in: ${agentName} (${agentId})`);
      
      // Get assigned users
      const assignedUsers = Array.from(agentUsers.get(agentId) || []);
      
      // Get unread messages for assigned users
      const unreadMessages = [];
      if (conversationsCollection) {
        for (const whatsapp of assignedUsers) {
          const conversation = await conversationsCollection.findOne({ whatsapp });
          if (conversation?.messages) {
            const userUnread = conversation.messages.filter(m => 
              m.sender === 'user' && !m.read
            );
            unreadMessages.push(...userUnread.map(msg => ({
              ...msg,
              whatsapp
            })));
          }
        }
      }
      
      socket.emit("agent_login_response", {
        success: true,
        agentId,
        restrictions: agent.restrictions || {},
        assignedUsers,
        unreadMessages
      });
      
      // Notify super admins
      io.to("super_admin").emit("agent_status_change", {
        agentId,
        agentName,
        isOnline: true,
        socketId: socket.id
      });
      
      // Send agent active chat updates
      const agentActiveChats = Array.from(activeChats.values())
        .filter(chat => chat.agentId === agentId);
      agentActiveChats.forEach(chat => {
        socket.emit("agent_active_chat_update", chat);
      });
      
    } else {
      socket.emit("agent_login_response", {
        success: false,
        message: "Invalid agent name or password"
      });
    }
  });

  // Agent online status
  socket.on("agent_online", ({ agentId, agentName, restrictions, socketId }) => {
    const agent = agents.get(agentId);
    if (agent) {
      // Check if agent is muted
      if (agent.restrictions?.muted === true) {
        socket.emit("agent_disconnected", { reason: "muted" });
        socket.disconnect();
        return;
      }
      
      agent.isOnline = true;
      agent.socketId = socket.id;
      agent.lastSeen = new Date().toISOString();
      
      users.set(socket.id, { type: 'agent', agentId });
      socket.join(`agent_${agentId}`);
      
      // Send assigned users
      const assignedUsers = Array.from(agentUsers.get(agentId) || []);
      socket.emit("assigned_users", assignedUsers);
      
      // Notify super admins
      io.to("super_admin").emit("agent_status_change", {
        agentId,
        agentName,
        isOnline: true,
        socketId: socket.id
      });
      
      logActivity('agent_online', { agentId, agentName, socketId: socket.id });
    }
  });

  // Agent heartbeat
  socket.on("agent_heartbeat", ({ agentId }) => {
    const agent = agents.get(agentId);
    if (agent) {
      agent.lastSeen = new Date().toISOString();
    }
  });

  // Agent goes offline
  socket.on("agent_offline", ({ agentId }) => {
    const agent = agents.get(agentId);
    if (agent) {
      agent.isOnline = false;
      agent.lastSeen = new Date().toISOString();
      
      io.to("super_admin").emit("agent_status_change", {
        agentId,
        agentName: agent.name,
        isOnline: false,
        socketId: null
      });
      
      logActivity('agent_offline', { agentId, agentName: agent.name });
    }
  });

  // Agent received message (for tracking)
  socket.on("agent_received_message", (data) => {
    const userData = users.get(socket.id);
    if (userData?.type === 'agent') {
      io.to("super_admin").emit("agent_received_message", {
        ...data,
        agentId: userData.agentId
      });
      
      // Update active chat
      updateActiveChat(data.whatsapp, {
        sender: 'user',
        text: data.message,
        timestamp: data.timestamp,
        assignedAgent: userData.agentId,
        read: false
      });
    }
  });

  // Agent sent message (for tracking)
  socket.on("agent_sent_message", (data) => {
    const userData = users.get(socket.id);
    if (userData?.type === 'agent') {
      io.to("super_admin").emit("agent_sent_message", {
        ...data,
        agentId: userData.agentId
      });
    }
  });

  // Agent active chat (for tracking)
  socket.on("agent_active_chat", (data) => {
    const userData = users.get(socket.id);
    if (userData?.type === 'agent') {
      io.to("super_admin").emit("agent_active_chat", {
        ...data,
        agentId: userData.agentId
      });
    }
  });

  // Get assigned users
  socket.on("get_assigned_users", ({ agentId }) => {
    const userData = users.get(socket.id);
    if (userData?.type === 'agent' && userData.agentId === agentId) {
      const assignedUsers = Array.from(agentUsers.get(agentId) || []);
      socket.emit("assigned_users", assignedUsers);
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
      agentName,
      read: sender === 'agent' || sender === 'admin' // Agent/admin messages are auto-read
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
        
        // Check if agent is muted
        if (agent?.restrictions?.muted === true) {
          // Agent is muted, notify super admin only
          io.to("super_admin").emit("new_message", { 
            ...message, 
            assignedAgentId, 
            agentMuted: true 
          });
        } else if (agent?.socketId) {
          // Agent is online and not muted
          io.to(agent.socketId).emit("new_message", message);
          io.to("super_admin").emit("new_message", { ...message, assignedAgentId });
        } else {
          // Agent offline
          io.to("super_admin").emit("new_message", { ...message, assignedAgentId, agentOffline: true });
        }
      } else {
        // Not assigned - notify super admins
        io.to("super_admin").emit("new_message", { ...message, unassigned: true });
      }
      
      // Also send to regular admin
      io.to("admin").emit("new_message", message);
      
    } else if (message.sender === "agent") {
      // Agent sent message - also send to super admins for monitoring
      io.to("super_admin").emit("new_message", message);
      
      // Also send to regular admin
      io.to("admin").emit("new_message", message);
    } else {
      // Regular user message or admin message
      io.to("admin").emit("new_message", message);
    }
  });

  // Get messages
  socket.on("get_messages", async ({ whatsapp, agentId, markAsRead = false }) => {
    const userData = users.get(socket.id);
    
    // For agents, check if they're assigned to this user
    if (agentId) {
      const assignedAgentId = userAssignments.get(whatsapp);
      if (assignedAgentId !== agentId) {
        socket.emit("message_history", []);
        return;
      }
    }
    
    const messages = await getMessagesFromMongoDB(whatsapp, agentId, markAsRead);
    socket.emit("message_history", messages);
  });

  // Mark messages as read
  socket.on("mark_messages_read", async ({ whatsapp, agentId }) => {
    if (agentId) {
      await markMessagesAsRead(whatsapp, 'agent', agentId);
      
      // Notify super admin
      const agent = agents.get(agentId);
      if (agent) {
        io.to("super_admin").emit("messages_marked_read", {
          whatsapp,
          agentId,
          agentName: agent.name
        });
      }
    } else {
      await markMessagesAsRead(whatsapp, 'admin');
    }
  });

  // Clear chat
  socket.on("clear_chat", async ({ whatsapp, agentId, agentName }) => {
    const userData = users.get(socket.id);
    const agent = agents.get(agentId);
    
    // Check if agent can clear chats
    if (agent && agent.restrictions?.canClear === false) {
      socket.emit("clear_chat_response", { 
        success: false, 
        message: "You are not allowed to clear chats" 
      });
      return;
    }
    
    if (conversationsCollection) {
      const cleared = await clearChatInMongoDB(whatsapp);
      if (cleared) {
        logActivity('chat_cleared', { 
          whatsapp, 
          by: agentId ? `agent:${agentName}` : 'admin' 
        });
        
        socket.emit("clear_chat_response", { success: true });
        
        // Notify all parties
        io.to(whatsapp).emit("chat_cleared", { whatsapp });
        if (agentId && agent?.socketId) {
          io.to(agent.socketId).emit("chat_cleared", { whatsapp });
        }
        
        // Notify super admin
        io.to("super_admin").emit("chat_cleared", { 
          whatsapp, 
          clearedBy: agentId ? agentName : 'admin' 
        });
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
          agent.socketId = null;
          agent.lastSeen = new Date().toISOString();
          
          io.to("super_admin").emit("agent_status_change", {
            agentId: user.agentId,
            agentName: agent.name,
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
      
      // Load agents from database on startup
      await loadAgentsFromDB();
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
      console.log(`👤 Agent files found: ${getExistingAgentFiles().join(', ') || 'None'}`);
      console.log(`\n✅ System is ready with complete agent management!`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();