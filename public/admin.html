<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Admin Chat</title>
  <style>
    body { font-family: Arial; margin: 20px; }
    #users { margin-bottom: 10px; width: 300px; padding: 5px; }
    #messages { border: 1px solid #ccc; height: 300px; overflow-y: auto; padding: 10px; margin-bottom: 10px; }
    input, button { padding: 8px; font-size: 14px; margin-top: 5px; }
    .message { margin: 5px 0; padding: 8px; border-radius: 5px; }
    .user-message { background-color: #e3f2fd; text-align: left; }
    .admin-message { background-color: #ffe0b2; text-align: right; }
    .info-message { background-color: #f0f0f0; color: #666; font-style: italic; text-align: center; }
    
    /* Password overlay styles */
    #passwordOverlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }
    
    #passwordContainer {
      background: white;
      padding: 30px;
      border-radius: 10px;
      box-shadow: 0 0 20px rgba(0, 0, 0, 0.3);
      text-align: center;
      max-width: 400px;
      width: 90%;
    }
    
    #passwordContainer h2 {
      margin-top: 0;
      color: #333;
    }
    
    #passwordInput {
      width: 100%;
      padding: 12px;
      margin: 15px 0;
      border: 1px solid #ddd;
      border-radius: 5px;
      font-size: 16px;
      box-sizing: border-box;
    }
    
    #passwordError {
      color: #d32f2f;
      margin: 10px 0;
      min-height: 20px;
    }
    
    #chatContainer {
      display: none;
    }
  </style>
</head>
<body>

<!-- Password overlay -->
<div id="passwordOverlay">
  <div id="passwordContainer">
    <h2>Admin Access Required</h2>
    <p>Please enter the admin password to continue:</p>
    <input type="password" id="passwordInput" placeholder="Enter password" autocomplete="off">
    <div id="passwordError"></div>
    <button onclick="checkPassword()" style="width: 100%; padding: 12px; background: #4CAF50; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer;">
      Access Admin Panel
    </button>
    <div style="margin-top: 15px; font-size: 12px; color: #666;">
      <em>Set your password in the admin panel code (line 127)</em>
    </div>
  </div>
</div>

<!-- Main chat container (hidden until authenticated) -->
<div id="chatContainer">
  <h3>Admin Chat Panel</h3>

  <div>
    <label>Select User (WhatsApp number):</label>
    <select id="users">
      <option value="">-- Select a user --</option>
    </select>
  </div>

  <div id="messages"></div>

  <div>
    <input id="messageInput" placeholder="Type your reply" style="width: 300px;">
    <button onclick="sendMessage()">Send</button>
  </div>
</div>

