const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const pool = require("./db");

// ===== CONFIGURATION =====
const SUPER_ADMIN_PASSWORD = "SUPER.ADMIN";
const BROADCAST_ROOM = "BROADCAST_ROOM_ALL_AGENTS";
const DB_SYNC_INTERVAL = 20 * 60 * 1000; // 20 minutes
const MAX_LOCAL_MESSAGES = 1000;

// ===== LOCAL STORAGE (Primary) =====
const users = new Map();
const agents = new Map();
const activityLog = [];

// Local message storage
const localMessages = {
  userChats: new Map(),
  broadcast: [],
  syncQueue: [],
  lastSync: null,

  async initialize() {
    try {
      console.log("📥 Loading recent messages from database...");
      
      // Load last 100 broadcast messages
      const broadcastResult = await pool.query(`
        SELECT * FROM messages 
        WHERE is_broadcast = TRUE 
        ORDER BY created_at DESC 
        LIMIT 100
      `);
      
      this.broadcast = broadcastResult.rows.map(row => this.mapDbToLocal(row));
      
      // Load recent user chats (last 50 messages each)
      const chatsResult = await pool.query(`
        SELECT DISTINCT chat_whatsapp 
        FROM messages 
        WHERE is_broadcast = FALSE 
        ORDER BY created_at DESC 
        LIMIT 50
      `);
      
      for (const row of chatsResult.rows) {
        const messagesResult = await pool.query(`
          SELECT * FROM messages 
          WHERE chat_whatsapp = $1 
          ORDER BY created_at DESC 
          LIMIT 50
        `, [row.chat_whatsapp]);
        
        this.userChats.set(row.chat_whatsapp, 
          messagesResult.rows.map(msg => this.mapDbToLocal(msg))
        );
      }
      
      console.log("✅ Local storage initialized from database");
    } catch (error) {
      console.error("❌ Error initializing local storage:", error);
    }
  },
  
  mapDbToLocal(dbRow) {
    return {
      id: dbRow.id,
      whatsapp: dbRow.chat_whatsapp,
      sender: dbRow.sender_type,
      agentId: dbRow.agent_id,
      agentName: dbRow.agent_name,
      text: dbRow.content,
      messageType: dbRow.message_type,
      attachment: dbRow.attachment_url ? {
        url: dbRow.attachment_url,
        mimetype: dbRow.attachment_type
      } : null,
      timestamp: dbRow.created_at,
      read: dbRow.read,
      broadcastId: dbRow.broadcast_id,
      isBroadcast: dbRow.is_broadcast,
      fromDatabase: true,
      syncedToDb: true
    };
  },
  
  mapLocalToDb(localMsg) {
    return {
      id: localMsg.id,
      chat_whatsapp: localMsg.whatsapp,
      sender_type: localMsg.sender,
      agent_id: localMsg.agentId,
      agent_name: localMsg.agentName,
      content: localMsg.text,
      message_type: localMsg.messageType || 'text',
      attachment_url: localMsg.attachment?.url,
      attachment_type: localMsg.attachment?.mimetype,
      created_at: localMsg.timestamp || new Date(),
      read: localMsg.read || false,
      broadcast_id: localMsg.broadcastId,
      is_broadcast: localMsg.isBroadcast || false
    };
  },
  
  addMessage(message) {
    const msg = {
      ...message,
      localId: uuidv4(),
      timestamp: message.timestamp || new Date(),
      read: message.read || false,
      syncedToDb: false
    };
    
    if (msg.isBroadcast) {
      this.broadcast.unshift(msg);
      if (this.broadcast.length > MAX_LOCAL_MESSAGES) {
        this.broadcast.pop();
      }
    } else if (msg.whatsapp) {
      if (!this.userChats.has(msg.whatsapp)) {
        this.userChats.set(msg.whatsapp, []);
      }
      const userMessages = this.userChats.get(msg.whatsapp);
      userMessages.unshift(msg);
      if (userMessages.length > 100) {
        userMessages.pop();
      }
    }
    
    this.syncQueue.push(msg);
    return msg;
  },
  
  getUserMessages(whatsapp, limit = 100) {
    const messages = this.userChats.get(whatsapp) || [];
    return messages.slice(0, limit).reverse();
  },
  
  getBroadcastMessages(limit = 100) {
    return this.broadcast.slice(0, limit).reverse();
  },
  
  markAsRead(whatsapp, messageIds) {
    const updated = [];
    const messages = this.userChats.get(whatsapp) || [];
    
    messageIds.forEach(msgId => {
      const msg = messages.find(m => m.id === msgId || m.localId === msgId);
      if (msg && !msg.read) {
        msg.read = true;
        msg.syncedToDb = false;
        updated.push(msgId);
      }
    });
    
    return updated;
  },
  
  async syncToDatabase() {
    if (this.syncQueue.length === 0) {
      return;
    }
    
    const toSync = [...this.syncQueue];
    this.syncQueue = [];
    
    try {
      console.log(`🔄 Syncing ${toSync.length} messages to database...`);
      
      for (const msg of toSync) {
        if (msg.syncedToDb) continue;
        
        const dbMsg = this.mapLocalToDb(msg);
        
        await pool.query(`
          INSERT INTO chats (whatsapp, last_message, last_message_time, last_updated)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (whatsapp) 
          DO UPDATE SET 
            last_message = EXCLUDED.last_message,
            last_message_time = EXCLUDED.last_message_time,
            last_updated = EXCLUDED.last_updated
        `, [
          dbMsg.chat_whatsapp,
          dbMsg.content || (dbMsg.attachment_url ? '[Attachment]' : ''),
          dbMsg.created_at,
          new Date()
        ]);
        
        await pool.query(`
          INSERT INTO messages (
            id, chat_whatsapp, sender_type, agent_id, agent_name, 
            content, message_type, attachment_url, attachment_type,
            created_at, read, broadcast_id, is_broadcast
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (id) 
          DO UPDATE SET 
            read = EXCLUDED.read
        `, [
          dbMsg.id || uuidv4(),
          dbMsg.chat_whatsapp,
          dbMsg.sender_type,
          dbMsg.agent_id,
          dbMsg.agent_name,
          dbMsg.content,
          dbMsg.message_type,
          dbMsg.attachment_url,
          dbMsg.attachment_type,
          dbMsg.created_at,
          dbMsg.read,
          dbMsg.broadcast_id,
          dbMsg.is_broadcast
        ]);
        
        msg.syncedToDb = true;
      }
      
      this.lastSync = new Date();
      console.log(`✅ Synced ${toSync.length} messages to database`);
    } catch (error) {
      console.error("❌ Database sync failed:", error);
      this.syncQueue.push(...toSync.filter(msg => !msg.syncedToDb));
    }
  }
};

