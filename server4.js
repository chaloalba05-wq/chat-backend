const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

// ===== SUPER ADMIN CONFIGURATION =====
const SUPER_ADMIN_PASSWORD = "SUPER.ADMIN";
// =====================================

// ===== BROADCAST ROOM CONFIGURATION =====
const BROADCAST_ROOM = "BROADCAST_ROOM_ALL_AGENTS";
// =========================================

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
  limits: { fileSize: 10 * 1024 * 1024 }
});
// =====================================

// ===== SIMPLE IN-MEMORY STORAGE =====
const users = new Map();           // socketId -> { type, agentId, whatsapp }
const agents = new Map();          // agentId -> { name, password, muted, socketId, filename? }
const conversations = new Map();   // whatsapp -> { messages: [], lastUpdated, createdAt }
const activeChats = new Map();     // whatsapp -> { lastMessage, lastMessageTime }
const activityLog = [];            // Activity log
const broadcastMessages = [];      // All messages in broadcast room
// =====================================

// ===== PRE-REGISTER AGENTS (so they always exist) =====
// This ensures agents are always available even on server restart
function preRegisterDefaultAgents() {
  const defaultAgents = [
    { id: "agent1", name: "Agent 1", password: "agent1", filename: "agent1.html" },
    { id: "agent2", name: "Agent 2", password: "agent2", filename: "agent2.html" },
    { id: "agent3", name: "Agent 3", password: "agent3", filename: "agent3.html" }
  ];
  
  defaultAgents.forEach(agent => {
    if (!agents.has(agent.id)) {
      agents.set(agent.id, {
        name: agent.name,
        password: agent.password,
        muted: false,
        socketId: null,
        filename: agent.filename,
        createdAt: new Date(),
        lastSeen: null,
        permanent: true
      });
      console.log(`✅ Pre-registered agent: ${agent.id} (${agent.name})`);
    }
  });
}
// =====================================================

// ===== SIMPLE HELPER FUNCTIONS =====
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

// ===== SAVE MESSAGE TO BROADCAST ROOM =====
function saveMessageToBroadcastRoom(message) {
  try {
    const broadcastMessage = {
      ...message,
      isBroadcast: true,
      broadcastTimestamp: new Date().toISOString(),
      broadcastId: uuidv4()
    };
    
    broadcastMessages.push(broadcastMessage);
    
    // Keep only last 1000 broadcast messages to prevent memory issues
    if (broadcastMessages.length > 1000) {
      broadcastMessages.shift();
    }
    
    console.log(`📡 Saved to broadcast room: ${broadcastMessage.broadcastId} (Total: ${broadcastMessages.length} broadcast messages)`);
    return broadcastMessage;
  } catch (error) {
    console.error("Error saving to broadcast room:", error);
    return null;
  }
}

// ===== SAVE MESSAGE TO USER'S CHAT HISTORY =====
function saveMessageToUserHistory(whatsapp, message) {
  try {
    if (!conversations.has(whatsapp)) {
      // Create new conversation
      conversations.set(whatsapp, {
        whatsapp: whatsapp,
        messages: [message],
        createdAt: new Date(),
        lastUpdated: new Date(),
        lastMessage: message.text || (message.attachment ? `[${message.attachment.mimetype?.split('/')[0] || 'File'}]` : ''),
        lastMessageTime: message.timestamp,
        archived: false
      });
    } else {
      // Update existing conversation
      const conversation = conversations.get(whatsapp);
      conversation.messages.push(message);
      conversation.lastUpdated = new Date();
      conversation.lastMessage = message.text || (message.attachment ? `[${message.attachment.mimetype?.split('/')[0] || 'File'}]` : '');
      conversation.lastMessageTime = message.timestamp;
    }
    
    console.log(`💾 Saved message for ${whatsapp} (Total: ${conversations.get(whatsapp)?.messages.length} messages)`);
    return true;
  } catch (error) {
    console.error("Error saving message to user history:", error);
    return false;
  }
}

