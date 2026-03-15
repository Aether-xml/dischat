// ===== GLOBALS =====
const socket = io(window.location.origin, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000
});

let currentUser = null;
let servers = [];
let friends = [];
let pendingRequests = [];
let dmContacts = [];

let activeServer = null;
let activeChannel = null;
let activeDMUser = null;
let activeView = 'welcome';

let typingTimeout = null;
let selectedMessageId = null;
let selectedMessageChannelId = null;
let membersSidebarVisible = true;
let isLoggedIn = false;
let loginDone = false;

// ===== SAFE EMIT =====
function safeEmit(event, dataOrCallback, maybeCallback) {
  let data, callback;
  if (typeof dataOrCallback === 'function') {
    data = undefined;
    callback = dataOrCallback;
  } else {
    data = dataOrCallback;
    callback = maybeCallback;
  }

  const doEmit = () => {
    if (data !== undefined && callback) {
      socket.emit(event, data, callback);
    } else if (data !== undefined) {
      socket.emit(event, data);
    } else if (callback) {
      socket.emit(event, callback);
    } else {
      socket.emit(event);
    }
  };

  if (!isLoggedIn) {
    let waited = 0;
    const waitInterval = setInterval(() => {
      waited += 100;
      if (isLoggedIn) {
        clearInterval(waitInterval);
        doEmit();
      } else if (waited >= 8000) {
        clearInterval(waitInterval);
        console.error(`❌ safeEmit zaman aşımı: ${event}`);
        if (callback) callback({ success: false, error: 'Oturum açılamadı, sayfayı yenileyin' });
      }
    }, 100);
    return;
  }

  doEmit();
}

// ===== LOGIN =====
function doLogin() {
  if (loginDone) return;
  loginDone = true;

  const savedPassword = sessionStorage.getItem('_p');
  if (!savedPassword || !currentUser || !currentUser.email) {
    console.error('❌ Kimlik bilgisi yok');
    sessionStorage.clear();
    window.location.href = '/';
    return;
  }

  console.log('🔑 Login yapılıyor:', currentUser.email);

  socket.emit('login', { email: currentUser.email, password: savedPassword }, (response) => {
    if (!response) {
      console.error('❌ Sunucudan cevap gelmedi');
      loginDone = false;
      return;
    }

    if (response.success) {
      isLoggedIn = true;
      currentUser = response.user;
      servers = response.servers || [];
      friends = response.friends || [];
      pendingRequests = response.pendingRequests || [];
      dmContacts = response.dmContacts || [];

      renderUserPanel();
      renderServerList();
      renderDMContacts();
      updatePendingBadge();
      document.getElementById('welcomeName').textContent = currentUser.username;

      console.log('✅ Login başarılı:', currentUser.username);
    } else {
      console.error('❌ Login hatası:', response.error);
      loginDone = false;
      if (response.error && (response.error.includes('Şifre') || response.error.includes('bulunamadı'))) {
        sessionStorage.clear();
        window.location.href = '/';
      }
    }
  });
}

// ===== INIT =====
function initApp() {
  const userData = sessionStorage.getItem('user');
  const savedPassword = sessionStorage.getItem('_p');

  if (!userData || !savedPassword) {
    window.location.href = '/';
    return;
  }

  currentUser = JSON.parse(userData);

  setupInputListeners();
  setupSocketListeners();
  setupGlobalListeners();
  initEmojiPicker();

  renderUserPanel();
  document.getElementById('welcomeName').textContent = currentUser.username;

  socket.on('connect', () => {
    console.log('🟢 Socket bağlandı:', socket.id);
    loginDone = false;
    isLoggedIn = false;
    doLogin();
  });

  if (socket.connected) {
    loginDone = false;
    isLoggedIn = false;
    doLogin();
  }
}

initApp();

// ===== DISCONNECT & RECONNECT =====
socket.on('disconnect', (reason) => {
  console.log('🔴 Bağlantı koptu:', reason);
  isLoggedIn = false;
  loginDone = false;
  if (reason !== 'io client disconnect') {
    showToast('Bağlantı koptu, yeniden bağlanılıyor...', 'error');
  }
});

socket.io.on('reconnect_attempt', (attempt) => {
  console.log(`🔄 Reconnect denemesi: ${attempt}`);
});

socket.io.on('reconnect_failed', () => {
  showToast('Bağlantı kurulamadı. Sayfayı yenileyin.', 'error');
});

// ===== RENDER FUNCTIONS =====
function renderUserPanel() {
  if (!currentUser) return;
  const avatar = document.getElementById('userAvatar');
  avatar.textContent = currentUser.username.charAt(0).toUpperCase();
  avatar.style.background = getAvatarColor(currentUser.username);

  document.getElementById('userName').textContent = currentUser.username;
  document.getElementById('userStatusText').textContent = getStatusText(currentUser.status || 'online');

  const dot = document.getElementById('userStatusDot');
  dot.className = 'status-dot ' + (currentUser.status === 'online' ? '' : (currentUser.status || ''));
}

function renderServerList() {
  const container = document.getElementById('serverList');
  container.innerHTML = '';

  servers.forEach(server => {
    const div = document.createElement('div');
    div.className = `server-icon ${activeServer?.id === server.id ? 'active' : ''}`;
    div.title = server.name;
    div.onclick = () => selectServer(server);

    const initial = document.createElement('span');
    initial.className = 'server-initial';
    initial.textContent = server.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    div.appendChild(initial);

    container.appendChild(div);
  });
}

function renderChannelList(server) {
  const container = document.getElementById('channelList');
  container.innerHTML = '';

  server.channels.forEach(channel => {
    const div = document.createElement('div');
    div.className = `channel-item ${activeChannel?.id === channel.id ? 'active' : ''}`;
    div.onclick = () => selectChannel(channel);

    div.innerHTML = `
      <i class="fas fa-hashtag"></i>
      <span>${escapeHtml(channel.name)}</span>
    `;
    container.appendChild(div);
  });
}

