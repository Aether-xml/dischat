const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('./db/database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 10e6,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|mp3|pdf|txt|zip/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext || mime) cb(null, true);
    else cb(new Error('Desteklenmeyen dosya türü'));
  }
});

// Uploads klasörünü oluştur
const fs = require('fs');
const uploadsDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Statik dosyalar için uploads
app.use('/uploads', express.static(uploadsDir));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// REST API Routes
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yüklenemedi' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});

// Online kullanıcıları takip et
const onlineUsers = new Map(); // socketId -> userData
const userSockets = new Map(); // userId -> Set<socketId>

// Socket.IO
io.on('connection', (socket) => {
  console.log(`🟢 Bağlantı: ${socket.id}`);

  // ===== AUTH =====
  socket.on('register', (data, callback) => {
    try {
      const user = db.createUser(data.username, data.email, data.password, data.avatar || 'default-avatar.png');
      onlineUsers.set(socket.id, user);
      if (!userSockets.has(user.id)) userSockets.set(user.id, new Set());
      userSockets.get(user.id).add(socket.id);
      callback({ success: true, user });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('login', (data, callback) => {
    try {
      const user = db.loginUser(data.email, data.password);
      onlineUsers.set(socket.id, user);
      if (!userSockets.has(user.id)) userSockets.set(user.id, new Set());
      userSockets.get(user.id).add(socket.id);

      // Kullanıcının sunucularını yükle
      const servers = db.getUserServers(user.id);
      const friends = db.getFriends(user.id);
      const pendingRequests = db.getPendingRequests(user.id);
      const dmContacts = db.getDMContacts(user.id);

      // Sunucu odalarına katıl
      servers.forEach(s => {
        socket.join(`server:${s.id}`);
        s.channels.forEach(c => socket.join(`channel:${c.id}`));
      });

      // Arkadaşlara online bildirimi
      friends.forEach(f => {
        const friendSockets = userSockets.get(f.id);
        if (friendSockets) {
          friendSockets.forEach(sid => {
            io.to(sid).emit('friend-online', { userId: user.id, username: user.username });
          });
        }
      });

      callback({ success: true, user, servers, friends, pendingRequests, dmContacts });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ===== SERVER MANAGEMENT =====
  socket.on('create-server', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const server = db.createServer(data.name, user.id, data.icon || '');
      socket.join(`server:${server.id}`);
      server.channels.forEach(c => socket.join(`channel:${c.id}`));

      const fullServer = db.getServerWithDetails(server.id);
      callback({ success: true, server: fullServer });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('join-server', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const server = db.joinServerByInvite(data.inviteCode, user.id);
      socket.join(`server:${server.id}`);
      server.channels.forEach(c => socket.join(`channel:${c.id}`));

      // Sunucudaki diğer üyelere bildir
      io.to(`server:${server.id}`).emit('member-joined', {
        serverId: server.id,
        member: { id: user.id, username: user.username, avatar: user.avatar, status: user.status, role: 'member' }
      });

      callback({ success: true, server });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('leave-server', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      db.leaveServer(data.serverId, user.id);
      socket.leave(`server:${data.serverId}`);

      io.to(`server:${data.serverId}`).emit('member-left', {
        serverId: data.serverId,
        userId: user.id
      });

      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('delete-server', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      db.deleteServer(data.serverId, user.id);
      io.to(`server:${data.serverId}`).emit('server-deleted', { serverId: data.serverId });
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ===== CHANNEL MANAGEMENT =====
  socket.on('create-channel', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const channel = db.createChannel(data.serverId, data.name, data.type || 'text', data.topic || '');
      socket.join(`channel:${channel.id}`);

      io.to(`server:${data.serverId}`).emit('channel-created', {
        serverId: data.serverId,
        channel
      });

      callback({ success: true, channel });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('delete-channel', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      db.deleteChannel(data.channelId);
      io.to(`server:${data.serverId}`).emit('channel-deleted', {
        serverId: data.serverId,
        channelId: data.channelId
      });
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ===== MESSAGING =====
  socket.on('send-message', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const message = db.sendMessage(data.channelId, user.id, data.content, data.type || 'text', data.fileUrl || '');
      const reactions = db.getReactions(message.id);
      message.reactions = reactions;

      io.to(`channel:${data.channelId}`).emit('new-message', {
        channelId: data.channelId,
        message
      });

      callback({ success: true, message });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('get-messages', (data, callback) => {
    try {
      const messages = db.getMessages(data.channelId, data.limit || 50, data.before || null);
      // Her mesaj için reaksiyonları yükle
      messages.forEach(m => {
        m.reactions = db.getReactions(m.id);
      });
      callback({ success: true, messages });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('edit-message', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const message = db.editMessage(data.messageId, user.id, data.content);
      if (message) {
        io.to(`channel:${data.channelId}`).emit('message-edited', {
          channelId: data.channelId,
          message
        });
      }
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('delete-message', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      db.deleteMessage(data.messageId, user.id);
      io.to(`channel:${data.channelId}`).emit('message-deleted', {
        channelId: data.channelId,
        messageId: data.messageId
      });
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('add-reaction', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    db.addReaction(data.messageId, user.id, data.emoji);
    io.to(`channel:${data.channelId}`).emit('reaction-added', {
      channelId: data.channelId,
      messageId: data.messageId,
      userId: user.id,
      username: user.username,
      emoji: data.emoji
    });
  });

  socket.on('remove-reaction', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    db.removeReaction(data.messageId, user.id, data.emoji);
    io.to(`channel:${data.channelId}`).emit('reaction-removed', {
      channelId: data.channelId,
      messageId: data.messageId,
      userId: user.id,
      emoji: data.emoji
    });
  });

  // ===== TYPING INDICATOR =====
  socket.on('typing-start', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    socket.to(`channel:${data.channelId}`).emit('user-typing', {
      channelId: data.channelId,
      userId: user.id,
      username: user.username
    });
  });

  socket.on('typing-stop', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    socket.to(`channel:${data.channelId}`).emit('user-stopped-typing', {
      channelId: data.channelId,
      userId: user.id
    });
  });

  // ===== DIRECT MESSAGES =====
  socket.on('send-dm', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const message = db.sendDM(user.id, data.receiverId, data.content, data.type || 'text', data.fileUrl || '');

      // Alıcıya gönder
      const receiverSockets = userSockets.get(data.receiverId);
      if (receiverSockets) {
        receiverSockets.forEach(sid => {
          io.to(sid).emit('new-dm', { message, senderId: user.id });
        });
      }

      callback({ success: true, message });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('get-dms', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const messages = db.getDMs(user.id, data.userId, data.limit || 50);
      callback({ success: true, messages });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('get-dm-contacts', (callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const contacts = db.getDMContacts(user.id);
      callback({ success: true, contacts });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ===== FRIENDS =====
  socket.on('send-friend-request', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const friend = db.getUserByUsername(data.username);
      if (!friend) return callback({ success: false, error: 'Kullanıcı bulunamadı' });

      db.sendFriendRequest(user.id, friend.id);

      // Karşı tarafa bildir
      const friendSocketIds = userSockets.get(friend.id);
      if (friendSocketIds) {
        friendSocketIds.forEach(sid => {
          io.to(sid).emit('friend-request-received', {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            status: user.status
          });
        });
      }

      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('accept-friend-request', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      db.acceptFriendRequest(user.id, data.friendId);

      const friend = db.getUser(data.friendId);
      const friendSocketIds = userSockets.get(data.friendId);
      if (friendSocketIds) {
        friendSocketIds.forEach(sid => {
          io.to(sid).emit('friend-request-accepted', {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            status: user.status
          });
        });
      }

      callback({ success: true, friend });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('reject-friend-request', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      db.rejectFriendRequest(user.id, data.friendId);
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('remove-friend', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      db.removeFriend(user.id, data.friendId);
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('search-users', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      const users = db.searchUsers(data.query, user.id);
      callback({ success: true, users });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ===== USER PROFILE =====
  socket.on('update-profile', (data, callback) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return callback({ success: false, error: 'Oturum açın' });

    try {
      db.updateUserProfile(user.id, data);
      if (data.username) user.username = data.username;
      if (data.avatar) user.avatar = data.avatar;
      if (data.custom_status !== undefined) user.custom_status = data.custom_status;

      onlineUsers.set(socket.id, user);

      // Sunuculardaki üyelere bildir
      const servers = db.getUserServers(user.id);
      servers.forEach(s => {
        io.to(`server:${s.id}`).emit('member-updated', {
          serverId: s.id,
          member: { id: user.id, username: user.username, avatar: user.avatar, status: user.status, custom_status: user.custom_status }
        });
      });

      callback({ success: true, user });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('update-status', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    user.status = data.status;
    db.updateUserStatus(user.id, data.status);
    onlineUsers.set(socket.id, user);

    const servers = db.getUserServers(user.id);
    servers.forEach(s => {
      io.to(`server:${s.id}`).emit('member-status-changed', {
        serverId: s.id,
        userId: user.id,
        status: data.status
      });
    });
  });

  // ===== DISCONNECT =====
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      const sockets = userSockets.get(user.id);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userSockets.delete(user.id);
          db.updateUserStatus(user.id, 'offline');

          const servers = db.getUserServers(user.id);
          servers.forEach(s => {
            io.to(`server:${s.id}`).emit('member-status-changed', {
              serverId: s.id,
              userId: user.id,
              status: 'offline'
            });
          });

          const friends = db.getFriends(user.id);
          friends.forEach(f => {
            const friendSockets = userSockets.get(f.id);
            if (friendSockets) {
              friendSockets.forEach(sid => {
                io.to(sid).emit('friend-offline', { userId: user.id });
              });
            }
          });
        }
      }
      onlineUsers.delete(socket.id);
    }
    console.log(`🔴 Bağlantı koptu: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   🚀 Discord Chat Server            ║
  ║   Port: ${PORT}                         ║
  ║   Ortam: ${process.env.NODE_ENV || 'development'}              ║
  ╚══════════════════════════════════════╝
  `);
});