// ===== SEND BROADCAST ROOM MESSAGES TO AGENT =====
function sendBroadcastRoomToAgent(agentSocketId) {
  try {
    // Send all broadcast messages to the agent
    broadcastMessages.forEach(message => {
      io.to(agentSocketId).emit("broadcast_message", {
        ...message,
        isHistorical: true
      });
    });
    
    console.log(`📨 Sent ${broadcastMessages.length} broadcast messages to agent`);
  } catch (error) {
    console.error("Error sending broadcast room to agent:", error);
  }
}

// ===== SEND USER CHAT HISTORY TO AGENT =====
function sendUserChatHistoryToAgent(agentSocketId, whatsapp) {
  try {
    const conversation = conversations.get(whatsapp);
    if (conversation && conversation.messages && conversation.messages.length > 0) {
      // Send each message from this user's history
      conversation.messages.forEach(message => {
        io.to(agentSocketId).emit("user_chat_history", {
          ...message,
          whatsapp: whatsapp,
          isHistorical: true
        });
      });
      
      console.log(`📨 Sent ${conversation.messages.length} messages from ${whatsapp} to agent`);
    }
  } catch (error) {
    console.error(`Error sending ${whatsapp} chat history to agent:`, error);
  }
}

// ===== BROADCAST MESSAGE TO ALL AGENTS =====
function broadcastMessageToAllAgents(messageData, excludeSocketId = null) {
  try {
    // Save to broadcast room first
    const broadcastMessage = saveMessageToBroadcastRoom(messageData);
    
    // Send to all non-muted agents
    agents.forEach((agent, agentId) => {
      if (!agent.muted && agent.socketId && agent.socketId !== excludeSocketId) {
        io.to(agent.socketId).emit("broadcast_message", broadcastMessage);
      }
    });
    
    // Also send to the broadcast room for new connections
    io.to(BROADCAST_ROOM).emit("broadcast_message", broadcastMessage);
    
    return true;
  } catch (error) {
    console.error("Error broadcasting message to agents:", error);
    return false;
  }
}

// ===== SEND MESSAGE TO SPECIFIC USER ROOM =====
function sendMessageToUserRoom(whatsapp, message) {
  try {
    // Save to user's chat history
    saveMessageToUserHistory(whatsapp, message);
    
    // Send to the specific user's room
    io.to(whatsapp).emit("new_message", {
      ...message,
      whatsapp: whatsapp
    });
    
    // Also send to any agents monitoring this user
    agents.forEach((agent, agentId) => {
      if (agent.socketId && agent.monitoringUser === whatsapp) {
        io.to(agent.socketId).emit("user_message_update", {
          ...message,
          whatsapp: whatsapp
        });
      }
    });
    
    console.log(`📤 Sent message to user room: ${whatsapp}`);
    return true;
  } catch (error) {
    console.error(`Error sending message to user room ${whatsapp}:`, error);
    return false;
  }
}

// ===== DELETE CHAT =====
function deleteChat(whatsapp) {
  if (conversations.delete(whatsapp)) {
    activeChats.delete(whatsapp);
    io.emit("chat_deleted", { whatsapp });
    logActivity('chat_deleted', { whatsapp });
    console.log(`🗑️  Deleted chat: ${whatsapp}`);
    return true;
  }
  return false;
}