function renderMembers(members) {
  const container = document.getElementById('membersList');
  container.innerHTML = '';

  const online = members.filter(m => m.status !== 'offline');
  const offline = members.filter(m => m.status === 'offline');

  if (online.length > 0) {
    const header = document.createElement('div');
    header.className = 'member-role-header';
    header.textContent = `ÇEVRİMİÇİ — ${online.length}`;
    container.appendChild(header);
    online.forEach(m => container.appendChild(createMemberElement(m)));
  }

  if (offline.length > 0) {
    const header = document.createElement('div');
    header.className = 'member-role-header';
    header.textContent = `ÇEVRİMDIŞI — ${offline.length}`;
    container.appendChild(header);
    offline.forEach(m => container.appendChild(createMemberElement(m)));
  }
}

function createMemberElement(member) {
  const div = document.createElement('div');
  div.className = 'member-item';
  div.onclick = () => openDM(member);

  const roleClass = member.role === 'owner' ? 'owner' : member.role === 'admin' ? 'admin' : '';
  const statusColor = getStatusColor(member.status);

  div.innerHTML = `
    <div class="member-avatar">
      <div class="avatar-display" style="background: ${getAvatarColor(member.username)}">
        ${member.username.charAt(0).toUpperCase()}
      </div>
      <div class="member-status" style="background: ${statusColor}"></div>
    </div>
    <div class="member-info">
      <span class="member-name ${roleClass}">${escapeHtml(member.username)}</span>
      ${member.custom_status ? `<span class="member-custom-status">${escapeHtml(member.custom_status)}</span>` : ''}
    </div>
  `;
  return div;
}

function renderDMContacts() {
  const container = document.getElementById('dmContactList');
  container.innerHTML = '';

  dmContacts.forEach(contact => {
    const div = document.createElement('div');
    div.className = `dm-contact-item ${activeDMUser?.id === contact.contact_id ? 'active' : ''}`;
    div.onclick = () => openDM({
      id: contact.contact_id,
      username: contact.username,
      avatar: contact.avatar,
      status: contact.status
    });

    div.innerHTML = `
      <div class="dm-contact-avatar">
        <div style="background: ${getAvatarColor(contact.username)}; width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; color:#fff;">
          ${contact.username.charAt(0).toUpperCase()}
        </div>
      </div>
      <span class="dm-contact-name">${escapeHtml(contact.username)}</span>
    `;
    container.appendChild(div);
  });
}

