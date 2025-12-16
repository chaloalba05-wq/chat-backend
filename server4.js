const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

// ---- In-memory storage ----
const users = new Map();          // socketId -> { whatsapp }
const conversations = new Map();  // whatsapp -> messages[]

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
app.use(express.static(path.join(__dirname, "public"))); // <-- serve public folder

app.get("/", (req, res) => res.send("Chat backend running"));

// Explicit routes for easy links
app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ---- Socket.IO events ----
io.on("connection", (socket) => {
  console.log("Incoming connection from:", socket.id);

  // Detect admin connection
  socket.on("admin_connect", () => {
    console.log("✓ Admin connected:", socket.id);
    socket.join("admin");

    // Send all past conversations to admin
    conversations.forEach((messages) => {
      messages.forEach(msg => socket.emit("new_message", msg));
    });
  });

  // Register user
  socket.on("register", ({ whatsapp }) => {
    if (!whatsapp) return;

    users.set(socket.id, { whatsapp });

    if (!conversations.has(whatsapp)) {
      conversations.set(whatsapp, []);
      console.log(`✓ New conversation started for: ${whatsapp}`);
    }

    socket.join(whatsapp);
    socket.emit("registered", { success: true });
    console.log(`✓ Registered: ${whatsapp} with socket ${socket.id}`);
  });

  // Send message
  socket.on("send_message", ({ whatsapp, sender, text }) => {
    if (!whatsapp || !text) return;

    const message = { 
      sender: sender || "user", 
      whatsapp, 
      text, 
      timestamp: new Date().toISOString() 
    };

    console.log(`\n📨 Message from ${message.sender} to ${whatsapp}: "${text}"`);

    if (!conversations.has(whatsapp)) {
      conversations.set(whatsapp, []);
    }

    conversations.get(whatsapp).push(message);

    // Send to user's room
    io.to(whatsapp).emit("new_message", message);
    
    // Send to admin channel (unless sender is admin)
    if (sender !== "admin") {
      io.to("admin").emit("new_message", message);
    }
  });

  // Get message history
  socket.on("get_messages", ({ whatsapp }) => {
    const msgs = conversations.get(whatsapp) || [];
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
