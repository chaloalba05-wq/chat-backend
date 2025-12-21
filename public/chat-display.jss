// ===== ELEMENTS =====
const backBtn = document.querySelector('.back-button');
const chatView = document.querySelector('.chat-detail-view');
const messagesContainer = document.querySelector('.messages-container');
const scrollBtn = document.querySelector('.scroll-bottom-btn');
const sendBtn = document.querySelector('.send-btn');
const messageInput = document.querySelector('.message-input');

// ===== BACK BUTTON =====
backBtn.addEventListener('click', () => {
  chatView.classList.remove('active');
});

// ===== SCROLL BUTTON LOGIC =====
function checkScroll() {
  const threshold = 50; // px from bottom
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  scrollBtn.classList.toggle('visible', !atBottom);
}

messagesContainer.addEventListener('scroll', checkScroll);

scrollBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
});

// ===== AUTO-SCROLL TO BOTTOM =====
function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Scroll to bottom on load
scrollToBottom();

// ===== SEND MESSAGE =====
sendBtn.addEventListener('click', () => {
  const text = messageInput.value.trim();
  if (!text) return;

  const wrapper = document.createElement('div');
  wrapper.classList.add('message-wrapper');

  const bubble = document.createElement('div');
  bubble.classList.add('message-bubble', 'user-message');

  const meta = document.createElement('div');
  meta.classList.add('message-meta');
  meta.innerHTML = `<span class="message-sender">User</span><span class="message-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;

  const content = document.createElement('div');
  content.classList.add('message-content');
  content.textContent = text;

  bubble.appendChild(meta);
  bubble.appendChild(content);
  wrapper.appendChild(bubble);
  messagesContainer.appendChild(wrapper);

  messageInput.value = '';
  scrollToBottom();
});