function renderMessages(messages, container, isDM = false) {
  const list = document.getElementById(container);
  list.innerHTML = '';

  let lastAuthor = null;
  let lastTime = null;

  messages.forEach(msg => {
    const msgTime = new Date(msg.created_at);
    const sameAuthor = (msg.user_id || msg.sender_id) === lastAuthor;
    const withinTime = lastTime && (msgTime - lastTime) < 5 * 60 * 1000;
    const isGrouped = sameAuthor && withinTime;

    const div = createMessageElement(msg, isGrouped, isDM);
    list.appendChild(div);

    lastAuthor = msg.user_id || msg.sender_id;
    lastTime = msgTime;
  });

  const messagesContainer = document.getElementById(isDM ? 'dmMessagesContainer' : 'messagesContainer');
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function createMessageElement(msg, isGrouped, isDM = false) {
  const div = document.createElement('div');
  div.className = `message ${isGrouped ? '' : 'message-start'}`;
  div.dataset.messageId = msg.id;
  div.dataset.userId = msg.user_id || msg.sender_id;
  div.dataset.time = msg.created_at;

  const isOwn = (msg.user_id || msg.sender_id) === currentUser.id;

  let contentHtml = formatMessage(msg.content);
  if (msg.edited) contentHtml += ' <span class="edited-tag">(düzenlendi)</span>';
  if (msg.file_url) {
    if (/\.(jpg|jpeg|png|gif|webp)$/i.test(msg.file_url)) {
      contentHtml += `<br><img src="${msg.file_url}" class="message-image" onclick="window.open('${msg.file_url}')">`;
    } else {
      contentHtml += `<br><a href="${msg.file_url}" target="_blank"><i class="fas fa-file"></i> ${msg.file_url.split('/').pop()}</a>`;
    }
  }

  let reactionsHtml = '';
  if (msg.reactions && msg.reactions.length > 0) {
    const grouped = {};
    msg.reactions.forEach(r => {
      if (!grouped[r.emoji]) grouped[r.emoji] = [];
      grouped[r.emoji].push(r);
    });

    reactionsHtml = '<div class="message-reactions">';
    Object.entries(grouped).forEach(([emoji, reactions]) => {
      const isActive = reactions.some(r => r.user_id === currentUser.id);
      const chId = isDM ? '' : (activeChannel?.id || '');
      reactionsHtml += `<div class="reaction ${isActive ? 'active' : ''}" onclick="toggleReaction('${msg.id}','${emoji}','${chId}')"><span>${emoji}</span><span class="reaction-count">${reactions.length}</span></div>`;
    });
    reactionsHtml += '</div>';
  }

  div.innerHTML = `
    <div class="message-avatar" style="background: ${getAvatarColor(msg.username || '')}">
      ${(msg.username || '?').charAt(0).toUpperCase()}
    </div>
    <div class="message-body">
      <div class="message-header">
        <span class="message-author">${escapeHtml(msg.username || 'Bilinmeyen')}</span>
        <span class="message-timestamp">${formatTimestamp(msg.created_at)}</span>
      </div>
      <div class="message-content">${contentHtml}</div>
      ${reactionsHtml}
    </div>
    <div class="message-actions">
      ${isOwn ? `
        <button class="message-action-btn" onclick="startEditMessage('${msg.id}')" title="Düzenle"><i class="fas fa-edit"></i></button>
        <button class="message-action-btn" onclick="startDeleteMessage('${msg.id}','${isDM ? '' : (activeChannel?.id || '')}')" title="Sil"><i class="fas fa-trash"></i></button>
      ` : ''}
      <button class="message-action-btn" onclick="showReactionPicker('${msg.id}')" title="Tepki"><i class="fas fa-smile"></i></button>
    </div>
  `;

  div.addEventListener('contextmenu', (e) => showContextMenu(e, msg, isOwn));
  return div;
}

// ===== NAVIGATION =====
function showHome() {
  activeServer = null;
  activeChannel = null;
  activeDMUser = null;

  document.getElementById('homeBtn').classList.add('active');
  document.querySelectorAll('#serverList .server-icon').forEach(el => el.classList.remove('active'));
  document.getElementById('homeView').classList.remove('hidden');
  document.getElementById('serverView').classList.add('hidden');

  showView('welcome');
  renderServerList();
}

function selectServer(server) {
  activeServer = server;
  activeDMUser = null;

  document.getElementById('homeBtn').classList.remove('active');
  renderServerList();

  document.getElementById('homeView').classList.add('hidden');
  document.getElementById('serverView').classList.remove('hidden');
  document.getElementById('currentServerName').textContent = server.name;

  renderChannelList(server);
  renderMembers(server.members || []);

  if (server.channels.length > 0) {
    selectChannel(server.channels[0]);
  } else {
    showView('welcome');
  }
}

function selectChannel(channel) {
  activeChannel = channel;

  document.getElementById('chatTitle').textContent = channel.name;
  document.getElementById('chatTopic').textContent = channel.topic || '';
  document.getElementById('channelWelcomeTitle').textContent = channel.name;
  document.getElementById('messageInput').placeholder = `#${channel.name} kanalına mesaj gönder`;

  renderChannelList(activeServer);
  showView('chat');

  safeEmit('get-messages', { channelId: channel.id, limit: 50 }, (response) => {
    if (response.success) {
      renderMessages(response.messages, 'messagesList');
    }
  });
}

function showView(view) {
  activeView = view;
  document.getElementById('welcomeScreen').classList.add('hidden');
  document.getElementById('friendsView').classList.add('hidden');
  document.getElementById('chatView').classList.add('hidden');
  document.getElementById('dmChatView').classList.add('hidden');

  const membersSidebar = document.getElementById('membersSidebar');

  switch (view) {
    case 'welcome':
      document.getElementById('welcomeScreen').classList.remove('hidden');
      membersSidebar.classList.add('hidden');
      break;
    case 'friends':
      document.getElementById('friendsView').classList.remove('hidden');
      membersSidebar.classList.add('hidden');
      break;
    case 'chat':
      document.getElementById('chatView').classList.remove('hidden');
      if (membersSidebarVisible) membersSidebar.classList.remove('hidden');
      break;
    case 'dm':
      document.getElementById('dmChatView').classList.remove('hidden');
      membersSidebar.classList.add('hidden');
      break;
  }
}

// ===== FRIENDS =====
function showFriends(tab) {
  activeServer = null;
  activeChannel = null;

  document.getElementById('homeBtn').classList.add('active');
  document.querySelectorAll('#serverList .server-icon').forEach(el => el.classList.remove('active'));
  document.getElementById('homeView').classList.remove('hidden');
  document.getElementById('serverView').classList.add('hidden');

  showView('friends');

  document.querySelectorAll('.header-tabs .tab').forEach(t => t.classList.remove('active'));
  const tabEl = document.getElementById(`tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`);
  if (tabEl) tabEl.classList.add('active');

  const content = document.getElementById('friendsContent');

  switch (tab) {
    case 'all': renderFriendList(friends, content); break;
    case 'online': renderFriendList(friends.filter(f => f.status !== 'offline'), content); break;
    case 'pending': renderPendingRequests(content); break;
    case 'add': renderAddFriend(content); break;
  }

  document.getElementById('navFriends').classList.add('active');
  document.getElementById('navDMs').classList.remove('active');
}

function renderFriendList(friendList, container) {
  if (friendList.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-user-friends"></i>
        <h4>Arkadaş bulunamadı</h4>
        <p>Arkadaş eklemek için "Arkadaş Ekle" sekmesine git</p>
      </div>`;
    return;
  }

  container.innerHTML = `<div class="section-header"><span>TÜM ARKADAŞLAR — ${friendList.length}</span></div>`;

  friendList.forEach(friend => {
    const div = document.createElement('div');
    div.className = 'friend-item';
    div.innerHTML = `
      <div class="friend-avatar">
        <div class="avatar-display" style="background: ${getAvatarColor(friend.username)}">
          ${friend.username.charAt(0).toUpperCase()}
        </div>
        <div class="friend-status-dot" style="background: ${getStatusColor(friend.status)}"></div>
      </div>
      <div class="friend-info">
        <span class="friend-name">${escapeHtml(friend.username)}</span>
        <span class="friend-status">${getStatusText(friend.status)}</span>
      </div>
      <div class="friend-actions">
        <button class="message" title="Mesaj" onclick="openDM({id:'${friend.id}',username:'${escapeHtml(friend.username)}',status:'${friend.status || 'offline'}'})">
          <i class="fas fa-comment"></i>
        </button>
        <button class="reject" title="Arkadaşlıktan Çıkar" onclick="removeFriend('${friend.id}')">
          <i class="fas fa-user-minus"></i>
        </button>
      </div>`;
    container.appendChild(div);
  });
}

function renderPendingRequests(container) {
  if (pendingRequests.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-clock"></i>
        <h4>Bekleyen istek yok</h4>
        <p>Tüm arkadaşlık istekleri burada görünür</p>
      </div>`;
    return;
  }

  container.innerHTML = `<div class="section-header"><span>BEKLEYEN — ${pendingRequests.length}</span></div>`;

  pendingRequests.forEach(req => {
    const div = document.createElement('div');
    div.className = 'friend-item';
    div.innerHTML = `
      <div class="friend-avatar">
        <div class="avatar-display" style="background: ${getAvatarColor(req.username)}">
          ${req.username.charAt(0).toUpperCase()}
        </div>
      </div>
      <div class="friend-info">
        <span class="friend-name">${escapeHtml(req.username)}</span>
        <span class="friend-status">Gelen arkadaşlık isteği</span>
      </div>
      <div class="friend-actions">
        <button class="accept" title="Kabul Et" onclick="acceptFriend('${req.id}')"><i class="fas fa-check"></i></button>
        <button class="reject" title="Reddet" onclick="rejectFriend('${req.id}')"><i class="fas fa-times"></i></button>
      </div>`;
    container.appendChild(div);
  });
}

function renderAddFriend(container) {
  container.innerHTML = `
    <div class="add-friend-form">
      <h4>Arkadaş Ekle</h4>
      <p>Arkadaşlarını kullanıcı adlarıyla ekleyebilirsin.</p>
      <div class="add-friend-input-wrapper">
        <input type="text" id="addFriendInput" placeholder="Kullanıcı adını gir..." onkeydown="if(event.key==='Enter') sendFriendRequest()">
        <button onclick="sendFriendRequest()">İstek Gönder</button>
      </div>
    </div>`;
}

function sendFriendRequest() {
  const input = document.getElementById('addFriendInput');
  if (!input) return;
  const username = input.value.trim();
  if (!username) return showToast('Kullanıcı adı girin', 'error');

  safeEmit('send-friend-request', { username }, (response) => {
    if (response.success) {
      showToast('Arkadaşlık isteği gönderildi!', 'success');
      input.value = '';
    } else {
      showToast(response.error || 'İstek gönderilemedi', 'error');
    }
  });
}

function acceptFriend(friendId) {
  safeEmit('accept-friend-request', { friendId }, (response) => {
    if (response.success) {
      pendingRequests = pendingRequests.filter(r => r.id !== friendId);
      if (response.friend) friends.push(response.friend);
      updatePendingBadge();
      showFriends('pending');
      showToast('Arkadaşlık isteği kabul edildi!', 'success');
    }
  });
}

function rejectFriend(friendId) {
  safeEmit('reject-friend-request', { friendId }, (response) => {
    if (response.success) {
      pendingRequests = pendingRequests.filter(r => r.id !== friendId);
      updatePendingBadge();
      showFriends('pending');
    }
  });
}

function removeFriend(friendId) {
  if (!confirm('Bu arkadaşı silmek istediğine emin misin?')) return;
  safeEmit('remove-friend', { friendId }, (response) => {
    if (response.success) {
      friends = friends.filter(f => f.id !== friendId);
      showFriends('all');
      showToast('Arkadaş silindi', 'info');
    }
  });
}

function updatePendingBadge() {
  const badge = document.getElementById('pendingBadge');
  if (!badge) return;
  if (pendingRequests.length > 0) {
    badge.textContent = pendingRequests.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ===== DIRECT MESSAGES =====
function openDM(user) {
  if (!user || !user.id) return;
  activeDMUser = user;
  activeServer = null;
  activeChannel = null;

  document.getElementById('homeBtn').classList.add('active');
  document.querySelectorAll('#serverList .server-icon').forEach(el => el.classList.remove('active'));
  document.getElementById('homeView').classList.remove('hidden');
  document.getElementById('serverView').classList.add('hidden');

  document.getElementById('dmChatTitle').textContent = user.username;
  document.getElementById('dmWelcomeTitle').textContent = user.username;
  document.getElementById('dmMessageInput').placeholder = `@${user.username} kullanıcısına mesaj gönder`;

  const avatar = document.getElementById('dmWelcomeAvatar');
  avatar.textContent = user.username.charAt(0).toUpperCase();
  avatar.style.background = getAvatarColor(user.username);

  showView('dm');

  document.getElementById('navFriends').classList.remove('active');
  document.getElementById('navDMs').classList.add('active');
  renderDMContacts();

  safeEmit('get-dms', { userId: user.id, limit: 50 }, (response) => {
    if (response.success) {
      renderMessages(response.messages, 'dmMessagesList', true);
    }
  });
}

function showDMList() {
  document.getElementById('navFriends').classList.remove('active');
  document.getElementById('navDMs').classList.add('active');

  safeEmit('get-dm-contacts', (response) => {
    if (response.success) {
      dmContacts = response.contacts;
      renderDMContacts();
    }
  });
}

// ===== SERVERS =====
function showServerModal() {
  document.getElementById('serverModal').classList.remove('hidden');
  switchServerModalTab('create');
}

function showJoinModal() {
  document.getElementById('serverModal').classList.remove('hidden');
  switchServerModalTab('join');
}

function switchServerModalTab(tab) {
  document.querySelectorAll('#serverModalTabs .modal-tab').forEach(t => t.classList.remove('active'));
  if (tab === 'create') {
    document.querySelectorAll('#serverModalTabs .modal-tab')[0].classList.add('active');
    document.getElementById('createServerForm').classList.remove('hidden');
    document.getElementById('joinServerForm').classList.add('hidden');
  } else {
    document.querySelectorAll('#serverModalTabs .modal-tab')[1].classList.add('active');
    document.getElementById('createServerForm').classList.add('hidden');
    document.getElementById('joinServerForm').classList.remove('hidden');
  }
}

function createServer() {
  const name = document.getElementById('newServerName').value.trim();
  if (!name) return showToast('Sunucu adı gerekli', 'error');

  safeEmit('create-server', { name }, (response) => {
    if (response.success) {
      servers.push(response.server);
      renderServerList();
      selectServer(response.server);
      closeModal('serverModal');
      document.getElementById('newServerName').value = '';
      showToast('Sunucu oluşturuldu!', 'success');
    } else {
      showToast(response.error || 'Sunucu oluşturulamadı', 'error');
    }
  });
}

function joinServer() {
  const code = document.getElementById('inviteCodeInput').value.trim().replace(/\s+/g, '');
  if (!code) return showToast('Davet kodu gerekli', 'error');

  safeEmit('join-server', { inviteCode: code }, (response) => {
    if (response.success) {
      servers.push(response.server);
      renderServerList();
      selectServer(response.server);
      closeModal('serverModal');
      document.getElementById('inviteCodeInput').value = '';
      showToast(`"${response.server.name}" sunucusuna katıldın!`, 'success');
    } else {
      showToast(response.error || 'Sunucuya katılınamadı', 'error');
    }
  });
}

function showInviteModal() {
  if (!activeServer) return;
  const serverData = servers.find(s => s.id === activeServer.id);
  const code = serverData ? serverData.invite_code : activeServer.invite_code;
  document.getElementById('inviteCodeDisplay').value = code || '';
  document.getElementById('inviteModal').classList.remove('hidden');
  closeServerMenu();
}

function copyInviteCode() {
  const input = document.getElementById('inviteCodeDisplay');
  const code = input.value;
  if (!code) return showToast('Davet kodu bulunamadı', 'error');

  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.innerHTML = '<i class="fas fa-check"></i> Kopyalandı!';
    showToast('Davet kodu kopyalandı: ' + code, 'success');
    setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i> Kopyala'; }, 3000);
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    showToast('Kopyalandı!', 'success');
  });
}

function handleLeaveServer() {
  if (!activeServer) return;
  if (!confirm(`"${activeServer.name}" sunucusundan ayrılmak istediğine emin misin?`)) return;

  safeEmit('leave-server', { serverId: activeServer.id }, (response) => {
    if (response.success) {
      servers = servers.filter(s => s.id !== activeServer.id);
      renderServerList();
      showHome();
      showToast('Sunucudan ayrıldın', 'info');
    }
  });
  closeServerMenu();
}

// ===== CHANNELS =====
function showCreateChannelModal() {
  document.getElementById('channelModal').classList.remove('hidden');
  closeServerMenu();
}

function createChannel() {
  if (!activeServer) return;
  const name = document.getElementById('newChannelName').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return showToast('Kanal adı gerekli', 'error');

  safeEmit('create-channel', { serverId: activeServer.id, name }, (response) => {
    if (response.success) {
      activeServer.channels.push(response.channel);
      renderChannelList(activeServer);
      selectChannel(response.channel);
      closeModal('channelModal');
      document.getElementById('newChannelName').value = '';
      showToast('Kanal oluşturuldu!', 'success');
    } else {
      showToast(response.error || 'Kanal oluşturulamadı', 'error');
    }
  });
}

// ===== MESSAGING =====
function sendCurrentMessage() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if (!content || !activeChannel) return;

  safeEmit('send-message', { channelId: activeChannel.id, content }, (response) => {
    if (response.success) {
      input.value = '';
      input.style.height = 'auto';
      socket.emit('typing-stop', { channelId: activeChannel.id });
    } else {
      showToast(response.error || 'Mesaj gönderilemedi', 'error');
    }
  });
}