// ===== FILE UPLOAD CONFIGURATION =====
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

// ===== DATABASE HELPER FUNCTIONS =====
async function initializeDatabase() {
  try {
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_reads (
        id SERIAL PRIMARY KEY,
        message_id VARCHAR(255) REFERENCES messages(id) ON DELETE CASCADE,
        agent_id VARCHAR(255),
        read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_participants (
        id SERIAL PRIMARY KEY,
        chat_whatsapp VARCHAR(255) REFERENCES chats(whatsapp) ON DELETE CASCADE,
        agent_id VARCHAR(255),
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_monitoring BOOLEAN DEFAULT FALSE
      )
    `);

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

async function preRegisterDefaultAgents() {
  const defaultAgents = [
    { id: "agent1", name: "agent1", password: "agent1", filename: "agent1.html" },
    { id: "agent2", name: "Agent 2", password: "agent2", filename: "agent2.html" },
    { id: "agent3", name: "Agent 3", password: "agent3", filename: "agent3.html" }
  ];
  
  for (const agent of defaultAgents) {
    try {
      const existingAgent = await pool.query(
        "SELECT id FROM agents WHERE id = $1",
        [agent.id]
      );
      
      if (existingAgent.rows.length === 0) {
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

// ===== HELPER FUNCTIONS =====
async function getLocalUserList() {
  const userList = [];
  
  for (const [whatsapp, messages] of localMessages.userChats) {
    const lastMessage = messages[0];
    const unreadCount = messages.filter(m => m.sender === 'user' && !m.read).length;
    
    userList.push({
      whatsapp,
      lastMessage: lastMessage?.text || (lastMessage?.attachment ? '[Attachment]' : ''),
      lastMessageTime: lastMessage?.timestamp,
      messageCount: messages.length,
      unreadCount,
      lastMessageDetails: lastMessage ? {
        id: lastMessage.id,
        text: lastMessage.text,
        sender: lastMessage.sender,
        timestamp: lastMessage.timestamp,
        read: lastMessage.read,
        agent_name: lastMessage.agentName
      } : null
    });
  }
  
  return userList.sort((a, b) => 
    new Date(b.lastMessageTime || 0) - new Date(a.lastMessageTime || 0)
  );
}

async function updateUserListForAllAgents() {
  const userList = await getLocalUserList();
  
  agents.forEach(agent => {
    if (agent.socketId) {
      io.to(agent.socketId).emit("user_list_with_read_receipts", userList);
    }
  });
  
  io.to("super_admin").to("admin").emit("user_list_with_read_receipts", userList);
}

async function handleAgentMessage(socket, data) {
  const userData = users.get(socket.id);
  if (userData?.type !== 'agent') return;
  
  const agent = agents.get(userData.agentId);
  if (!agent || agent.muted) {
    socket.emit("agent_message_error", { message: "Cannot send messages" });
    return;
  }
  
  const whatsapp = data.whatsapp || 'unknown';
  const timestamp = new Date();
  
  const message = localMessages.addMessage({
    id: `${timestamp.getTime()}_${uuidv4().slice(0, 8)}`,
    sender: 'agent',
    agentId: userData.agentId,
    agentName: agent.name,
    text: data.message || '',
    timestamp,
    read: true,
    whatsapp,
    messageType: 'agent_message',
    isBroadcast: true,
    attachment: data.attachment
  });
  
  io.to(BROADCAST_ROOM).emit("broadcast_message", message);
  io.to(whatsapp).emit("new_message", { ...message, whatsapp });
  io.to("super_admin").to("admin").emit("new_message", message);
  
  updateUserListForAllAgents();
  
  console.log(`⚡ Agent message sent instantly: ${message.id}`);
  return true;
}

async function handleUserMessage(socket, data) {
  const whatsapp = data.whatsapp || data.userId;
  if (!whatsapp) return;
  
  const timestamp = new Date();
  
  const message = localMessages.addMessage({
    id: `${timestamp.getTime()}_${uuidv4().slice(0, 8)}`,
    sender: 'user',
    text: data.message || '',
    timestamp,
    read: false,
    whatsapp,
    messageType: 'user_message',
    isBroadcast: true,
    attachment: data.attachment
  });
  
  io.to(BROADCAST_ROOM).emit("broadcast_message", message);
  io.to(whatsapp).emit("new_message", { ...message, whatsapp });
  io.to("super_admin").to("admin").emit("new_message", message);
  
  updateUserListForAllAgents();
  
  console.log(`⚡ User message received instantly: ${message.id}`);
  return true;
}

// ===== DATABASE SYNC SCHEDULER =====
function startDatabaseSync() {
  setTimeout(() => {
    localMessages.syncToDatabase();
    setInterval(() => {
      localMessages.syncToDatabase();
    }, DB_SYNC_INTERVAL);
  }, DB_SYNC_INTERVAL);
}

// ===== SERVER SETUP =====
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

// ===== ROUTES =====
app.get("/", (req, res) => res.send("Chat backend running - POSTGRESQL MODE"));
app.get("/chat", (req, res) => res.sendFile(path.join(__dirname, "public", "chat.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/superadmin", (req, res) => res.sendFile(path.join(__dirname, "public", "superadmin.html")));
app.get("/agent", (req, res) => res.sendFile(path.join(__dirname, "public", "agent.html")));

app.get("/agent:num.html", (req, res) => {
  const filename = `agent${req.params.num}.html`;
  const filePath = path.join(__dirname, filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Agent file not found");
  }
});

app.get("/agent/users", async (req, res) => {
  try {
    const userList = await getLocalUserList();
    res.json({ success: true, users: userList });
  } catch (error) {
    console.error("Error fetching user list:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

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

app.delete("/chat/:whatsapp", async (req, res) => {
  try {
    const { whatsapp } = req.params;
    const { archive } = req.query;
    
    let success = false;
    if (archive === 'true') {
      await pool.query(`
        UPDATE chats 
        SET archived = TRUE, archived_at = NOW() 
        WHERE whatsapp = $1
      `, [whatsapp]);
      success = true;
    } else {
      await pool.query("DELETE FROM chats WHERE whatsapp = $1", [whatsapp]);
      success = true;
    }
    
    if (success) {
      io.emit(archive === 'true' ? "chat_archived" : "chat_deleted", { whatsapp });
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
      localMessages: localMessages.broadcast.length + Array.from(localMessages.userChats.values()).reduce((sum, msgs) => sum + msgs.length, 0),
      storageInfo: "Hybrid: Local-first with 20-minute database sync"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

// ===== SOCKET.IO EVENTS =====
io.on("connection", (socket) => {
  console.log("New connection:", socket.id);
  users.set(socket.id, { type: 'unknown' });

  socket.on("super_admin_login", async ({ password }) => {
    if (password === SUPER_ADMIN_PASSWORD) {
      users.set(socket.id, { type: 'super_admin' });
      socket.join("super_admin");
      
      logActivity('super_admin_login', { socketId: socket.id });
      console.log("✓ Super Admin connected:", socket.id);
      
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
      const existingResult = await pool.query(
        "SELECT id FROM agents WHERE id = $1",
        [agentIdToUse]
      );
      
      if (existingResult.rows.length > 0) {
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

  socket.on("save_agent", async ({ name, id, password }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    let agentId = id;
    
    try {
      const existingResult = await pool.query(
        "SELECT id FROM agents WHERE id = $1",
        [id]
      );
      
      if (existingResult.rows.length > 0) {
        await pool.query(
          "UPDATE agents SET name = $1, password = $2 WHERE id = $3",
          [name, password, id]
        );
      } else {
        agentId = id || `agent_${Date.now()}`;
        await pool.query(`
          INSERT INTO agents (id, name, password, created_at)
          VALUES ($1, $2, $3, NOW())
        `, [agentId, name, password]);
      }
      
      agents.set(agentId, {
        name,
        password,
        muted: false,
        socketId: null,
        createdAt: new Date()
      });
      
      logActivity('agent_saved', { agentId, name, by: socket.id });
      
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

  socket.on("toggle_agent_mute", async ({ agentId }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    try {
      const result = await pool.query(`
        UPDATE agents 
        SET muted = NOT muted 
        WHERE id = $1
        RETURNING name, muted
      `, [agentId]);
      
      if (result.rows.length === 0) return;
      
      const agent = result.rows[0];
      
      if (agents.has(agentId)) {
        agents.get(agentId).muted = agent.muted;
      }
      
      logActivity('agent_mute_toggled', { 
        agentId, 
        name: agent.name, 
        muted: agent.muted,
        by: socket.id 
      });
      
      const agentInMemory = agents.get(agentId);
      if (agentInMemory && agentInMemory.socketId) {
        io.to(agentInMemory.socketId).emit("mute_status", {
          agentId,
          muted: agent.muted
        });
      }
      
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

  socket.on("forward_to_agents", (data) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'super_admin') return;
    
    agents.forEach((agent, agentId) => {
      if (!agent.muted && agent.socketId) {
        io.to(agent.socketId).emit("forwarded_message", data);
      }
    });
    
    io.to("super_admin").emit("forwarded_message", data);
    
    logActivity('message_forwarded', {
      type: data.type,
      toAgents: true,
      by: socket.id
    });
  });

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
        
        const chatsResult = await pool.query("SELECT COUNT(*) as total FROM chats WHERE archived = FALSE");
        const archivedResult = await pool.query("SELECT COUNT(*) as total FROM chats WHERE archived = TRUE");
        const messagesResult = await pool.query("SELECT COUNT(*) as total FROM messages");
        const broadcastResult = await pool.query("SELECT COUNT(*) as total FROM messages WHERE is_broadcast = TRUE");
        
        socket.emit("super_admin_data", {
          agents: agentsList,
          activeChats: [],
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

  socket.on("agent_login", async ({ agentId, password, persistent }) => {
    console.log(`Agent login attempt: ${agentId} (persistent: ${persistent})`);
    
    try {
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
      
      if (agent.muted) {
        socket.emit("agent_login_response", {
          success: false,
          message: "Agent account is muted. Contact super admin."
        });
        return;
      }
      
      await pool.query(
        "UPDATE agents SET socket_id = $1, last_seen = NOW() WHERE id = $2",
        [socket.id, agentId]
      );
      
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
      
      socket.join(BROADCAST_ROOM);
      
      logActivity('agent_login', { 
        agentId, 
        name: agent.name, 
        socketId: socket.id,
        filename: agent.filename || 'no file'
      });
      
      // Send local broadcast messages
      const broadcastMessages = localMessages.getBroadcastMessages(100);
      broadcastMessages.forEach(msg => {
        socket.emit("broadcast_message", msg);
      });
      
      const userList = await getLocalUserList();
      socket.emit("user_list_with_read_receipts", userList);
      
      socket.emit("agent_login_response", {
        success: true,
        name: agent.name,
        muted: agent.muted || false,
        agentId: agentId,
        message: "Login successful"
      });
      
      console.log(`✅ Agent logged in: ${agentId} (${agent.name})`);
      
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

  socket.on("join_user_room", async ({ whatsapp }) => {
    const userData = users.get(socket.id);
    if (userData?.type !== 'agent') return;
    
    const agent = agents.get(userData.agentId);
    if (!agent) return;
    
    socket.join(whatsapp);
    agent.monitoringUser = whatsapp;
    
    const userMessages = localMessages.getUserMessages(whatsapp);
    userMessages.forEach(msg => {
      socket.emit("user_chat_history", {
        ...msg,
        whatsapp: whatsapp,
        isHistorical: true
      });
    });
    
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

  socket.on("agent_message", async (data) => {
    await handleAgentMessage(socket, data);
  });

  socket.on("user_message", async (data) => {
    await handleUserMessage(socket, data);
  });

  socket.on("message_read", async (data) => {
    try {
      const userData = users.get(socket.id);
      
      if (userData?.type !== 'agent') {
        console.log(`❌ Unauthorized read receipt attempt from ${socket.id} (type: ${userData?.type})`);
        return;
      }
      
      const { whatsapp, messageIds, timestamp } = data;
      
      if (!whatsapp || !messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
        console.error("Invalid read receipt data:", data);
        return;
      }
      
      console.log(`📖 Read receipt received for ${messageIds.length} messages in ${whatsapp}`);
      
      const updated = localMessages.markAsRead(whatsapp, messageIds);
      
      if (updated.length > 0) {
        const updateData = {
          whatsapp,
          messageIds: updated,
          timestamp: timestamp || new Date().toISOString(),
          read: true
        };
        
        io.to(whatsapp).emit("messages_read_update", updateData);
        io.to(BROADCAST_ROOM).emit("broadcast_messages_read_update", updateData);
        io.to("super_admin").to("admin").emit("messages_read_update", updateData);
        
        agents.forEach((agent, agentId) => {
          if (agent.socketId && agent.monitoringUser === whatsapp) {
            io.to(agent.socketId).emit("messages_read_update", updateData);
          }
        });
        
        console.log(`✅ Marked ${updated.length} message(s) as read`);
        
        logActivity('messages_marked_read', {
          whatsapp,
          messageCount: updated.length,
          messageIds: updated
        });
        
        updateUserListForAllAgents();
      }
      
      socket.emit("message_read_confirmation", {
        success: true,
        messageIds: updated,
        message: updated.length > 0 ? `Marked ${updated.length} message(s) as read` : "No new messages to mark as read"
      });
      
    } catch (error) {
      console.error("Error processing read receipt:", error);
      socket.emit("message_read_confirmation", {
        success: false,
        message: error.message
      });
    }
  });

  socket.on("get_user_list_with_read_receipts", async () => {
    try {
      const userData = users.get(socket.id);
      
      if (!userData || (userData.type !== 'agent' && userData.type !== 'super_admin' && userData.type !== 'admin')) {
        return;
      }
      
      const userList = await getLocalUserList();
      socket.emit("user_list_with_read_receipts", userList);
      
    } catch (error) {
      console.error("Error getting user list:", error);
      socket.emit("user_list_with_read_receipts", []);
    }
  });

  socket.on("admin_connect", async () => {
    console.log("✓ Admin connected:", socket.id);
    users.set(socket.id, { type: 'admin' });
    socket.join("admin");

    try {
      const broadcastMessages = localMessages.getBroadcastMessages();
      broadcastMessages.forEach(msg => {
        socket.emit("new_message", msg);
      });
      
      const userList = await getLocalUserList();
      socket.emit("user_list_with_read_receipts", userList);
      
    } catch (error) {
      console.error("Error sending messages to admin:", error);
    }
  });

  socket.on("register", async ({ whatsapp }) => {
    if (!whatsapp) return;
    users.set(socket.id, { whatsapp, type: 'user' });
    socket.join(whatsapp);
    socket.emit("registered", { success: true });
    console.log(`✓ Registered: ${whatsapp} with socket ${socket.id}`);
    
    updateUserListForAllAgents();
  });

  socket.on("get_messages", async ({ whatsapp, agentId, markAsRead = true }) => {
    try {
      const messages = localMessages.getUserMessages(whatsapp);
      
      if (markAsRead && agentId) {
        const unreadMessageIds = messages
          .filter(msg => msg.sender === "user" && !msg.read)
          .map(msg => msg.id);
        
        if (unreadMessageIds.length > 0) {
          const updated = localMessages.markAsRead(whatsapp, unreadMessageIds);
          if (updated.length > 0) {
            updateUserListForAllAgents();
          }
        }
      }
      
      socket.emit("message_history", messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      socket.emit("message_history", []);
    }
  });

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

  socket.on("get_broadcast_messages", async () => {
    try {
      const userData = users.get(socket.id);
      if (userData?.type === 'agent' || userData?.type === 'super_admin' || userData?.type === 'admin') {
        const broadcastMessages = localMessages.getBroadcastMessages();
        socket.emit("broadcast_messages_history", broadcastMessages);
      }
    } catch (error) {
      console.error("Error fetching broadcast messages:", error);
      socket.emit("broadcast_messages_history", []);
    }
  });

  socket.on("delete_chat", async ({ whatsapp, archiveOnly = false }) => {
    try {
      const userData = users.get(socket.id);
      
      if (!userData || (userData.type !== 'super_admin' && userData.type !== 'admin')) {
        socket.emit("delete_chat_response", { 
          success: false, 
          message: "Unauthorized: Only admins can delete chats" 
        });
        return;
      }
      
      let success = false;
      if (archiveOnly) {
        await pool.query(`
          UPDATE chats 
          SET archived = TRUE, archived_at = NOW() 
          WHERE whatsapp = $1
        `, [whatsapp]);
        success = true;
      } else {
        await pool.query("DELETE FROM chats WHERE whatsapp = $1", [whatsapp]);
        success = true;
      }
      
      if (success) {
        io.emit(archiveOnly ? "chat_archived" : "chat_deleted", { whatsapp });
        socket.emit("delete_chat_response", { 
          success: true, 
          message: archiveOnly ? "Chat archived successfully" : "Chat deleted permanently" 
        });
        
        updateUserListForAllAgents();
        
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

  socket.on("delete_message", async ({ whatsapp, messageId, deleteForAll = false }) => {
    try {
      const userData = users.get(socket.id);
      if (!userData) {
        socket.emit("delete_message_response", { success: false, message: "User not authenticated" });
        return;
      }
      
      const messages = localMessages.getUserMessages(whatsapp);
      const message = messages.find(m => m.id === messageId);
      
      if (!message) {
        socket.emit("delete_message_response", { success: false, message: "Message not found" });
        return;
      }
      
      let canDelete = false;
      
      if (deleteForAll || userData.type === 'super_admin' || userData.type === 'admin') {
        canDelete = true;
      } else if (userData.type === 'agent' && message.sender === "agent" && message.agentId === userData.agentId) {
        canDelete = true;
      }
      
      if (canDelete) {
        await pool.query("DELETE FROM messages WHERE id = $1", [messageId]);
        
        const userMessages = localMessages.userChats.get(whatsapp);
        if (userMessages) {
          const index = userMessages.findIndex(m => m.id === messageId);
          if (index !== -1) {
            userMessages.splice(index, 1);
          }
        }
        
        updateUserListForAllAgents();
        
        io.to(whatsapp).emit("message_deleted", { whatsapp, messageId });
        io.to("super_admin").to("admin").emit("message_deleted", { whatsapp, messageId });
        io.to(BROADCAST_ROOM).emit("broadcast_message_deleted", { messageId });
        
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

  socket.on("clear_chat", async ({ whatsapp }) => {
    try {
      await pool.query("DELETE FROM messages WHERE chat_whatsapp = $1", [whatsapp]);
      
      await pool.query(`
        UPDATE chats 
        SET last_message = NULL, last_message_time = NULL, last_updated = NOW()
        WHERE whatsapp = $1
      `, [whatsapp]);
      
      localMessages.userChats.delete(whatsapp);
      
      updateUserListForAllAgents();
      
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
        storageMode: "HYBRID: Local-first with 20-minute database sync",
        note: "Messages are instant, database syncs every 20 minutes"
      });
    } catch (error) {
      console.error("Error getting chat stats:", error);
    }
  });

  socket.on("disconnect", async () => {
    const user = users.get(socket.id);
    
    if (user) {
      if (user.type === 'agent' && user.agentId) {
        const agent = agents.get(user.agentId);
        if (agent) {
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
          agent.monitoringUser = null;
          console.log(`✗ Agent disconnected: ${agent.name} (${socket.id})`);
          
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

// ===== START SERVER =====
async function startServer() {
  const PORT = process.env.PORT || 3000;

  try {
    await initializeDatabase();
    await preRegisterDefaultAgents();
    await localMessages.initialize();
    
    startDatabaseSync();
    
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔐 Super Admin password: ${SUPER_ADMIN_PASSWORD}`);
      console.log(`📡 Broadcast Room: ${BROADCAST_ROOM}`);
      console.log(`✅ Pre-registered agents: agent1, agent2, agent3`);
      console.log(`⚡ HYBRID STORAGE MODE: Local-first with 20-minute database sync`);
      console.log(`💾 Database: albastxz_db1`);
      console.log(`🔄 Database sync every 20 minutes`);
      console.log(`✅ System is ready - No more message delays!`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();