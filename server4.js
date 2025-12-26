const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const pool = require("./db");

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

// ===== IN-MEMORY STORAGE FOR ACTIVE CONNECTIONS =====
const users = new Map();           // socketId -> { type, agentId, whatsapp }
const agents = new Map();          // agentId -> { name, password, muted, socketId, filename? }
const activityLog = [];            // Activity log
// ====================================================

// ===== DATABASE HELPER FUNCTIONS =====

// Initialize database tables
async function initializeDatabase() {
  try {
    // Create chats table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id SERIAL PRIMARY KEY,
        whatsapp VARCHAR(255) UNIQUE NOT NULL,
        last_message TEXT,
        last_message_time TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        archived BOOLEAN DEFAULT FALSE,
        archived_at TIMESTAMP
      )
    `);

    // Create messages table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(255) PRIMARY KEY,
        chat_whatsapp VARCHAR(255) REFERENCES chats(whatsapp) ON DELETE CASCADE,
        sender_type VARCHAR(50) NOT NULL,
        agent_id VARCHAR(255),
        agent_name VARCHAR(255),
        content TEXT,
        message_type VARCHAR(50) DEFAULT 'text',
        attachment_url TEXT,
        attachment_type VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        read BOOLEAN DEFAULT FALSE,
        broadcast_id VARCHAR(255),
        is_broadcast BOOLEAN DEFAULT FALSE
      )
    `);

    // Create message_reads table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_reads (
        id SERIAL PRIMARY KEY,
        message_id VARCHAR(255) REFERENCES messages(id) ON DELETE CASCADE,
        agent_id VARCHAR(255),
        read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create chat_participants table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_participants (
        id SERIAL PRIMARY KEY,
        chat_whatsapp VARCHAR(255) REFERENCES chats(whatsapp) ON DELETE CASCADE,
        agent_id VARCHAR(255),
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_monitoring BOOLEAN DEFAULT FALSE
      )
    `);

    // Create agents table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        muted BOOLEAN DEFAULT FALSE,
        filename VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP,
        socket_id VARCHAR(255),
        permanent BOOLEAN DEFAULT TRUE
      )
    `);

    console.log("✅ Database tables initialized");
  } catch (error) {
    console.error("❌ Error initializing database:", error);
  }
}