function sendCurrentDM() {
  const input = document.getElementById('dmMessageInput');
  const content = input.value.trim();
  if (!content || !activeDMUser) return;

  safeEmit('send-dm', { receiverId: activeDMUser.id, content }, (response) => {
    if (response.success) {
      input.value = '';
      input.style.height = 'auto';
      const existing = dmContacts.find(c => c.contact_id === activeDMUser.id);
      if (!existing) {
        dmContacts.unshift({ contact_id: activeDMUser.id, username: activeDMUser.username, status: activeDMUser.status });
        renderDMContacts();
      }
    } else {
      showToast(response.error || 'Mesaj gönderilemedi', 'error');
    }
  });
}

function startEditMessage(messageId) {
  const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!msgEl) return;

  const contentEl = msgEl.querySelector('.message-content');
  const currentContent = contentEl.innerText.replace('(düzenlendi)', '').trim();

  contentEl.innerHTML = `
    <input type="text" class="edit-input" value="${escapeHtml(currentContent)}"
      style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--brand-color);border-radius:4px;color:var(--text-normal);font-size:15px;font-family:'Inter',sans-serif;outline:none;">
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">ESC iptal • Enter kaydet</div>
  `;

  const editInput = contentEl.querySelector('.edit-input');
  editInput.focus();
  editInput.setSelectionRange(editInput.value.length, editInput.value.length);

  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const newContent = editInput.value.trim();
      if (newContent && newContent !== currentContent && activeChannel) {
        safeEmit('edit-message', { messageId, channelId: activeChannel.id, content: newContent }, () => {});
      }
      contentEl.textContent = newContent || currentContent;
    } else if (e.key === 'Escape') {
      contentEl.textContent = currentContent;
    }
  });
}

