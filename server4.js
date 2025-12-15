const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config(); // load MONGO_URI from .env

// ---- MongoDB Setup ----
const uri = process.env.MONGO_URI || "mongodb+srv://chaloalba05_db_user:lam08Xnkf8v0zV3W@albastuzbackup.frhubzf.mongodb.net/chatDB?retryWrites=true&w=majority";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db;
async function connectDB() {
  try {
    await client.connect();
    db = client.db("chatDB"); // your database name
    console.log("MongoDB connected and ready to use");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
}
connectDB();

// ---- In-memory tracking ----
const users = new Map(); // socketId -> { whatsapp }

// ---- Setup server ----
const app = express();
const server = http.createServer(app);

// FIXED CORS configuration
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

// ---- Serve HTML files ----
app.use(express.static(path.join(__dirname, "public"))); 

app.get("/", (req, res) => res.send("Chat backend running"));
app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ---- MongoDB helper functions ----
async function saveMessage(whatsapp, message) {
  const chats = db.collection("chats");
  await chats.updateOne(
    { whatsappNumber: whatsapp },
    { $push: { messages: message } },
    { upsert: true }
  );
}

async function getMessages(whatsapp, sort = true) {
  const chats = db.collection("chats");
  const chat = await chats.findOne({ whatsappNumber: whatsapp });
  if (!chat) return [];
  if (sort) {
    return chat.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }
  return chat.messages;
}

// ---- Socket.IO events ----
io.on("connection", (socket) => {
  console.log("Incoming connection from:", socket.id);

  // Admin connection
  socket.on("admin_connect", async () => {
    console.log("✓ Admin connected:", socket.id);
    socket.join("admin");

    const chats = db.collection("chats");
    const allChats = await chats.find({}).toArray();

    allChats.forEach(chat => {
      const sortedMessages = chat.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      sortedMessages.forEach(msg => socket.emit("new_message", msg));
    });
  });

  // Register user
  socket.on("register", async ({ whatsapp }) => {
    if (!whatsapp) return;

    users.set(socket.id, { whatsapp });

    const chats = db.collection("chats");
    const chatExists = await chats.findOne({ whatsappNumber: whatsapp });
    if (!chatExists) {
      await chats.insertOne({ whatsappNumber: whatsapp, messages: [] });
      console.log(`✓ New conversation started for: ${whatsapp}`);
    }

    socket.join(whatsapp);
    socket.emit("registered", { success: true });
    console.log(`✓ Registered: ${whatsapp} with socket ${socket.id}`);
  });

  // Send message
  socket.on("send_message", async ({ whatsapp, sender, text }) => {
    if (!whatsapp || !text) return;

    const message = {
      sender: sender || "user",
      whatsapp,
      text,
      timestamp: new Date().toISOString()
    };

    console.log(`\n📨 Message from ${message.sender} to ${whatsapp}: "${text}"`);

    await saveMessage(whatsapp, message);

    io.to(whatsapp).emit("new_message", message);

    if (sender !== "admin") {
      io.to("admin").emit("new_message", message);
    }
  });

  // Get message history
  socket.on("get_messages", async ({ whatsapp }) => {
    const msgs = await getMessages(whatsapp);
    socket.emit("message_history", msgs);
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`✗ Disconnected: ${user.whatsapp} (${socket.id})`);
    } else {
      console.log(`✗ Disconnected: ${socket.id} (admin or unregistered)`);
    }
    users.delete(socket.id);
  });
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
