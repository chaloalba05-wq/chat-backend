// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// ---- In-memory storage ----
const users = new Map();          // socketId -> { whatsapp }
const conversations = new Map();  // whatsapp -> messages[]

// ---- Setup server ----
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// ---- Test route ----
app.get("/", (req, res) => res.send("Chat backend running"));

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

    // Initialize conversation if missing
    if (!conversations.has(whatsapp)) {
      conversations.set(whatsapp, []);
      console.log(`✓ New conversation started for: ${whatsapp}`);
    }

    socket.join(whatsapp);
    socket.emit("registered", { success: true });
    console.log(`✓ Registered: ${whatsapp} with socket ${socket.id}`);
    console.log(`  Active users in room ${whatsapp}:`, Array.from(io.sockets.adapter.rooms.get(whatsapp) || []));
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

    // Check who's in the room
    const room = io.sockets.adapter.rooms.get(whatsapp);
    console.log(`  Recipients in room ${whatsapp}:`, room ? Array.from(room) : 'None');
    
    // Send to user's room
    io.to(whatsapp).emit("new_message", message);
    console.log(`  ✓ Sent to room ${whatsapp}`);
    
    // Send to admin channel (unless sender is admin)
    if (sender !== "admin") {
      io.to("admin").emit("new_message", message);
      console.log(`  ✓ Forwarded to admin room`);
    } else {
      console.log(`  ✗ Not forwarded to admin (sender is admin)`);
    }

    console.log(`  Total messages for ${whatsapp}: ${conversations.get(whatsapp).length}`);
  });

  // Get message history
  socket.on("get_messages", ({ whatsapp }) => {
    const msgs = conversations.get(whatsapp) || [];
    socket.emit("message_history", msgs);
    console.log(`✓ Sent ${msgs.length} messages history to ${socket.id} for ${whatsapp}`);
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`✗ Disconnected: ${user.whatsapp} (${socket.id})`);
      
      // Remove user from their room (socket.io automatically does this)
      const room = io.sockets.adapter.rooms.get(user.whatsapp);
      if (room) {
        console.log(`  Remaining in room ${user.whatsapp}:`, Array.from(room));
      }
    } else {
      console.log(`✗ Disconnected: ${socket.id} (admin or unregistered)`);
    }
    users.delete(socket.id);
  });
});

// ---- Start server ----
const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));