function startDeleteMessage(messageId, channelId) {
  if (!confirm('Bu mesajı silmek istediğine emin misin?')) return;
  if (channelId) {
    safeEmit('delete-message', { messageId, channelId }, () => {});
  }
}

function toggleReaction(messageId, emoji, channelId) {
  const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!msgEl) return;
  const reactionEl = msgEl.querySelector(`.reaction`);
  const isActive = reactionEl && reactionEl.classList.contains('active');

  if (isActive) {
    socket.emit('remove-reaction', { messageId, channelId, emoji });
  } else {
    socket.emit('add-reaction', { messageId, channelId, emoji });
  }
}

function showReactionPicker(messageId) {
  selectedMessageId = messageId;
  const picker = document.getElementById('emojiPicker');
  picker.classList.toggle('hidden');
  picker.dataset.targetMessage = messageId;
}

// ===== INPUT LISTENERS =====
function setupInputListeners() {
  const msgInput = document.getElementById('messageInput');
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrentMessage();
    }
  });

  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 200) + 'px';
    if (activeChannel) {
      socket.emit('typing-start', { channelId: activeChannel.id });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        socket.emit('typing-stop', { channelId: activeChannel.id });
      }, 3000);
    }
  });

  const dmInput = document.getElementById('dmMessageInput');
  dmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrentDM();
    }
  });

  dmInput.addEventListener('input', () => {
    dmInput.style.height = 'auto';
    dmInput.style.height = Math.min(dmInput.scrollHeight, 200) + 'px';
  });

  document.getElementById('fileInput').addEventListener('change', handleFileUpload);
  document.getElementById('dmFileInput').addEventListener('change', handleDMFileUpload);

  // Search input
  document.getElementById('searchUserInput').addEventListener('input', searchUsers);

  // Enter to join/create
  document.getElementById('newServerName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createServer();
  });
  document.getElementById('inviteCodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinServer();
  });
  document.getElementById('newChannelName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createChannel();
  });
}

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file || !activeChannel) return;
  const formData = new FormData();
  formData.append('file', file);
  fetch('/api/upload', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(data => {
      if (data.url) safeEmit('send-message', { channelId: activeChannel.id, content: file.name, type: 'file', fileUrl: data.url }, () => {});
    })
    .catch(() => showToast('Dosya yükleme başarısız', 'error'));
  e.target.value = '';
}