// ===== ARCHIVE CHAT =====
function archiveChat(whatsapp) {
  const conversation = conversations.get(whatsapp);
  if (conversation) {
    conversation.archived = true;
    conversation.archivedAt = new Date();
    io.emit("chat_archived", { whatsapp });
    logActivity('chat_archived', { whatsapp });
    console.log(`📁 Archived chat: ${whatsapp}`);
    return true;
  }
  return false;
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
app.get("/", (req, res) => res.send("Chat backend running - IN-MEMORY MODE"));
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
app.get("/agent/conversations", (req, res) => {
  try {
    const conversationsList = Array.from(conversations.values())
      .filter(conv => !conv.archived)
      .map(conv => ({
        whatsapp: conv.whatsapp,
        lastMessage: conv.lastMessage,
        lastMessageTime: conv.lastUpdated,
        createdAt: conv.createdAt,
        lastUpdated: conv.lastUpdated,
        messageCount: conv.messages?.length || 0
      }))
      .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
    
    res.json({ success: true, conversations: conversationsList });
  } catch (error) {
    console.error("Error fetching conversations:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Delete chat route
app.delete("/chat/:whatsapp", (req, res) => {
  try {
    const { whatsapp } = req.params;
    const { archive } = req.query;
    
    let success;
    if (archive === 'true') {
      success = archiveChat(whatsapp);
    } else {
      success = deleteChat(whatsapp);
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

// Get archived chats
app.get("/chats/archived", (req, res) => {
  try {
    const archivedChats = Array.from(conversations.values())
      .filter(conv => conv.archived)
      .map(conv => ({
        whatsapp: conv.whatsapp,
        lastMessage: conv.lastMessage,
        lastMessageTime: conv.lastMessageTime,
        archivedAt: conv.archivedAt,
        messageCount: conv.messages?.length || 0
      }))
      .sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
    
    res.json({ success: true, chats: archivedChats });
  } catch (error) {
    console.error("Error fetching archived chats:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Restore archived chat
app.post("/chat/:whatsapp/restore", (req, res) => {
  try {
    const { whatsapp } = req.params;
    const conversation = conversations.get(whatsapp);
    
    if (conversation) {
      conversation.archived = false;
      conversation.archivedAt = undefined;
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
app.post("/upload", upload.single("file"), (req, res) => {
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

// Test route
app.get("/test", (req, res) => {
  res.json({
    status: "IN-MEMORY MODE ACTIVE",
    totalConversations: conversations.size,
    totalAgents: agents.size,
    activeChats: activeChats.size,
    broadcastMessages: broadcastMessages.length,
    storageInfo: "All messages stored in memory only"
  });
});

// ===== ADD THIS NEW ROUTE =====
// Get agent info for debugging
app.get("/agent/:id/info", (req, res) => {
  const agent = agents.get(req.params.id);
  if (agent) {
    res.json({
      success: true,
      agent: {
        id: req.params.id,
        name: agent.name,
        muted: agent.muted || false,
        isOnline: agent.socketId ? true : false,
        filename: agent.filename || null,
        createdAt: agent.createdAt,
        lastSeen: agent.lastSeen
      }
    });
  } else {
    res.status(404).json({
      success: false,
      message: "Agent not found"
    });
  }
});
// ================================

// ---- Socket.IO events ----
io.on("connection", (socket) => {
  console.log("New connection:", socket.id);
  users.set(socket.id, { type: 'unknown' });

  // ===== SUPER ADMIN EVENTS =====
  socket.on("super_admin_login", ({ password }) => {
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

  // ===== REGISTER AGENT (with both event names for compatibility) =====
  socket.on("register_agent", (data) => {
    handleAgentRegistration(socket, data);
  });
  
  socket.on("register_permanent_agent", (data) => {
    handleAgentRegistration(socket, data);
  });
  
  function handleAgentRegistration(socket, data) {
    const { id, name, password, filename, agentId } = data;
    const agentIdToUse = id || agentId;
    
    if (!agentIdToUse || !name || !password) {
      socket.emit("agent_registration_response", { 
        success: false, 
        message: "Missing required fields: id, name, password" 
      });
      return;
    }
    
    try {
      // Check if agent already exists
      const existingAgent = agents.get(agentIdToUse);
      
      if (existingAgent) {
        // Update existing agent if needed
        if (filename && !existingAgent.filename) {
          existingAgent.filename = filename;
        }
        
        socket.emit("agent_registration_response", { 
          success: true, 
          message: "Agent already exists and is ready for login",
          agentId: agentIdToUse
        });
        
        logActivity('agent_auto_registered', { 
          agentId: agentIdToUse, 
          name: name,
          filename: filename || existingAgent.filename 
        });
      } else {
        // Create new agent
        agents.set(agentIdToUse, {
          name: name || `Agent ${agentIdToUse}`,
          password,
          muted: false,
          socketId: null,
          filename: filename || null,
          createdAt: new Date(),
          lastSeen: null,
          permanent: true
        });
        
        socket.emit("agent_registration_response", { 
          success: true, 
          message: "Agent registered successfully",
          agentId: agentIdToUse
        });
        
        logActivity('agent_registered', { 
          agentId: agentIdToUse, 
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
      console.error("Error registering agent:", error);
      socket.emit("agent_registration_response", { 
        success: false, 
        message: "Registration failed: " + error.message 
      });
    }
  }

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
  socket.on("save_agent", ({ name, id, password }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    let agentId = id;
    const existingAgent = agents.get(id);
    
    if (existingAgent) {
      // Update existing agent
      existingAgent.name = name;
      existingAgent.password = password;
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
  socket.on("toggle_agent_mute", ({ agentId }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    const agent = agents.get(agentId);
    if (!agent) return;
    
    // Toggle mute status
    agent.muted = !agent.muted;
    
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

  // Get super admin data
  socket.on("get_super_admin_data", () => {
    const userData = users.get(socket.id);
    if (userData?.type === 'super_admin') {
      try {
        const agentsList = Array.from(agents.entries()).map(([id, agent]) => ({
          id,
          name: agent.name,
          muted: agent.muted || false,
          isOnline: agent.socketId ? true : false,
          socketId: agent.socketId,
          filename: agent.filename || null
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
            mutedAgents: Array.from(agents.values()).filter(a => a.muted).length,
            totalConversations: conversations.size,
            broadcastMessages: broadcastMessages.length
          }
        });
      } catch (error) {
        console.error("Error getting super admin data:", error);
      }
    }
  });

  // ===== AGENT LOGIN =====
  socket.on("agent_login", ({ agentId, password, persistent }) => {
    console.log(`Agent login attempt: ${agentId} (persistent: ${persistent})`);
    
    // Check if agent exists
    if (!agents.has(agentId)) {
      console.log(`❌ Agent not found: ${agentId}. Available agents:`, Array.from(agents.keys()));
      
      socket.emit("agent_login_response", {
        success: false,
        message: `Agent "${agentId}" not found. Available agents: ${Array.from(agents.keys()).join(', ')}`
      });
      return;
    }
    
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
    
    // Join the broadcast room
    socket.join(BROADCAST_ROOM);
    
    logActivity('agent_login', { 
      agentId, 
      name: agent.name, 
      socketId: socket.id,
      filename: agent.filename || 'no file'
    });
    
    // ===== SEND BROADCAST ROOM HISTORY TO AGENT =====
    sendBroadcastRoomToAgent(socket.id);
    
    socket.emit("agent_login_response", {
      success: true,
      name: agent.name,
      muted: agent.muted || false,
      agentId: agentId,
      message: "Login successful"
    });
    
    console.log(`✅ Agent logged in: ${agentId} (${agent.name})`);
    
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

  // ===== AGENT JOINS USER ROOM =====
  socket.on("join_user_room", ({ whatsapp }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'agent') return;
    
    const agent = agents.get(userData.agentId);
    if (!agent) return;
    
    // Agent joins the user's specific room
    socket.join(whatsapp);
    
    // Update agent's monitoring status
    agent.monitoringUser = whatsapp;
    
    // Send this user's chat history to the agent
    sendUserChatHistoryToAgent(socket.id, whatsapp);
    
    logActivity('agent_joined_user_room', {
      agentId: userData.agentId,
      agentName: agent.name,
      whatsapp: whatsapp
    });
    
    socket.emit("user_room_joined", {
      success: true,
      whatsapp: whatsapp,
      message: `Now monitoring ${whatsapp}`
    });
  });

  // ===== AGENT SENDS MESSAGE =====
  socket.on("agent_message", (data) => {
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
    
    // ===== Generate timestamp-based ID =====
    const timestamp = new Date().toISOString();
    const messageId = timestamp; // Use timestamp as ID
    
    // Create message object with timestamp ID
    const message = {
      sender: 'agent',
      agentId: userData.agentId,
      agentName: agent.name,
      text: data.message || '',
      timestamp: timestamp, // Same as ID
      read: true,
      id: messageId, // Use timestamp as ID
      whatsapp: whatsapp,
      messageType: 'agent_message'
    };
    
    if (data.attachment) {
      message.attachment = data.attachment;
      message.type = data.attachment.mimetype?.startsWith('image/') ? 'image' : 'file';
    }
    
    // ===== REMOVED: DEDUPLICATION CHECK =====
    // Server no longer checks for duplicates - client handles this
    
    // ===== SAVE TO BOTH PLACES =====
    
    // 1. Save to broadcast room (all agents can see)
    saveMessageToBroadcastRoom(message);
    
    // 2. Save to user's specific chat history
    saveMessageToUserHistory(whatsapp, message);
    
    console.log(`✓ Agent message saved to both broadcast room and ${whatsapp}'s history`);
    
    // ===== SEND TO BOTH ROOMS =====
    
    // 1. Send to broadcast room (all agents)
    broadcastMessageToAllAgents(message, socket.id);
    
    // 2. Send to user's specific room
    sendMessageToUserRoom(whatsapp, message);
    
    // 3. Send to super_admin and admin
    io.to("super_admin").to("admin").emit("new_message", message);
    
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
      messageId: messageId,
      message: data.message ? data.message.substring(0, 50) + '...' : '[Attachment]',
      to: whatsapp,
      savedToBroadcast: true,
      savedToUserHistory: true
    });
  });

  // ===== USER MESSAGES =====
  socket.on("user_message", (data) => {
    console.log("📨 Received user_message event:", data);
    
    // Ensure we have whatsapp/userId
    const whatsapp = data.whatsapp || data.userId;
    if (!whatsapp) {
      console.error("No whatsapp/userId provided");
      return;
    }
    
    // ===== Generate timestamp-based ID =====
    const timestamp = new Date().toISOString();
    const messageId = timestamp; // Use timestamp as ID
    
    // Create a clean message object with timestamp ID
    const message = {
      whatsapp: whatsapp,
      userId: data.userId || whatsapp,
      message: data.message || '',
      timestamp: timestamp, // Use same timestamp
      id: messageId, // Use timestamp as ID
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
    
    // ===== REMOVED: DEDUPLICATION CHECK =====
    // Server no longer checks for duplicates - client handles this
    
    // ===== SAVE TO BOTH PLACES =====
    
    // 1. Save to broadcast room (all agents can see)
    saveMessageToBroadcastRoom(message);
    
    // 2. Save to user's specific chat history
    saveMessageToUserHistory(whatsapp, message);
    
    console.log(`✓ User message saved to both broadcast room and ${whatsapp}'s history`);
    
    // ===== SEND TO BOTH ROOMS =====
    
    // 1. Send to broadcast room (all agents)
    broadcastMessageToAllAgents(message);
    
    // 2. Send to user's specific room
    sendMessageToUserRoom(whatsapp, message);
    
    // 3. Send to super_admin and admin
    io.to("super_admin").to("admin").emit("new_message", {
      ...message,
      sender: "user"
    });
    
    // Update active chats
    activeChats.set(whatsapp, {
      whatsapp: whatsapp,
      lastMessage: data.message || (data.attachment ? `[${data.attachment.mimetype?.split('/')[0] || 'File'}]` : ''),
      lastMessageTime: message.timestamp,
      unread: true
    });
    
    logActivity('user_message_received', {
      from: whatsapp,
      messageId: messageId,
      message: data.message ? data.message.substring(0, 50) + '...' : '[Attachment]',
      hasAttachment: !!data.attachment,
      savedToBroadcast: true,
      savedToUserHistory: true
    });
  });

  // ===== ADMIN CONNECT =====
  socket.on("admin_connect", () => {
    console.log("✓ Admin connected:", socket.id);
    users.set(socket.id, { type: 'admin' });
    socket.join("admin");

    // Send all existing messages to admin
    conversations.forEach((conv, whatsapp) => {
      if (conv.messages && conv.messages.length > 0) {
        conv.messages.forEach(msg => {
          socket.emit("new_message", msg);
        });
      }
    });
  });

  // User register (with whatsapp)
  socket.on("register", ({ whatsapp }) => {
    if (!whatsapp) return;
    users.set(socket.id, { whatsapp, type: 'user' });
    socket.join(whatsapp);
    socket.emit("registered", { success: true });
    console.log(`✓ Registered: ${whatsapp} with socket ${socket.id}`);
  });

  // Get messages for a specific whatsapp
  socket.on("get_messages", ({ whatsapp, agentId, markAsRead = true }) => {
    try {
      const conversation = conversations.get(whatsapp);
      if (!conversation || !conversation.messages) {
        socket.emit("message_history", []);
        return;
      }
      
      // Mark unread messages as read by this agent
      if (markAsRead && agentId) {
        conversation.messages.forEach((msg) => {
          if (msg.sender === "user") {
            if (!msg.readBy) msg.readBy = [];
            if (!msg.readBy.includes(agentId)) {
              msg.readBy.push(agentId);
            }
            msg.read = true;
          }
        });
      }
      
      socket.emit("message_history", conversation.messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      socket.emit("message_history", []);
    }
  });

  // Get existing users for agent interface
  socket.on("get_existing_users", () => {
    try {
      const usersList = Array.from(conversations.values())
        .filter(conv => !conv.archived)
        .map(conv => ({
          whatsapp: conv.whatsapp,
          lastMessage: conv.lastMessage,
          lastMessageTime: conv.lastUpdated,
          messageCount: conv.messages?.length || 0,
          archived: conv.archived || false
        }))
        .sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
      
      socket.emit("existing_users", usersList);
    } catch (error) {
      console.error("Error fetching existing users:", error);
      socket.emit("existing_users", []);
    }
  });

  // Get broadcast room messages
  socket.on("get_broadcast_messages", () => {
    try {
      const userData = users.get(socket.id);
      if (userData?.type === 'agent' || userData?.type === 'super_admin' || userData?.type === 'admin') {
        socket.emit("broadcast_messages_history", broadcastMessages);
      }
    } catch (error) {
      console.error("Error fetching broadcast messages:", error);
      socket.emit("broadcast_messages_history", []);
    }
  });

  // Delete chat
  socket.on("delete_chat", ({ whatsapp, archiveOnly = false }) => {
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
        success = archiveChat(whatsapp);
      } else {
        success = deleteChat(whatsapp);
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
        message: "Server error" 
      });
    }
  });

  // Delete individual message
  socket.on("delete_message", ({ whatsapp, messageId, deleteForAll = false }) => {
    try {
      const userData = users.get(socket.id);
      if (!userData) {
        socket.emit("delete_message_response", { success: false, message: "User not authenticated" });
        return;
      }
      
      const conversation = conversations.get(whatsapp);
      if (!conversation || !conversation.messages) {
        socket.emit("delete_message_response", { success: false, message: "Conversation not found" });
        return;
      }
      
      let canDelete = false;
      let messageIndex = -1;
      
      // Find the message
      conversation.messages.forEach((msg, index) => {
        if (msg.id === messageId) {
          messageIndex = index;
          if (deleteForAll || userData.type === 'super_admin' || userData.type === 'admin') {
            canDelete = true;
          } else if (userData.type === 'agent' && msg.sender === "agent" && msg.agentId === userData.agentId) {
            canDelete = true;
          }
        }
      });
      
      if (canDelete && messageIndex !== -1) {
        // Remove the message
        conversation.messages.splice(messageIndex, 1);
        
        // Update conversation metadata
        if (conversation.messages.length > 0) {
          const lastMsg = conversation.messages[conversation.messages.length - 1];
          conversation.lastMessage = lastMsg.text || (lastMsg.attachment ? `[${lastMsg.attachment.mimetype?.split('/')[0] || 'File'}]` : '');
          conversation.lastMessageTime = lastMsg.timestamp;
        } else {
          conversation.lastMessage = null;
          conversation.lastMessageTime = null;
        }
        conversation.lastUpdated = new Date();
        
        // Also remove from broadcast room if it exists there
        const broadcastIndex = broadcastMessages.findIndex(msg => msg.id === messageId);
        if (broadcastIndex !== -1) {
          broadcastMessages.splice(broadcastIndex, 1);
        }
        
        // Notify all connected clients about the deletion
        io.to(whatsapp).emit("message_deleted", { whatsapp, messageId });
        io.to("super_admin").to("admin").emit("message_deleted", { whatsapp, messageId });
        io.to(BROADCAST_ROOM).emit("broadcast_message_deleted", { messageId });
        
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
      socket.emit("delete_message_response", { success: false, message: "Server error" });
    }
  });

  // Clear chat
  socket.on("clear_chat", ({ whatsapp }) => {
    try {
      const conversation = conversations.get(whatsapp);
      if (conversation) {
        conversation.messages = [];
        conversation.lastUpdated = new Date();
        conversation.lastMessage = null;
        conversation.lastMessageTime = null;
        
        activeChats.delete(whatsapp);
        
        socket.emit("clear_chat_response", { success: true });
        io.to(whatsapp).emit("chat_cleared", { whatsapp });
        
        logActivity('chat_cleared', { whatsapp, by: socket.id });
      } else {
        socket.emit("clear_chat_response", { 
          success: false, 
          message: "Chat not found" 
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

  // Get chat statistics
  socket.on("get_chat_stats", () => {
    try {
      const userData = users.get(socket.id);
      if (!userData || (userData.type !== 'super_admin' && userData.type !== 'admin')) {
        return;
      }
      
      const totalChats = Array.from(conversations.values()).filter(c => !c.archived).length;
      const archivedChats = Array.from(conversations.values()).filter(c => c.archived).length;
      const totalMessages = Array.from(conversations.values()).reduce((sum, conv) => sum + (conv.messages?.length || 0), 0);
      
      socket.emit("chat_stats", {
        totalChats,
        archivedChats,
        totalMessages,
        broadcastMessages: broadcastMessages.length,
        storageMode: "IN-MEMORY ONLY",
        note: "Data will be lost on server restart"
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
          agent.monitoringUser = null; // Clear monitoring status
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
function startServer() {
  const PORT = process.env.PORT || 3000;

  // Pre-register default agents on server start
  preRegisterDefaultAgents();
  
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔐 Super Admin password: ${SUPER_ADMIN_PASSWORD}`);
    console.log(`📡 Broadcast Room: ${BROADCAST_ROOM}`);
    console.log(`✅ Pre-registered agents: agent1, agent2, agent3`);
    console.log(`📁 Available routes:`);
    console.log(`   /chat - User chat interface`);
    console.log(`   /admin - Original admin panel`);
    console.log(`   /superadmin - Super admin panel`);
    console.log(`   /agent - Agent panel`);
    console.log(`   /agent/conversations - Get all conversations`);
    console.log(`   /agent/:id/info - Get agent info (for debugging)`);
    console.log(`   DELETE /chat/:whatsapp - Delete a chat`);
    console.log(`   GET /chats/archived - Get archived chats`);
    console.log(`   POST /chat/:whatsapp/restore - Restore archived chat`);
    console.log(`   /test - Test endpoint`);
    console.log(`📂 Uploads directory: ${UPLOADS_DIR}`);
    console.log(`\n✅ System is ready with DUAL STORAGE SYSTEM!`);
    console.log(`📡 BROADCAST ROOM: All messages saved for all agents`);
    console.log(`💾 USER ROOMS: Each user's messages saved under their WhatsApp ID`);
    console.log(`🔧 Agents automatically get broadcast history on login`);
    console.log(`👤 Agents can join individual user rooms to see their history`);
    console.log(`⚠️  WARNING: Data is ephemeral - will be lost on server restart`);
  });
}

startServer();