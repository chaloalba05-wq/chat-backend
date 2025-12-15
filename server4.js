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

// ---- Serve static files ----
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---- CORS for Socket.IO ----
const io = new Server(server, {
  cors: {
    origin: ["https://chat-backend-p2b9.onrender.com", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST"]
  }
});

// ---- Test route ----
app.get("/", (req, res) => res.send("Chat backend running"));

// Optional explicit routes
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/user", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// ---- Socket.IO events ----
io.on("connection", (socket) => {
  console.log("Incoming connection from:", socket.id);

  // Admin joins
  socket.on("admin_connect", () => {
    console.log("✓ Admin connected:", socket.id);
    socket.join("admin");

    // Send all past conversations to admin
    conversations.forEach((messages) => {
      messages.forEach(msg => socket.emit("new_message", msg));
    });
  });

  // User registers
  socket.on("register", ({ whatsapp }) => {
    if (!whatsapp) return;

    users.set(socket.id, { whatsapp });

    // Initialize conversation
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

    console.log(`📨 Message from ${message.sender} to ${whatsapp}: "${text}"`);

    if (!conversations.has(whatsapp)) {
      conversations.set(whatsapp, []);
    }
    conversations.get(whatsapp).push(message);

    // Send to user room
    io.to(whatsapp).emit("new_message", message);

    // Send to admin room if not from admin
    if (sender !== "admin") {
      io.to("admin").emit("new_message", message);
    }
  });

  // Get message history
  socket.on("get_messages", ({ whatsapp }) => {
    const msgs = conversations.get(whatsapp) || [];
    socket.emit("message_history", msgs);
  });

  // Disconnect
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