function handleDMFileUpload(e) {
  const file = e.target.files[0];
  if (!file || !activeDMUser) return;
  const formData = new FormData();
  formData.append('file', file);
  fetch('/api/upload', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(data => {
      if (data.url) safeEmit('send-dm', { receiverId: activeDMUser.id, content: file.name, type: 'file', fileUrl: data.url }, () => {});
    });
  e.target.value = '';
}

// ===== SOCKET LISTENERS =====
function setupSocketListeners() {
  socket.on('new-message', (data) => {
    if (activeChannel && data.channelId === activeChannel.id) {
      appendMessage(data.message, 'messagesList');
    }
  });

  socket.on('new-dm', (data) => {
    if (activeDMUser && data.senderId === activeDMUser.id) {
      appendMessage(data.message, 'dmMessagesList', true);
    }
    safeEmit('get-dm-contacts', (response) => {
      if (response.success) { dmContacts = response.contacts; renderDMContacts(); }
    });
  });

  socket.on('message-edited', (data) => {
    if (activeChannel && data.channelId === activeChannel.id) {
      const msgEl = document.querySelector(`[data-message-id="${data.message.id}"]`);
      if (msgEl) {
        const contentEl = msgEl.querySelector('.message-content');
        contentEl.innerHTML = formatMessage(data.message.content) + ' <span class="edited-tag">(düzenlendi)</span>';
      }
    }
  });

  socket.on('message-deleted', (data) => {
    const msgEl = document.querySelector(`[data-message-id="${data.messageId}"]`);
    if (msgEl) msgEl.remove();
  });

  socket.on('reaction-added', (data) => {
    if (activeChannel && data.channelId === activeChannel.id) {
      safeEmit('get-messages', { channelId: activeChannel.id }, (response) => {
        if (response.success) renderMessages(response.messages, 'messagesList');
      });
    }
  });

  socket.on('reaction-removed', (data) => {
    if (activeChannel && data.channelId === activeChannel.id) {
      safeEmit('get-messages', { channelId: activeChannel.id }, (response) => {
        if (response.success) renderMessages(response.messages, 'messagesList');
      });
    }
  });

  socket.on('user-typing', (data) => {
    if (activeChannel && data.channelId === activeChannel.id) {
      document.getElementById('typingText').textContent = `${data.username} yazıyor...`;
      document.getElementById('typingIndicator').classList.remove('hidden');
    }
  });

  socket.on('user-stopped-typing', (data) => {
    if (activeChannel && data.channelId === activeChannel.id) {
      document.getElementById('typingIndicator').classList.add('hidden');
    }
  });

  socket.on('member-joined', (data) => {
    if (activeServer && data.serverId === activeServer.id) {
      if (!activeServer.members.find(m => m.id === data.member.id)) {
        activeServer.members.push(data.member);
        renderMembers(activeServer.members);
        showToast(`${data.member.username} sunucuya katıldı!`, 'info');
      }
    }
  });

  socket.on('member-left', (data) => {
    if (activeServer && data.serverId === activeServer.id) {
      activeServer.members = activeServer.members.filter(m => m.id !== data.userId);
      renderMembers(activeServer.members);
    }
  });

  socket.on('member-status-changed', (data) => {
    if (activeServer && data.serverId === activeServer.id) {
      const member = activeServer.members.find(m => m.id === data.userId);
      if (member) { member.status = data.status; renderMembers(activeServer.members); }
    }
  });

  socket.on('member-updated', (data) => {
    if (activeServer && data.serverId === activeServer.id) {
      const member = activeServer.members.find(m => m.id === data.member.id);
      if (member) { Object.assign(member, data.member); renderMembers(activeServer.members); }
    }
  });

  socket.on('channel-created', (data) => {
    if (activeServer && data.serverId === activeServer.id) {
      if (!activeServer.channels.find(c => c.id === data.channel.id)) {
        activeServer.channels.push(data.channel);
        renderChannelList(activeServer);
      }
    }
  });

  socket.on('channel-deleted', (data) => {
    if (activeServer && data.serverId === activeServer.id) {
      activeServer.channels = activeServer.channels.filter(c => c.id !== data.channelId);
      renderChannelList(activeServer);
      if (activeChannel?.id === data.channelId) {
        activeChannel = null;
        if (activeServer.channels.length > 0) selectChannel(activeServer.channels[0]);
        else showView('welcome');
      }
    }
  });

  socket.on('server-deleted', (data) => {
    servers = servers.filter(s => s.id !== data.serverId);
    renderServerList();
    if (activeServer?.id === data.serverId) showHome();
    showToast('Sunucu silindi', 'info');
  });

  socket.on('friend-request-received', (data) => {
    pendingRequests.push(data);
    updatePendingBadge();
    showToast(`${data.username} sana arkadaşlık isteği gönderdi!`, 'info');
  });

  socket.on('friend-request-accepted', (data) => {
    friends.push(data);
    showToast(`${data.username} arkadaşlık isteğini kabul etti!`, 'success');
  });

  socket.on('friend-online', (data) => {
    const friend = friends.find(f => f.id === data.userId);
    if (friend) friend.status = 'online';
  });

  socket.on('friend-offline', (data) => {
    const friend = friends.find(f => f.id === data.userId);
    if (friend) friend.status = 'offline';
  });
}

function appendMessage(msg, containerId, isDM = false) {
  const list = document.getElementById(containerId);
  if (!list) return;

  const messagesContainer = document.getElementById(isDM ? 'dmMessagesContainer' : 'messagesContainer');
  const isAtBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 150;

  const lastMsg = list.lastElementChild;
  const sameAuthor = lastMsg && lastMsg.dataset.userId === (msg.user_id || msg.sender_id);
  const withinTime = lastMsg && (Date.now() - new Date(lastMsg.dataset.time || 0)) < 5 * 60 * 1000;
  const isGrouped = sameAuthor && withinTime;

  const div = createMessageElement(msg, isGrouped, isDM);
  list.appendChild(div);

  if (isAtBottom) messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ===== GLOBAL LISTENERS =====
function setupGlobalListeners() {
  document.getElementById('homeBtn').addEventListener('click', showHome);
  document.getElementById('addServerBtn').addEventListener('click', showServerModal);
  document.getElementById('navFriends').addEventListener('click', () => showFriends('all'));
  document.getElementById('navDMs').addEventListener('click', showDMList);
  document.getElementById('newDMBtn').addEventListener('click', showSearchModal);
  document.getElementById('searchBarBtn').addEventListener('click', showSearchModal);
  document.getElementById('serverDropdownBtn').addEventListener('click', toggleServerMenu);
  document.getElementById('inviteBtn').addEventListener('click', showInviteModal);
  document.getElementById('createChannelBtn').addEventListener('click', showCreateChannelModal);
  document.getElementById('createChannelBtn2').addEventListener('click', showCreateChannelModal);
  document.getElementById('leaveServerBtn').addEventListener('click', handleLeaveServer);
  document.getElementById('statusMenuBtn').addEventListener('click', toggleStatusMenu);
  document.getElementById('settingsBtn').addEventListener('click', showSettingsModal);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('toggleMembersBtn').addEventListener('click', toggleMemberSidebar);
  document.getElementById('pinnedBtn').addEventListener('click', showPinnedMessages);
  document.getElementById('fileUploadBtn').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('dmFileUploadBtn').addEventListener('click', () => document.getElementById('dmFileInput').click());
  document.getElementById('emojiBtn').addEventListener('click', toggleEmojiPicker);
  document.getElementById('dmEmojiBtn').addEventListener('click', toggleEmojiPicker);
  document.getElementById('sendMsgBtn').addEventListener('click', sendCurrentMessage);
  document.getElementById('sendDMBtn').addEventListener('click', sendCurrentDM);
  document.getElementById('copyBtn').addEventListener('click', copyInviteCode);
  document.getElementById('createServerBtn').addEventListener('click', createServer);
  document.getElementById('joinServerBtn').addEventListener('click', joinServer);
  document.getElementById('createChannelConfirmBtn').addEventListener('click', createChannel);
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  document.getElementById('ctxEdit').addEventListener('click', editSelectedMessage);
  document.getElementById('ctxDelete').addEventListener('click', deleteSelectedMessage);
  document.getElementById('ctxCopy').addEventListener('click', copyMessageContent);

  // Welcome butonları
  document.getElementById('welcomeCreateBtn').addEventListener('click', showServerModal);
  document.getElementById('welcomeJoinBtn').addEventListener('click', showJoinModal);

  // Modal tab butonları
  document.querySelectorAll('#serverModalTabs .modal-tab').forEach((tab, i) => {
    tab.addEventListener('click', () => switchServerModalTab(i === 0 ? 'create' : 'join'));
  });

  // Status seçenekleri
  document.querySelectorAll('.status-option[data-status]').forEach(opt => {
    opt.addEventListener('click', () => changeStatus(opt.dataset.status));
  });

  // Modal kapatma butonları
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.modal-overlay').classList.add('hidden');
    });
  });

  // Arkadaş sekme butonları
  document.getElementById('tabAll').addEventListener('click', () => showFriends('all'));
  document.getElementById('tabOnline').addEventListener('click', () => showFriends('online'));
  document.getElementById('tabPending').addEventListener('click', () => showFriends('pending'));
  document.getElementById('tabAdd').addEventListener('click', () => showFriends('add'));

  // Dışarı tıklayınca kapat
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.server-dropdown') && !e.target.closest('#serverDropdownBtn')) closeServerMenu();
    if (!e.target.closest('.status-menu') && !e.target.closest('#statusMenuBtn')) document.getElementById('statusMenu').classList.add('hidden');
    if (!e.target.closest('.emoji-picker') && !e.target.closest('#emojiBtn') && !e.target.closest('#dmEmojiBtn') && !e.target.closest('.message-action-btn')) document.getElementById('emojiPicker').classList.add('hidden');
    if (!e.target.closest('.context-menu')) document.getElementById('contextMenu').classList.add('hidden');
  });

  // Modal overlay tıklama
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  // ESC tuşu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
      document.getElementById('emojiPicker').classList.add('hidden');
      document.getElementById('contextMenu').classList.add('hidden');
    }
  });

  // Clear file preview
  const clearFileBtn = document.getElementById('clearFileBtn');
  if (clearFileBtn) clearFileBtn.addEventListener('click', clearFilePreview);
}