// ===== SAVE MESSAGE TO DATABASE =====
async function saveMessageToDatabase(message) {
  try {
    const {
      id,
      whatsapp,
      sender,
      agentId,
      agentName,
      text,
      messageType = 'text',
      attachment,
      timestamp,
      read = false,
      broadcastId = uuidv4(),
      isBroadcast = false
    } = message;

    // Create a truly unique ID by combining timestamp with UUID
    const uniqueId = `${id}_${uuidv4().split('-')[0]}`;

    // First, ensure chat exists
    await pool.query(`
      INSERT INTO chats (whatsapp, last_message, last_message_time, last_updated)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (whatsapp) 
      DO UPDATE SET 
        last_message = EXCLUDED.last_message,
        last_message_time = EXCLUDED.last_message_time,
        last_updated = EXCLUDED.last_updated
    `, [
      whatsapp,
      text || (attachment ? `[${attachment.mimetype?.split('/')[0] || 'File'}]` : ''),
      timestamp || new Date(),
      new Date()
    ]);

    // Save the message with unique ID
    await pool.query(`
      INSERT INTO messages (
        id, chat_whatsapp, sender_type, agent_id, agent_name, 
        content, message_type, attachment_url, attachment_type,
        created_at, read, broadcast_id, is_broadcast
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      uniqueId,
      whatsapp,
      sender,
      agentId,
      agentName,
      text || '',
      messageType,
      attachment?.url,
      attachment?.mimetype,
      timestamp || new Date(),
      read,
      broadcastId,
      isBroadcast
    ]);

    console.log(`💾 Saved message to database: ${uniqueId}`);
    return { success: true, id: uniqueId };
  } catch (error) {
    console.error("Error saving message to database:", error);
    return { success: false, error: error.message };
  }
}

// ===== SAVE MESSAGE TO BROADCAST ROOM (DATABASE VERSION) =====
async function saveMessageToBroadcastRoom(message) {
  try {
    const broadcastMessage = {
      ...message,
      isBroadcast: true,
      broadcastTimestamp: new Date().toISOString(),
      broadcastId: uuidv4()
    };
    
    // Save to database
    const result = await saveMessageToDatabase(broadcastMessage);
    
    if (!result.success) {
      console.error("Failed to save broadcast message");
      return null;
    }
    
    console.log(`📡 Saved to broadcast room in database: ${result.id}`);
    return { ...broadcastMessage, id: result.id };
  } catch (error) {
    console.error("Error saving to broadcast room:", error);
    return null;
  }
}

// ===== SAVE MESSAGE TO USER'S CHAT HISTORY (DATABASE VERSION) =====
async function saveMessageToUserHistory(whatsapp, message) {
  try {
    // Save to database (which handles both creation and updates)
    const result = await saveMessageToDatabase({
      ...message,
      whatsapp: whatsapp
    });
    
    console.log(`💾 Saved message for ${whatsapp} to database: ${result.id}`);
    return result.success;
  } catch (error) {
    console.error("Error saving message to user history:", error);
    return false;
  }
}

// ===== SEND BROADCAST ROOM MESSAGES TO AGENT (DATABASE VERSION) =====
async function sendBroadcastRoomToAgent(agentSocketId) {
  try {
    // Get broadcast messages from database
    const result = await pool.query(`
      SELECT 
        m.id,
        m.chat_whatsapp as whatsapp,
        m.sender_type as sender,
        m.agent_id,
        m.agent_name,
        m.content as text,
        m.message_type as type,
        m.attachment_url,
        m.attachment_type,
        m.created_at as timestamp,
        m.read,
        m.broadcast_id,
        m.is_broadcast,
        true as isHistorical
      FROM messages m
      WHERE m.is_broadcast = TRUE
      ORDER BY m.created_at ASC
      LIMIT 1000
    `);

    const broadcastMessages = result.rows.map(row => ({
      ...row,
      attachment: row.attachment_url ? {
        url: row.attachment_url,
        mimetype: row.attachment_type
      } : null
    }));

    // Send all broadcast messages to the agent
    broadcastMessages.forEach(message => {
      io.to(agentSocketId).emit("broadcast_message", message);
    });
    
    console.log(`📨 Sent ${broadcastMessages.length} broadcast messages from database to agent`);
  } catch (error) {
    console.error("Error sending broadcast room to agent:", error);
  }
}

// ===== SEND USER CHAT HISTORY TO AGENT (DATABASE VERSION) =====
async function sendUserChatHistoryToAgent(agentSocketId, whatsapp) {
  try {
    // Get user's messages from database
    const result = await pool.query(`
      SELECT 
        m.id,
        m.chat_whatsapp as whatsapp,
        m.sender_type as sender,
        m.agent_id,
        m.agent_name,
        m.content as text,
        m.message_type as type,
        m.attachment_url,
        m.attachment_type,
        m.created_at as timestamp,
        m.read,
        m.broadcast_id,
        m.is_broadcast,
        true as isHistorical
      FROM messages m
      WHERE m.chat_whatsapp = $1
      ORDER BY m.created_at ASC
    `, [whatsapp]);

    const messages = result.rows.map(row => ({
      ...row,
      attachment: row.attachment_url ? {
        url: row.attachment_url,
        mimetype: row.attachment_type
      } : null
    }));

    if (messages.length > 0) {
      // Send each message from this user's history
      messages.forEach(message => {
        io.to(agentSocketId).emit("user_chat_history", {
          ...message,
          whatsapp: whatsapp,
          isHistorical: true
        });
      });
      
      console.log(`📨 Sent ${messages.length} messages from ${whatsapp} to agent from database`);
    }
  } catch (error) {
    console.error(`Error sending ${whatsapp} chat history to agent:`, error);
  }
}

// ===== BROADCAST MESSAGE TO ALL AGENTS (DATABASE VERSION) =====
async function broadcastMessageToAllAgents(messageData, excludeSocketId = null) {
  try {
    // Save to broadcast room first
    const broadcastMessage = await saveMessageToBroadcastRoom(messageData);
    
    if (!broadcastMessage) return false;
    
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

// ===== SEND MESSAGE TO SPECIFIC USER ROOM (DATABASE VERSION) =====
async function sendMessageToUserRoom(whatsapp, message) {
  try {
    // Save to user's chat history
    await saveMessageToUserHistory(whatsapp, message);
    
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

// ===== MARK MESSAGES AS READ (DATABASE VERSION) =====
async function markMessagesAsRead(whatsapp, messageIds) {
  try {
    const updatedMessages = [];
    
    for (const messageId of messageIds) {
      // Update message read status in database
      const result = await pool.query(`
        UPDATE messages 
        SET read = TRUE 
        WHERE id = $1 AND chat_whatsapp = $2 AND read = FALSE
        RETURNING id
      `, [messageId, whatsapp]);

      if (result.rows.length > 0) {
        updatedMessages.push(messageId);
        console.log(`✅ Message ${messageId} marked as read in database`);
      }
    }
    
    if (updatedMessages.length > 0) {
      // Broadcast the read status update
      await broadcastReadStatusUpdate(whatsapp, updatedMessages);
      
      return { 
        success: true, 
        messageIds: updatedMessages,
        message: `Marked ${updatedMessages.length} message(s) as read`
      };
    }
    
    return { 
      success: true, 
      messageIds: [],
      message: "No new messages to mark as read"
    };
    
  } catch (error) {
    console.error("Error marking messages as read:", error);
    return { success: false, message: error.message };
  }
}

// ===== BROADCAST READ STATUS UPDATE (DATABASE VERSION) =====
async function broadcastReadStatusUpdate(whatsapp, messageIds) {
  try {
    const updateData = {
      whatsapp,
      messageIds,
      timestamp: new Date().toISOString(),
      read: true
    };
    
    // 1. Send to the specific user room
    io.to(whatsapp).emit("messages_read_update", updateData);
    
    // 2. Send to all agents in the broadcast room
    io.to(BROADCAST_ROOM).emit("broadcast_messages_read_update", updateData);
    
    // 3. Send to super admin and admin
    io.to("super_admin").to("admin").emit("messages_read_update", updateData);
    
    // 4. Send to individual agent rooms (for agents monitoring this user)
    agents.forEach((agent, agentId) => {
      if (agent.socketId && agent.monitoringUser === whatsapp) {
        io.to(agent.socketId).emit("messages_read_update", updateData);
      }
    });
    
    console.log(`📨 Broadcast read status update for ${messageIds.length} message(s) in ${whatsapp}`);
    
    logActivity('messages_marked_read', {
      whatsapp,
      messageCount: messageIds.length,
      messageIds
    });
    
  } catch (error) {
    console.error("Error broadcasting read status update:", error);
  }
}

// ===== GET USER LIST WITH READ RECEIPTS (DATABASE VERSION) =====
async function getUserListWithReadReceipts() {
  try {
    const result = await pool.query(`
      SELECT 
        c.whatsapp,
        c.last_message,
        c.last_message_time,
        c.created_at,
        c.last_updated,
        COUNT(m.id) as message_count,
        COUNT(CASE WHEN m.sender_type = 'user' AND NOT m.read THEN 1 END) as unread_count,
        ARRAY_AGG(
          json_build_object(
            'id', m.id,
            'text', m.content,
            'sender', m.sender_type,
            'timestamp', m.created_at,
            'read', m.read,
            'agent_name', m.agent_name
          ) ORDER BY m.created_at DESC LIMIT 1
        ) as last_message_details
      FROM chats c
      LEFT JOIN messages m ON c.whatsapp = m.chat_whatsapp
      WHERE c.archived = FALSE
      GROUP BY c.whatsapp, c.last_message, c.last_message_time, c.created_at, c.last_updated
      ORDER BY c.last_updated DESC
    `);

    return result.rows.map(row => ({
      whatsapp: row.whatsapp,
      lastMessage: row.last_message,
      lastMessageTime: row.last_message_time,
      createdAt: row.created_at,
      lastUpdated: row.last_updated,
      messageCount: parseInt(row.message_count) || 0,
      unreadCount: parseInt(row.unread_count) || 0,
      lastMessageDetails: row.last_message_details?.[0] || null
    }));
  } catch (error) {
    console.error("Error getting user list with read receipts:", error);
    return [];
  }
}

// ===== DELETE CHAT (DATABASE VERSION) =====
async function deleteChat(whatsapp) {
  try {
    // Delete from database
    await pool.query("DELETE FROM chats WHERE whatsapp = $1", [whatsapp]);
    
    io.emit("chat_deleted", { whatsapp });
    logActivity('chat_deleted', { whatsapp });
    console.log(`🗑️  Deleted chat from database: ${whatsapp}`);
    return true;
  } catch (error) {
    console.error("Error deleting chat from database:", error);
    return false;
  }
}

// ===== ARCHIVE CHAT (DATABASE VERSION) =====
async function archiveChat(whatsapp) {
  try {
    await pool.query(`
      UPDATE chats 
      SET archived = TRUE, archived_at = NOW() 
      WHERE whatsapp = $1
    `, [whatsapp]);
    
    io.emit("chat_archived", { whatsapp });
    logActivity('chat_archived', { whatsapp });
    console.log(`📁 Archived chat in database: ${whatsapp}`);
    return true;
  } catch (error) {
    console.error("Error archiving chat in database:", error);
    return false;
  }
}

// ===== PRE-REGISTER AGENTS (DATABASE VERSION) =====
async function preRegisterDefaultAgents() {
  const defaultAgents = [
    { id: "agent1", name: "agent1", password: "agent1", filename: "agent1.html" },
    { id: "agent2", name: "Agent 2", password: "agent2", filename: "agent2.html" },
    { id: "agent3", name: "Agent 3", password: "agent3", filename: "agent3.html" }
  ];
  
  for (const agent of defaultAgents) {
    try {
      // Check if agent exists in database
      const existingAgent = await pool.query(
        "SELECT id FROM agents WHERE id = $1",
        [agent.id]
      );
      
      if (existingAgent.rows.length === 0) {
        // Insert agent into database
        await pool.query(`
          INSERT INTO agents (id, name, password, filename, permanent)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id) DO NOTHING
        `, [agent.id, agent.name, agent.password, agent.filename, true]);
        
        console.log(`✅ Pre-registered agent in database: ${agent.id} (${agent.name})`);
      }
    } catch (error) {
      console.error(`Error pre-registering agent ${agent.id}:`, error);
    }
  }
}

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
app.get("/", (req, res) => res.send("Chat backend running - POSTGRESQL MODE"));
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

// New route: Get user list with read receipts
app.get("/agent/users", async (req, res) => {
  try {
    const userList = await getUserListWithReadReceipts();
    res.json({ success: true, users: userList });
  } catch (error) {
    console.error("Error fetching user list:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// New route: Fetch all conversations for agent dashboard
app.get("/agent/conversations", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        whatsapp,
        last_message,
        last_message_time,
        created_at,
        last_updated,
        (SELECT COUNT(*) FROM messages WHERE chat_whatsapp = chats.whatsapp) as message_count
      FROM chats
      WHERE archived = FALSE
      ORDER BY last_updated DESC
    `);
    
    const conversationsList = result.rows.map(row => ({
      whatsapp: row.whatsapp,
      lastMessage: row.last_message,
      lastMessageTime: row.last_message_time,
      createdAt: row.created_at,
      lastUpdated: row.last_updated,
      messageCount: parseInt(row.message_count) || 0
    }));
    
    res.json({ success: true, conversations: conversationsList });
  } catch (error) {
    console.error("Error fetching conversations:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Delete chat route
app.delete("/chat/:whatsapp", async (req, res) => {
  try {
    const { whatsapp } = req.params;
    const { archive } = req.query;
    
    let success;
    if (archive === 'true') {
      success = await archiveChat(whatsapp);
    } else {
      success = await deleteChat(whatsapp);
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
app.get("/chats/archived", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        whatsapp,
        last_message,
        last_message_time,
        archived_at,
        (SELECT COUNT(*) FROM messages WHERE chat_whatsapp = chats.whatsapp) as message_count
      FROM chats
      WHERE archived = TRUE
      ORDER BY archived_at DESC
    `);
    
    const archivedChats = result.rows.map(row => ({
      whatsapp: row.whatsapp,
      lastMessage: row.last_message,
      lastMessageTime: row.last_message_time,
      archivedAt: row.archived_at,
      messageCount: parseInt(row.message_count) || 0
    }));
    
    res.json({ success: true, chats: archivedChats });
  } catch (error) {
    console.error("Error fetching archived chats:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Restore archived chat
app.post("/chat/:whatsapp/restore", async (req, res) => {
  try {
    const { whatsapp } = req.params;
    
    const result = await pool.query(`
      UPDATE chats 
      SET archived = FALSE, archived_at = NULL 
      WHERE whatsapp = $1
      RETURNING whatsapp
    `, [whatsapp]);
    
    if (result.rows.length > 0) {
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
app.get("/test", async (req, res) => {
  try {
    const chatsCount = await pool.query("SELECT COUNT(*) FROM chats");
    const messagesCount = await pool.query("SELECT COUNT(*) FROM messages");
    const agentsCount = await pool.query("SELECT COUNT(*) FROM agents");
    
    res.json({
      status: "POSTGRESQL MODE ACTIVE",
      database: "albastxz_db1",
      totalConversations: parseInt(chatsCount.rows[0].count),
      totalAgents: parseInt(agentsCount.rows[0].count),
      totalMessages: parseInt(messagesCount.rows[0].count),
      storageInfo: "All messages stored in PostgreSQL database"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ADD THIS NEW ROUTE =====
// Get agent info for debugging
app.get("/agent/:id/info", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM agents WHERE id = $1",
      [req.params.id]
    );
    
    if (result.rows.length > 0) {
      const agent = result.rows[0];
      res.json({
        success: true,
        agent: {
          id: agent.id,
          name: agent.name,
          muted: agent.muted || false,
          isOnline: agent.socket_id ? true : false,
          filename: agent.filename || null,
          createdAt: agent.created_at,
          lastSeen: agent.last_seen
        }
      });
    } else {
      res.status(404).json({
        success: false,
        message: "Agent not found"
      });
    }
  } catch (error) {
    console.error("Error fetching agent info:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});
// ================================

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
      
      try {
        // Get agents from database
        const result = await pool.query("SELECT * FROM agents");
        const agentsList = result.rows.map(agent => ({
          id: agent.id,
          name: agent.name,
          muted: agent.muted || false,
          isOnline: agent.socket_id ? true : false,
          socketId: agent.socket_id,
          filename: agent.filename || null
        }));
        
        // Also update in-memory agents map for compatibility
        result.rows.forEach(agent => {
          agents.set(agent.id, {
            name: agent.name,
            password: agent.password,
            muted: agent.muted || false,
            socketId: agent.socket_id,
            filename: agent.filename,
            createdAt: agent.created_at,
            lastSeen: agent.last_seen,
            permanent: agent.permanent
          });
        });
        
        socket.emit("super_admin_login_response", { success: true });
        socket.emit("agents_list", agentsList);
        socket.emit("activity_update", activityLog.slice(-50));
        
      } catch (error) {
        console.error("Error getting agents list:", error);
        socket.emit("super_admin_login_response", { 
          success: false, 
          message: "Database error" 
        });
      }
      
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
  
  async function handleAgentRegistration(socket, data) {
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
      // Check if agent already exists in database
      const existingResult = await pool.query(
        "SELECT id FROM agents WHERE id = $1",
        [agentIdToUse]
      );
      
      if (existingResult.rows.length > 0) {
        // Update existing agent if needed
        if (filename) {
          await pool.query(
            "UPDATE agents SET filename = $1 WHERE id = $2",
            [filename, agentIdToUse]
          );
        }
        
        socket.emit("agent_registration_response", { 
          success: true, 
          message: "Agent already exists and is ready for login",
          agentId: agentIdToUse
        });
        
        logActivity('agent_auto_registered', { 
          agentId: agentIdToUse, 
          name: name,
          filename: filename || 'existing file' 
        });
      } else {
        // Create new agent in database
        await pool.query(`
          INSERT INTO agents (id, name, password, filename, permanent)
          VALUES ($1, $2, $3, $4, $5)
        `, [agentIdToUse, name, password, filename || null, true]);
        
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
      
      // Update in-memory map for compatibility
      agents.set(agentIdToUse, {
        name: name,
        password: password,
        muted: false,
        socketId: null,
        filename: filename || null,
        createdAt: new Date(),
        lastSeen: null,
        permanent: true
      });
      
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
  socket.on("get_agents", async () => {
    const userData = users.get(socket.id);
    if (userData?.type === 'super_admin') {
      try {
        const result = await pool.query("SELECT * FROM agents");
        const agentsList = result.rows.map(agent => ({
          id: agent.id,
          name: agent.name,
          muted: agent.muted || false,
          isOnline: agent.socket_id ? true : false,
          socketId: agent.socket_id,
          filename: agent.filename || null
        }));
        socket.emit("agents_list", agentsList);
      } catch (error) {
        console.error("Error getting agents list:", error);
      }
    }
  });

  // Save/Update agent credentials
  socket.on("save_agent", async ({ name, id, password }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    let agentId = id;
    
    try {
      // Check if agent exists in database
      const existingResult = await pool.query(
        "SELECT id FROM agents WHERE id = $1",
        [id]
      );
      
      if (existingResult.rows.length > 0) {
        // Update existing agent in database
        await pool.query(
          "UPDATE agents SET name = $1, password = $2 WHERE id = $3",
          [name, password, id]
        );
      } else {
        // Create new agent in database
        agentId = id || `agent_${Date.now()}`;
        await pool.query(`
          INSERT INTO agents (id, name, password, created_at)
          VALUES ($1, $2, $3, NOW())
        `, [agentId, name, password]);
      }
      
      // Update in-memory map
      agents.set(agentId, {
        name,
        password,
        muted: false,
        socketId: null,
        createdAt: new Date()
      });
      
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
      
    } catch (error) {
      console.error("Error saving agent:", error);
    }
  });

  // Toggle agent mute status
  socket.on("toggle_agent_mute", async ({ agentId }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    try {
      // Update agent mute status in database
      const result = await pool.query(`
        UPDATE agents 
        SET muted = NOT muted 
        WHERE id = $1
        RETURNING name, muted
      `, [agentId]);
      
      if (result.rows.length === 0) return;
      
      const agent = result.rows[0];
      
      // Update in-memory map
      if (agents.has(agentId)) {
        agents.get(agentId).muted = agent.muted;
      }
      
      logActivity('agent_mute_toggled', { 
        agentId, 
        name: agent.name, 
        muted: agent.muted,
        by: socket.id 
      });
      
      // Send mute status to agent if online
      const agentInMemory = agents.get(agentId);
      if (agentInMemory && agentInMemory.socketId) {
        io.to(agentInMemory.socketId).emit("mute_status", {
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
      
    } catch (error) {
      console.error("Error toggling agent mute status:", error);
    }
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
          filename: agent.filename || null
        }));
        
        // Get chat stats from database
        const chatsResult = await pool.query("SELECT COUNT(*) as total FROM chats WHERE archived = FALSE");
        const archivedResult = await pool.query("SELECT COUNT(*) as total FROM chats WHERE archived = TRUE");
        const messagesResult = await pool.query("SELECT COUNT(*) as total FROM messages");
        const broadcastResult = await pool.query("SELECT COUNT(*) as total FROM messages WHERE is_broadcast = TRUE");
        
        socket.emit("super_admin_data", {
          agents: agentsList,
          activeChats: [], // Empty for now, can be populated if needed
          activity: activityLog.slice(-100),
          stats: {
            totalAgents: agents.size,
            onlineAgents: Array.from(agents.values()).filter(a => a.socketId).length,
            activeChats: parseInt(chatsResult.rows[0].total),
            mutedAgents: Array.from(agents.values()).filter(a => a.muted).length,
            totalConversations: parseInt(chatsResult.rows[0].total) + parseInt(archivedResult.rows[0].total),
            broadcastMessages: parseInt(broadcastResult.rows[0].total),
            totalMessages: parseInt(messagesResult.rows[0].total)
          }
        });
      } catch (error) {
        console.error("Error getting super admin data:", error);
      }
    }
  });

  // ===== AGENT LOGIN =====
  socket.on("agent_login", async ({ agentId, password, persistent }) => {
    console.log(`Agent login attempt: ${agentId} (persistent: ${persistent})`);
    
    try {
      // Check if agent exists in database
      const result = await pool.query(
        "SELECT * FROM agents WHERE id = $1",
        [agentId]
      );
      
      if (result.rows.length === 0) {
        console.log(`❌ Agent not found in database: ${agentId}`);
        
        socket.emit("agent_login_response", {
          success: false,
          message: `Agent "${agentId}" not found. Please register first.`
        });
        return;
      }
      
      const agent = result.rows[0];
      
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
      
      // Update agent status in database
      await pool.query(
        "UPDATE agents SET socket_id = $1, last_seen = NOW() WHERE id = $2",
        [socket.id, agentId]
      );
      
      // Update in-memory map
      agents.set(agentId, {
        name: agent.name,
        password: agent.password,
        muted: agent.muted || false,
        socketId: socket.id,
        filename: agent.filename,
        createdAt: agent.created_at,
        lastSeen: new Date(),
        permanent: agent.permanent
      });
      
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
      await sendBroadcastRoomToAgent(socket.id);
      
      // ===== SEND USER LIST WITH READ RECEIPTS TO AGENT =====
      const userList = await getUserListWithReadReceipts();
      socket.emit("user_list_with_read_receipts", userList);
      
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
      
    } catch (error) {
      console.error("Error during agent login:", error);
      socket.emit("agent_login_response", {
        success: false,
        message: "Login failed: " + error.message
      });
    }
  });

  // ===== AGENT JOINS USER ROOM =====
  socket.on("join_user_room", async ({ whatsapp }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'agent') return;
    
    const agent = agents.get(userData.agentId);
    if (!agent) return;
    
    // Agent joins the user's specific room
    socket.join(whatsapp);
    
    // Update agent's monitoring status in memory
    agent.monitoringUser = whatsapp;
    
    // Send this user's chat history to the agent
    await sendUserChatHistoryToAgent(socket.id, whatsapp);
    
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
    
    // ===== Generate timestamp-based ID =====
    const timestamp = new Date().toISOString();
    const messageId = timestamp; // Use timestamp as ID
    
    // Create message object with timestamp ID
    const message = {
      id: messageId,
      sender: 'agent',
      agentId: userData.agentId,
      agentName: agent.name,
      text: data.message || '',
      timestamp: timestamp, // Same as ID
      read: true, // Agent messages are always read
      whatsapp: whatsapp,
      messageType: 'agent_message'
    };
    
    if (data.attachment) {
      message.attachment = data.attachment;
      message.type = data.attachment.mimetype?.startsWith('image/') ? 'image' : 'file';
    }
    
    try {
      // ===== SAVE TO BOTH PLACES =====
      
      // 1. Save to broadcast room (all agents can see)
      const broadcastResult = await saveMessageToBroadcastRoom(message);
      
      // 2. Save to user's specific chat history
      const userHistoryResult = await saveMessageToUserHistory(whatsapp, message);
      
      if (!broadcastResult || !userHistoryResult) {
        throw new Error("Failed to save message to database");
      }
      
      console.log(`✓ Agent message saved to database for ${whatsapp}`);
      
      // ===== SEND TO BOTH ROOMS =====
      
      // 1. Send to broadcast room (all agents)
      await broadcastMessageToAllAgents(message, socket.id);
      
      // 2. Send to user's specific room
      await sendMessageToUserRoom(whatsapp, message);
      
      // 3. Send to super_admin and admin
      io.to("super_admin").to("admin").emit("new_message", message);
      
      // ===== UPDATE USER LIST FOR ALL AGENTS =====
      await updateUserListForAllAgents();
      
      logActivity('agent_message_sent', {
        agentId: userData.agentId,
        agentName: agent.name,
        messageId: messageId,
        message: data.message ? data.message.substring(0, 50) + '...' : '[Attachment]',
        to: whatsapp,
        savedToDatabase: true
      });
      
    } catch (error) {
      console.error("Error sending agent message:", error);
      socket.emit("agent_message_error", {
        message: "Failed to send message"
      });
    }
  });

  // ===== USER MESSAGES =====
  socket.on("user_message", async (data) => {
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
      id: messageId,
      whatsapp: whatsapp,
      userId: data.userId || whatsapp,
      text: data.message || '',
      timestamp: timestamp, // Use same timestamp
      sender: "user",
      type: data.type || "text",
      read: false, // User messages start as unread
      messageType: 'user_message'
    };
    
    // Handle attachments
    if (data.attachment) {
      message.attachment = data.attachment;
      message.type = data.attachment.mimetype?.startsWith('image/') ? 'image' : 'file';
    }
    
    try {
      // ===== SAVE TO BOTH PLACES =====
      
      // 1. Save to broadcast room (all agents can see)
      const broadcastResult = await saveMessageToBroadcastRoom(message);
      
      // 2. Save to user's specific chat history
      const userHistoryResult = await saveMessageToUserHistory(whatsapp, message);
      
      if (!broadcastResult || !userHistoryResult) {
        throw new Error("Failed to save message to database");
      }
      
      console.log(`✓ User message saved to database for ${whatsapp}`);
      
      // ===== SEND TO BOTH ROOMS =====
      
      // 1. Send to broadcast room (all agents)
      await broadcastMessageToAllAgents(message);
      
      // 2. Send to user's specific room
      await sendMessageToUserRoom(whatsapp, message);
      
      // 3. Send to super_admin and admin
      io.to("super_admin").to("admin").emit("new_message", {
        ...message,
        sender: "user"
      });
      
      // ===== UPDATE USER LIST FOR ALL AGENTS =====
      await updateUserListForAllAgents();
      
      logActivity('user_message_received', {
        from: whatsapp,
        messageId: messageId,
        message: data.message ? data.message.substring(0, 50) + '...' : '[Attachment]',
        hasAttachment: !!data.attachment,
        savedToDatabase: true
      });
      
    } catch (error) {
      console.error("Error processing user message:", error);
    }
  });

  // ===== MESSAGE READ RECEIPTS =====
  socket.on("message_read", async (data) => {
    try {
      const userData = users.get(socket.id);
      
      // Only agents can send read receipts
      if (userData?.type !== 'agent') {
        console.log(`❌ Unauthorized read receipt attempt from ${socket.id} (type: ${userData?.type})`);
        return;
      }
      
      const { whatsapp, messageIds, timestamp } = data;
      
      // Validate data
      if (!whatsapp || !messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
        console.error("Invalid read receipt data:", data);
        return;
      }
      
      console.log(`📖 Read receipt received for ${messageIds.length} messages in ${whatsapp}`);
      
      // Mark messages as read
      const result = await markMessagesAsRead(whatsapp, messageIds);
      
      // ===== UPDATE USER LIST FOR ALL AGENTS =====
      await updateUserListForAllAgents();
      
      // Send confirmation back
      socket.emit("message_read_confirmation", {
        ...result,
        timestamp: timestamp || new Date().toISOString()
      });
      
    } catch (error) {
      console.error("Error processing read receipt:", error);
      socket.emit("message_read_confirmation", {
        success: false,
        message: error.message
      });
    }
  });

  // ===== UPDATE USER LIST FOR ALL AGENTS =====
  async function updateUserListForAllAgents() {
    try {
      const userList = await getUserListWithReadReceipts();
      
      // Send to all online agents
      agents.forEach((agent, agentId) => {
        if (agent.socketId) {
          io.to(agent.socketId).emit("user_list_with_read_receipts", userList);
        }
      });
      
      // Also send to super admin and admin
      io.to("super_admin").to("admin").emit("user_list_with_read_receipts", userList);
      
    } catch (error) {
      console.error("Error updating user list for agents:", error);
    }
  }

  // ===== AGENT REQUESTS USER LIST =====
  socket.on("get_user_list_with_read_receipts", async () => {
    try {
      const userData = users.get(socket.id);
      
      // Only agents, super admin, and admin can request user list
      if (!userData || (userData.type !== 'agent' && userData.type !== 'super_admin' && userData.type !== 'admin')) {
        return;
      }
      
      const userList = await getUserListWithReadReceipts();
      socket.emit("user_list_with_read_receipts", userList);
      
    } catch (error) {
      console.error("Error getting user list:", error);
      socket.emit("user_list_with_read_receipts", []);
    }
  });

  // ===== ADMIN CONNECT =====
  socket.on("admin_connect", async () => {
    console.log("✓ Admin connected:", socket.id);
    users.set(socket.id, { type: 'admin' });
    socket.join("admin");

    try {
      // Send all existing messages to admin from database
      const result = await pool.query(`
        SELECT 
          m.id,
          m.chat_whatsapp as whatsapp,
          m.sender_type as sender,
          m.agent_id,
          m.agent_name,
          m.content as text,
          m.message_type as type,
          m.attachment_url,
          m.attachment_type,
          m.created_at as timestamp,
          m.read,
          m.broadcast_id,
          m.is_broadcast
        FROM messages m
        ORDER BY m.created_at ASC
      `);

      const messages = result.rows.map(row => ({
        ...row,
        attachment: row.attachment_url ? {
          url: row.attachment_url,
          mimetype: row.attachment_type
        } : null
      }));

      messages.forEach(msg => {
        socket.emit("new_message", msg);
      });
      
      // Send user list with read receipts to admin
      const userList = await getUserListWithReadReceipts();
      socket.emit("user_list_with_read_receipts", userList);
      
    } catch (error) {
      console.error("Error sending messages to admin:", error);
    }
  });

  // User register (with whatsapp)
  socket.on("register", async ({ whatsapp }) => {
    if (!whatsapp) return;
    users.set(socket.id, { whatsapp, type: 'user' });
    socket.join(whatsapp);
    socket.emit("registered", { success: true });
    console.log(`✓ Registered: ${whatsapp} with socket ${socket.id}`);
    
    // Update user list for all agents when a new user registers
    await updateUserListForAllAgents();
  });

  // Get messages for a specific whatsapp
  socket.on("get_messages", async ({ whatsapp, agentId, markAsRead = true }) => {
    try {
      const result = await pool.query(`
        SELECT 
          m.id,
          m.chat_whatsapp as whatsapp,
          m.sender_type as sender,
          m.agent_id,
          m.agent_name,
          m.content as text,
          m.message_type as type,
          m.attachment_url,
          m.attachment_type,
          m.created_at as timestamp,
          m.read,
          m.broadcast_id,
          m.is_broadcast
        FROM messages m
        WHERE m.chat_whatsapp = $1
        ORDER BY m.created_at ASC
      `, [whatsapp]);

      const messages = result.rows.map(row => ({
        ...row,
        attachment: row.attachment_url ? {
          url: row.attachment_url,
          mimetype: row.attachment_type
        } : null
      }));

      // Mark unread messages as read if requested
      if (markAsRead && agentId) {
        const unreadMessageIds = messages
          .filter(msg => msg.sender === "user" && !msg.read)
          .map(msg => msg.id);
        
        if (unreadMessageIds.length > 0) {
          await markMessagesAsRead(whatsapp, unreadMessageIds);
        }
      }
      
      socket.emit("message_history", messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      socket.emit("message_history", []);
    }
  });

  // Get existing users for agent interface
  socket.on("get_existing_users", async () => {
    try {
      const result = await pool.query(`
        SELECT 
          whatsapp,
          last_message,
          last_message_time,
          last_updated,
          archived,
          (SELECT COUNT(*) FROM messages WHERE chat_whatsapp = chats.whatsapp) as message_count
        FROM chats
        ORDER BY last_updated DESC
      `);
      
      const usersList = result.rows.map(row => ({
        whatsapp: row.whatsapp,
        lastMessage: row.last_message,
        lastMessageTime: row.last_message_time,
        lastUpdated: row.last_updated,
        messageCount: parseInt(row.message_count) || 0,
        archived: row.archived || false
      }));
      
      socket.emit("existing_users", usersList);
    } catch (error) {
      console.error("Error fetching existing users:", error);
      socket.emit("existing_users", []);
    }
  });

  // Get broadcast room messages
  socket.on("get_broadcast_messages", async () => {
    try {
      const userData = users.get(socket.id);
      if (userData?.type === 'agent' || userData?.type === 'super_admin' || userData?.type === 'admin') {
        const result = await pool.query(`
          SELECT 
            m.id,
            m.chat_whatsapp as whatsapp,
            m.sender_type as sender,
            m.agent_id,
            m.agent_name,
            m.content as text,
            m.message_type as type,
            m.attachment_url,
            m.attachment_type,
            m.created_at as timestamp,
            m.read,
            m.broadcast_id,
            m.is_broadcast
          FROM messages m
          WHERE m.is_broadcast = TRUE
          ORDER BY m.created_at ASC
        `);

        const broadcastMessages = result.rows.map(row => ({
          ...row,
          attachment: row.attachment_url ? {
            url: row.attachment_url,
            mimetype: row.attachment_type
          } : null
        }));

        socket.emit("broadcast_messages_history", broadcastMessages);
      }
    } catch (error) {
      console.error("Error fetching broadcast messages:", error);
      socket.emit("broadcast_messages_history", []);
    }
  });

  // Delete chat
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
        success = await deleteChat(whatsapp);
      }
      
      if (success) {
        socket.emit("delete_chat_response", { 
          success: true, 
          message: archiveOnly ? "Chat archived successfully" : "Chat deleted permanently" 
        });
        
        // Update user list for all agents
        await updateUserListForAllAgents();
        
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
  socket.on("delete_message", async ({ whatsapp, messageId, deleteForAll = false }) => {
    try {
      const userData = users.get(socket.id);
      if (!userData) {
        socket.emit("delete_message_response", { success: false, message: "User not authenticated" });
        return;
      }
      
      // Check if message exists and get sender info
      const messageResult = await pool.query(`
        SELECT sender_type, agent_id FROM messages 
        WHERE id = $1 AND chat_whatsapp = $2
      `, [messageId, whatsapp]);
      
      if (messageResult.rows.length === 0) {
        socket.emit("delete_message_response", { success: false, message: "Message not found" });
        return;
      }
      
      const message = messageResult.rows[0];
      let canDelete = false;
      
      // Check permissions
      if (deleteForAll || userData.type === 'super_admin' || userData.type === 'admin') {
        canDelete = true;
      } else if (userData.type === 'agent' && message.sender_type === "agent" && message.agent_id === userData.agentId) {
        canDelete = true;
      }
      
      if (canDelete) {
        // Delete the message from database
        await pool.query("DELETE FROM messages WHERE id = $1", [messageId]);
        
        // Update chat's last message if needed
        const lastMessageResult = await pool.query(`
          SELECT content, created_at, attachment_type 
          FROM messages 
          WHERE chat_whatsapp = $1 
          ORDER BY created_at DESC 
          LIMIT 1
        `, [whatsapp]);
        
        if (lastMessageResult.rows.length > 0) {
          const lastMsg = lastMessageResult.rows[0];
          await pool.query(`
            UPDATE chats 
            SET last_message = $1, last_message_time = $2, last_updated = NOW()
            WHERE whatsapp = $3
          `, [
            lastMsg.content || (lastMsg.attachment_type ? `[${lastMsg.attachment_type.split('/')[0] || 'File'}]` : ''),
            lastMsg.created_at,
            whatsapp
          ]);
        } else {
          // No messages left, update chat with null values
          await pool.query(`
            UPDATE chats 
            SET last_message = NULL, last_message_time = NULL, last_updated = NOW()
            WHERE whatsapp = $1
          `, [whatsapp]);
        }
        
        // Update user list for all agents
        await updateUserListForAllAgents();
        
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
  socket.on("clear_chat", async ({ whatsapp }) => {
    try {
      // Delete all messages for this chat
      await pool.query("DELETE FROM messages WHERE chat_whatsapp = $1", [whatsapp]);
      
      // Update chat metadata
      await pool.query(`
        UPDATE chats 
        SET last_message = NULL, last_message_time = NULL, last_updated = NOW()
        WHERE whatsapp = $1
      `, [whatsapp]);
      
      // Update user list for all agents
      await updateUserListForAllAgents();
      
      socket.emit("clear_chat_response", { success: true });
      io.to(whatsapp).emit("chat_cleared", { whatsapp });
      
      logActivity('chat_cleared', { whatsapp, by: socket.id });
      
    } catch (error) {
      console.error("Error clearing chat:", error);
      socket.emit("clear_chat_response", { 
        success: false, 
        message: "Failed to clear chat" 
      });
    }
  });

  // Get chat statistics
  socket.on("get_chat_stats", async () => {
    try {
      const userData = users.get(socket.id);
      if (!userData || (userData.type !== 'super_admin' && userData.type !== 'admin')) {
        return;
      }
      
      const totalChats = await pool.query("SELECT COUNT(*) as total FROM chats WHERE archived = FALSE");
      const archivedChats = await pool.query("SELECT COUNT(*) as total FROM chats WHERE archived = TRUE");
      const totalMessages = await pool.query("SELECT COUNT(*) as total FROM messages");
      const broadcastMessages = await pool.query("SELECT COUNT(*) as total FROM messages WHERE is_broadcast = TRUE");
      
      socket.emit("chat_stats", {
        totalChats: parseInt(totalChats.rows[0].total),
        archivedChats: parseInt(archivedChats.rows[0].total),
        totalMessages: parseInt(totalMessages.rows[0].total),
        broadcastMessages: parseInt(broadcastMessages.rows[0].total),
        storageMode: "POSTGRESQL DATABASE",
        note: "Data persists across server restarts"
      });
    } catch (error) {
      console.error("Error getting chat stats:", error);
    }
  });

  // ===== DISCONNECTION =====
  socket.on("disconnect", async () => {
    const user = users.get(socket.id);
    
    if (user) {
      if (user.type === 'agent' && user.agentId) {
        const agent = agents.get(user.agentId);
        if (agent) {
          // Update agent status in database
          try {
            await pool.query(
              "UPDATE agents SET socket_id = NULL, last_seen = NOW() WHERE id = $1",
              [user.agentId]
            );
          } catch (error) {
            console.error("Error updating agent status in database:", error);
          }
          
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
async function startServer() {
  const PORT = process.env.PORT || 3000;

  try {
    // Initialize database tables
    await initializeDatabase();
    
    // Pre-register default agents on server start
    await preRegisterDefaultAgents();
    
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
      console.log(`   /agent/users - NEW: Get user list with read receipts`);
      console.log(`   /agent/conversations - Get all conversations`);
      console.log(`   /agent/:id/info - Get agent info (for debugging)`);
      console.log(`   DELETE /chat/:whatsapp - Delete a chat`);
      console.log(`   GET /chats/archived - Get archived chats`);
      console.log(`   POST /chat/:whatsapp/restore - Restore archived chat`);
      console.log(`   /test - Test endpoint`);
      console.log(`📂 Uploads directory: ${UPLOADS_DIR}`);
      console.log(`\n✅ System is ready with POSTGRESQL STORAGE!`);
      console.log(`💾 Database: albastxz_db1`);
      console.log(`📊 All data is now being saved to PostgreSQL`);
      console.log(`🔧 Agents automatically get broadcast history on login`);
      console.log(`👤 Agents can join individual user rooms to see their history`);
      console.log(`✅ User list with read receipts enabled!`);
      console.log(`   - GET /agent/users endpoint for API access`);
      console.log(`   - Socket event: get_user_list_with_read_receipts`);
      console.log(`   - Real-time updates when messages are sent/read`);
      console.log(`   - Shows unread count per user`);
      console.log(`✅ Data persists across server restarts!`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();