<script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
<script>
  // ===== PASSWORD CONFIGURATION =====
  // CHANGE THIS PASSWORD TO YOUR DESIRED PASSWORD
  const ADMIN_PASSWORD = "admin123"; // Change this to your desired password
  // ==================================
  
  // Password state
  let isAuthenticated = false;
  const passwordOverlay = document.getElementById('passwordOverlay');
  const chatContainer = document.getElementById('chatContainer');
  const passwordInput = document.getElementById('passwordInput');
  const passwordError = document.getElementById('passwordError');
  
  // Check if already authenticated (from session storage)
  function checkSavedAuth() {
    const savedAuth = sessionStorage.getItem('adminAuthenticated');
    if (savedAuth === 'true') {
      isAuthenticated = true;
      passwordOverlay.style.display = 'none';
      chatContainer.style.display = 'block';
      initializeChat();
    }
  }
  
  // Check entered password
  function checkPassword() {
    const enteredPassword = passwordInput.value.trim();
    
    if (enteredPassword === ADMIN_PASSWORD) {
      // Successful authentication
      isAuthenticated = true;
      sessionStorage.setItem('adminAuthenticated', 'true');
      passwordOverlay.style.display = 'none';
      chatContainer.style.display = 'block';
      passwordError.textContent = '';
      passwordInput.value = '';
      
      // Initialize the chat system
      initializeChat();
    } else {
      // Wrong password
      passwordError.textContent = 'Incorrect password. Please try again.';
      passwordInput.value = '';
      passwordInput.focus();
      
      // Shake animation for wrong password
      passwordInput.style.animation = 'shake 0.5s';
      setTimeout(() => {
        passwordInput.style.animation = '';
      }, 500);
    }
  }
  
  // Allow pressing Enter to submit password
  passwordInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      checkPassword();
    }
  });
  
  // Chat variables (will be initialized after authentication)
  let socket;
  let usersDropdown;
  let messagesDiv;
  let selectedUser = "";
  let allUsers = new Set();
  
  // Initialize chat system after authentication
  function initializeChat() {
    socket = io("https://chat-backend-p2b9.onrender.com");
    usersDropdown = document.getElementById("users");
    messagesDiv = document.getElementById("messages");
    
    // Identify as admin immediately
    socket.on("connect", () => {
      console.log("Connected as admin:", socket.id);
      socket.emit("admin_connect");
      addInfoMessage("Connected to server as admin");
    });

    // Listen for new messages from ALL users
    socket.on("new_message", (msg) => {
      console.log("New message received:", msg);
      
      // Add user to dropdown if not already there
      if (!allUsers.has(msg.whatsapp)) {
        allUsers.add(msg.whatsapp);
        addUserToDropdown(msg.whatsapp);
      }

      // Display message if this user is selected
      if (msg.whatsapp === selectedUser) {
        appendMessage(msg);
      } else {
        // Highlight this user in dropdown
        highlightUserInDropdown(msg.whatsapp);
        if (msg.sender !== "admin") {
          addNotification(msg);
        }
      }
    });

    // Receive message history
    socket.on("message_history", (messages) => {
      console.log("Message history received:", messages.length, "messages");
      messagesDiv.innerHTML = "";
      messages.forEach(msg => appendMessage(msg));
      if (messages.length === 0) {
        addInfoMessage("No previous messages with this user");
      }
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    });

    // Select a user
    usersDropdown.addEventListener("change", function() {
      const previousUser = selectedUser;
      selectedUser = this.value;
      console.log("Selected user:", selectedUser);
      
      // Remove highlight from previous user
      if (previousUser) {
        removeHighlightFromDropdown(previousUser);
      }
      
      // Clear messages and load history for selected user
      messagesDiv.innerHTML = "";
      if (selectedUser) {
        socket.emit("get_messages", { whatsapp: selectedUser });
        addInfoMessage(`Now chatting with: ${selectedUser}`);
      }
    });

    // Send message with Enter key
    document.getElementById("messageInput").addEventListener("keypress", function(e) {
      if (e.key === "Enter") sendMessage();
    });
  }

  function addUserToDropdown(whatsapp) {
    // Check if user already exists in dropdown
    const existing = Array.from(usersDropdown.options).find(opt => opt.value === whatsapp);
    if (!existing) {
      const option = document.createElement("option");
      option.value = whatsapp;
      option.textContent = whatsapp;
      option.id = `user-${whatsapp}`;
      usersDropdown.appendChild(option);
    }
  }

  function highlightUserInDropdown(whatsapp) {
    const option = document.getElementById(`user-${whatsapp}`);
    if (option && whatsapp !== selectedUser) {
      option.style.backgroundColor = '#ffeb3b';
      option.style.fontWeight = 'bold';
    }
  }

  function removeHighlightFromDropdown(whatsapp) {
    const option = document.getElementById(`user-${whatsapp}`);
    if (option) {
      option.style.backgroundColor = '';
      option.style.fontWeight = '';
    }
  }

  function appendMessage(msg) {
    const div = document.createElement("div");
    div.className = "message " + (msg.sender === "user" ? "user-message" : "admin-message");
    div.textContent = `${msg.sender === 'admin' ? 'You' : 'User'}: ${msg.text}`;
    div.title = new Date(msg.timestamp).toLocaleString();
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function addInfoMessage(text) {
    const div = document.createElement("div");
    div.className = "message info-message";
    div.textContent = text;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function addNotification(msg) {
    const div = document.createElement("div");
    div.className = "message info-message";
    div.textContent = `📨 New message from ${msg.whatsapp}: "${msg.text.substring(0, 30)}${msg.text.length > 30 ? '...' : ''}"`;
    div.style.cursor = 'pointer';
    div.onclick = () => {
      usersDropdown.value = msg.whatsapp;
      usersDropdown.dispatchEvent(new Event('change'));
    };
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function sendMessage() {
    if (!selectedUser) return alert("Select a user first");
    const text = document.getElementById("messageInput").value.trim();
    if (!text) return;

    const message = {
      whatsapp: selectedUser,
      sender: "admin",  // IMPORTANT: Send as "admin"
      text: text
    };

    console.log("Sending as admin:", message);
    socket.emit("send_message", message);
    document.getElementById("messageInput").value = "";
    
    // Immediately show the message in the chat
    appendMessage(message);
  }
  
  // Check for saved authentication on page load
  checkSavedAuth();
  
  // Focus password input on load
  passwordInput.focus();
  
  // Add shake animation for wrong password
  const style = document.createElement('style');
  style.textContent = `
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
      20%, 40%, 60%, 80% { transform: translateX(5px); }
    }
  `;
  document.head.appendChild(style);
</script>

</body>
</html>