// ===== UI HELPERS =====
function toggleServerMenu() { document.getElementById('serverDropdown').classList.toggle('hidden'); }
function closeServerMenu() { document.getElementById('serverDropdown').classList.add('hidden'); }
function toggleStatusMenu() { document.getElementById('statusMenu').classList.toggle('hidden'); }

function changeStatus(status) {
  currentUser.status = status;
  safeEmit('update-status', { status }, () => {});
  renderUserPanel();
  document.getElementById('statusMenu').classList.add('hidden');
}

function toggleMemberSidebar() {
  membersSidebarVisible = !membersSidebarVisible;
  document.getElementById('membersSidebar').classList.toggle('hidden');
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function showSettingsModal() {
  document.getElementById('settingsUsername').value = currentUser.username;
  document.getElementById('settingsCustomStatus').value = currentUser.custom_status || '';
  document.getElementById('settingsModal').classList.remove('hidden');
}

function saveSettings() {
  const username = document.getElementById('settingsUsername').value.trim();
  const customStatus = document.getElementById('settingsCustomStatus').value.trim();
  safeEmit('update-profile', { username, custom_status: customStatus }, (response) => {
    if (response.success) {
      currentUser = response.user;
      renderUserPanel();
      closeModal('settingsModal');
      showToast('Profil güncellendi!', 'success');
    } else {
      showToast(response.error || 'Güncellenemedi', 'error');
    }
  });
}

function showSearchModal() {
  document.getElementById('searchModal').classList.remove('hidden');
  document.getElementById('searchUserInput').value = '';
  document.getElementById('searchResults').innerHTML = '';
  setTimeout(() => document.getElementById('searchUserInput').focus(), 100);
}

let searchTimeout;
function searchUsers() {
  clearTimeout(searchTimeout);
  const query = document.getElementById('searchUserInput').value.trim();
  if (query.length < 1) { document.getElementById('searchResults').innerHTML = ''; return; }

  searchTimeout = setTimeout(() => {
    safeEmit('search-users', { query }, (response) => {
      const container = document.getElementById('searchResults');
      container.innerHTML = '';
      if (!response || !response.success) {
        container.innerHTML = '<div class="empty-state"><p>Arama yapılamadı</p></div>';
        return;
      }
      if (response.users.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>Kullanıcı bulunamadı</p></div>';
        return;
      }
      response.users.forEach(user => {
        const div = document.createElement('div');
        div.className = 'search-result-item';
        div.innerHTML = `
          <div class="result-avatar" style="background: ${getAvatarColor(user.username)}">
            ${user.username.charAt(0).toUpperCase()}
          </div>
          <div class="result-info">
            <span class="result-name">${escapeHtml(user.username)}</span>
            <span class="result-status">${getStatusText(user.status)}</span>
          </div>
          <div style="display:flex;gap:6px;">
            <button onclick="event.stopPropagation();sendFriendRequestByName('${escapeHtml(user.username)}')">
              <i class="fas fa-user-plus"></i> Ekle
            </button>
            <button onclick="event.stopPropagation();startDMFromSearch('${user.id}','${escapeHtml(user.username)}','${user.status || 'offline'}')">
              <i class="fas fa-comment"></i> Mesaj
            </button>
          </div>`;
        container.appendChild(div);
      });
    });
  }, 300);
}

function sendFriendRequestByName(username) {
  safeEmit('send-friend-request', { username }, (response) => {
    if (response.success) showToast(`${username} kullanıcısına istek gönderildi!`, 'success');
    else showToast(response.error || 'İstek gönderilemedi', 'error');
  });
}

function startDMFromSearch(userId, username, status) {
  closeModal('searchModal');
  openDM({ id: userId, username, status: status || 'offline' });
}

function handleLogout() {
  socket.emit('update-status', { status: 'offline' });
  isLoggedIn = false;
  loginDone = false;
  sessionStorage.clear();
  window.location.href = '/';
}

function showContextMenu(e, msg, isOwn) {
  e.preventDefault();
  const menu = document.getElementById('contextMenu');
  selectedMessageId = msg.id;
  selectedMessageChannelId = activeChannel?.id;
  document.getElementById('ctxEdit').style.display = isOwn ? 'flex' : 'none';
  document.getElementById('ctxDelete').style.display = isOwn ? 'flex' : 'none';

  const x = Math.min(e.clientX, window.innerWidth - 200);
  const y = Math.min(e.clientY, window.innerHeight - 120);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
}

function editSelectedMessage() {
  if (selectedMessageId) startEditMessage(selectedMessageId);
  document.getElementById('contextMenu').classList.add('hidden');
}

function deleteSelectedMessage() {
  if (selectedMessageId) startDeleteMessage(selectedMessageId, selectedMessageChannelId);
  document.getElementById('contextMenu').classList.add('hidden');
}

function copyMessageContent() {
  const msgEl = document.querySelector(`[data-message-id="${selectedMessageId}"]`);
  if (msgEl) {
    const text = msgEl.querySelector('.message-content').innerText;
    navigator.clipboard.writeText(text);
    showToast('Mesaj kopyalandı', 'info');
  }
  document.getElementById('contextMenu').classList.add('hidden');
}

function showPinnedMessages() { showToast('Sabitleme özelliği yakında!', 'info'); }

// ===== EMOJI PICKER =====
const emojis = [
  '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
  '😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐',
  '🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒',
  '🤕','🤢','🤮','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','☹️',
  '😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞',
  '😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺',
  '👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','❤️','🧡','💛',
  '💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟',
  '👍','👎','👊','✊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✌️','🤞','🤟','🤘',
  '👌','🤌','🤏','👈','👉','👆','👇','☝️','✋','🤚','🖐','🖖','👋','🤙','💪','🦾',
  '🔥','⭐','🌟','✨','💫','🎉','🎊','🎈','🎁','🏆','🥇','🥈','🥉','⚽','🏀','🎮',
  '🎯','🎲','🎭','🎨','🎵','🎶','🎸','🎹','🎺','🎻','🎬','📸','💻','📱','⌨️','🖥'
];

function initEmojiPicker() {
  const grid = document.getElementById('emojiGrid');
  emojis.forEach(emoji => {
    const span = document.createElement('span');
    span.className = 'emoji-item';
    span.textContent = emoji;
    span.onclick = () => insertEmoji(emoji);
    grid.appendChild(span);
  });

  // Emoji arama input listener burada bağlanıyor
  document.getElementById('emojiSearch').addEventListener('input', filterEmojis);
}

function toggleEmojiPicker() { document.getElementById('emojiPicker').classList.toggle('hidden'); }

function insertEmoji(emoji) {
  const picker = document.getElementById('emojiPicker');
  if (picker.dataset.targetMessage) {
    const channelId = activeChannel?.id || '';
    socket.emit('add-reaction', { messageId: picker.dataset.targetMessage, channelId, emoji });
    picker.dataset.targetMessage = '';
    picker.classList.add('hidden');
    return;
  }
  const input = activeView === 'dm' ? document.getElementById('dmMessageInput') : document.getElementById('messageInput');
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
  input.focus();
  input.setSelectionRange(start + emoji.length, start + emoji.length);
  picker.classList.add('hidden');
}

function filterEmojis() {
  const query = document.getElementById('emojiSearch').value.toLowerCase();
  document.querySelectorAll('.emoji-item').forEach(item => {
    item.style.display = query ? (item.textContent.includes(query) ? '' : 'none') : '';
  });
}

// emojiSearch input listener - initEmojiPicker içine taşındı

// ===== UTILITY FUNCTIONS =====
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

function formatMessage(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.*?)`/g, '<code style="padding:2px 6px;background:var(--bg-tertiary);border-radius:3px;font-size:13px;">$1</code>');
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function formatTimestamp(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return 'Az önce';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} dk önce`;
  const isToday = date.toDateString() === now.toDateString();
  const isYesterday = new Date(now - 86400000).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Bugün ${time}`;
  if (isYesterday) return `Dün ${time}`;
  return date.toLocaleDateString('tr-TR') + ` ${time}`;
}

function getAvatarColor(name) {
  const colors = ['#5865F2','#EB459E','#57F287','#FEE75C','#ED4245','#F47B67','#E78338','#45DDC0','#9B84EE','#F47FFF','#3BA55C','#FAA61A','#E67E22','#E74C3C','#9B59B6','#1ABC9C','#2ECC71','#3498DB','#E91E63','#F44336'];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function getStatusColor(status) {
  switch (status) {
    case 'online': return '#23a559';
    case 'idle': return '#f0b232';
    case 'dnd': return '#f23f43';
    default: return '#80848e';
  }
}

function getStatusText(status) {
  switch (status) {
    case 'online': return 'Çevrimiçi';
    case 'idle': return 'Boşta';
    case 'dnd': return 'Rahatsız Etmeyin';
    default: return 'Çevrimdışı';
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
  toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function clearFilePreview() {
  document.getElementById('filePreview').classList.add('hidden');
}

// Animasyon
const style = document.createElement('style');
style.textContent = `@keyframes fadeOut { from { opacity:1; } to { opacity:0; } }`;
document.head.appendChild(style);
