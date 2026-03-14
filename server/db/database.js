const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'chat.db');
const db = new Database(dbPath);

// WAL mode for better performance
db.pragma('journal_mode = WAL');

// Tabloları oluştur
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT 'default-avatar.png',
    status TEXT DEFAULT 'online',
    custom_status TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '',
    owner_id TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    topic TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    nickname TEXT DEFAULT '',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    file_url TEXT DEFAULT '',
    edited BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    file_url TEXT DEFAULT '',
    read BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (receiver_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS friends (
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, friend_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS typing_indicators (
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
  );
`);

// Indeksler
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_dm_users ON direct_messages(sender_id, receiver_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_server_members ON server_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_friends ON friends(user_id, status);
`);

function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const dbOps = {
  // ===== USER OPERATIONS =====
  createUser(username, email, password, avatar = 'default-avatar.png') {
    const id = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);
    try {
      db.prepare(`
        INSERT INTO users (id, username, email, password, avatar)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, username, email, hashedPassword, avatar);
      return { id, username, email, avatar, status: 'online' };
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed: users.username')) {
        throw new Error('Bu kullanıcı adı zaten kullanılıyor');
      }
      if (err.message.includes('UNIQUE constraint failed: users.email')) {
        throw new Error('Bu email zaten kullanılıyor');
      }
      throw err;
    }
  },

  loginUser(email, password) {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) throw new Error('Kullanıcı bulunamadı');
    if (!bcrypt.compareSync(password, user.password)) throw new Error('Şifre yanlış');

    db.prepare('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?')
      .run('online', user.id);

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      avatar: user.avatar,
      status: 'online',
      custom_status: user.custom_status
    };
  },

  updateUserStatus(userId, status) {
    db.prepare('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, userId);
  },

  updateUserProfile(userId, data) {
    const fields = [];
    const values = [];
    if (data.username) { fields.push('username = ?'); values.push(data.username); }
    if (data.avatar) { fields.push('avatar = ?'); values.push(data.avatar); }
    if (data.custom_status !== undefined) { fields.push('custom_status = ?'); values.push(data.custom_status); }
    values.push(userId);
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  getUser(userId) {
    return db.prepare('SELECT id, username, email, avatar, status, custom_status, created_at FROM users WHERE id = ?').get(userId);
  },

  getUserByUsername(username) {
    return db.prepare('SELECT id, username, email, avatar, status, custom_status FROM users WHERE username = ? COLLATE NOCASE').get(username);
  },

  searchUsers(query, currentUserId) {
    if (!query || query.length < 1) return [];
    const searchTerm = `%${query.toLowerCase()}%`;
    return db.prepare(`
      SELECT id, username, avatar, status, custom_status FROM users
      WHERE LOWER(username) LIKE ? AND id != ?
      ORDER BY
        CASE WHEN LOWER(username) = ? THEN 0
             WHEN LOWER(username) LIKE ? THEN 1
             ELSE 2
        END
      LIMIT 20
    `).all(searchTerm, currentUserId, query.toLowerCase(), `${query.toLowerCase()}%`);
  },

  // ===== SERVER OPERATIONS =====
  createServer(name, ownerId, icon = '') {
    const id = uuidv4();
    const inviteCode = generateInviteCode();
    const channelId = uuidv4();

    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO servers (id, name, icon, owner_id, invite_code)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, name, icon, ownerId, inviteCode);

      db.prepare(`
        INSERT INTO channels (id, server_id, name, type, position)
        VALUES (?, ?, 'genel', 'text', 0)
      `).run(channelId, id);

      db.prepare(`
        INSERT INTO server_members (server_id, user_id, role)
        VALUES (?, ?, 'owner')
      `).run(id, ownerId);
    });

    transaction();

    console.log('🏠 Sunucu oluşturuldu:', name, '| Davet kodu:', inviteCode);

    return {
      id, name, icon, owner_id: ownerId, invite_code: inviteCode,
      channels: [{ id: channelId, name: 'genel', type: 'text', topic: '', position: 0 }]
    };
  },

  joinServerByInvite(inviteCode, userId) {
    const trimmedCode = (inviteCode || '').trim();
    if (!trimmedCode) throw new Error('Davet kodu boş olamaz');

    // Büyük/küçük harf duyarsız ara
    const server = db.prepare('SELECT * FROM servers WHERE invite_code = ? COLLATE NOCASE').get(trimmedCode);
    if (!server) {
      // Tüm kodları listele debug için
      const allServers = db.prepare('SELECT invite_code FROM servers').all();
      console.log('Mevcut davet kodları:', allServers.map(s => s.invite_code));
      console.log('Aranan kod:', trimmedCode);
      throw new Error('Geçersiz davet kodu');
    }

    const existing = db.prepare('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?')
      .get(server.id, userId);
    if (existing) throw new Error('Zaten bu sunucudasınız');

    db.prepare('INSERT INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)')
      .run(server.id, userId, 'member');

    return this.getServerWithDetails(server.id);
  },

  getServerWithDetails(serverId) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) return null;

    const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position')
      .all(serverId);

    const members = db.prepare(`
      SELECT u.id, u.username, u.avatar, u.status, u.custom_status, sm.role, sm.nickname
      FROM server_members sm
      JOIN users u ON sm.user_id = u.id
      WHERE sm.server_id = ?
    `).all(serverId);

    return { ...server, channels, members };
  },

  getUserServers(userId) {
    const serverIds = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(userId);
    return serverIds.map(s => this.getServerWithDetails(s.server_id)).filter(Boolean);
  },

  createChannel(serverId, name, type = 'text', topic = '') {
    const id = uuidv4();
    const maxPos = db.prepare('SELECT MAX(position) as max FROM channels WHERE server_id = ?').get(serverId);
    const position = (maxPos.max || 0) + 1;

    db.prepare(`
      INSERT INTO channels (id, server_id, name, type, topic, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, serverId, name, type, topic, position);

    return { id, server_id: serverId, name, type, topic, position };
  },

  deleteChannel(channelId) {
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
  },

  deleteServer(serverId, userId) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ? AND owner_id = ?').get(serverId, userId);
    if (!server) throw new Error('Yetkiniz yok');
    db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
  },

  leaveServer(serverId, userId) {
    db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  },

  getServerMembers(serverId) {
    return db.prepare(`
      SELECT u.id, u.username, u.avatar, u.status, u.custom_status, sm.role, sm.nickname
      FROM server_members sm
      JOIN users u ON sm.user_id = u.id
      WHERE sm.server_id = ?
      ORDER BY
        CASE sm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        u.username
    `).all(serverId);
  },

  // ===== MESSAGE OPERATIONS =====
  sendMessage(channelId, userId, content, type = 'text', fileUrl = '') {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO messages (id, channel_id, user_id, content, type, file_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, channelId, userId, content, type, fileUrl);

    return db.prepare(`
      SELECT m.*, u.username, u.avatar
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `).get(id);
  },

  getMessages(channelId, limit = 50, before = null) {
    if (before) {
      return db.prepare(`
        SELECT m.*, u.username, u.avatar
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.created_at < ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `).all(channelId, before, limit).reverse();
    }
    return db.prepare(`
      SELECT m.*, u.username, u.avatar
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(channelId, limit).reverse();
  },

  editMessage(messageId, userId, content) {
    db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ? AND user_id = ?')
      .run(content, messageId, userId);
    return db.prepare(`
      SELECT m.*, u.username, u.avatar
      FROM messages m JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `).get(messageId);
  },

  deleteMessage(messageId, userId) {
    db.prepare('DELETE FROM messages WHERE id = ? AND user_id = ?').run(messageId, userId);
  },

  addReaction(messageId, userId, emoji) {
    const id = uuidv4();
    try {
      db.prepare('INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES (?, ?, ?, ?)')
        .run(id, messageId, userId, emoji);
    } catch (e) { /* duplicate */ }
  },

  removeReaction(messageId, userId, emoji) {
    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .run(messageId, userId, emoji);
  },

  getReactions(messageId) {
    return db.prepare(`
      SELECT mr.emoji, mr.user_id, u.username
      FROM message_reactions mr
      JOIN users u ON mr.user_id = u.id
      WHERE mr.message_id = ?
    `).all(messageId);
  },

  // ===== DIRECT MESSAGE OPERATIONS =====
  sendDM(senderId, receiverId, content, type = 'text', fileUrl = '') {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO direct_messages (id, sender_id, receiver_id, content, type, file_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, senderId, receiverId, content, type, fileUrl);

    return db.prepare(`
      SELECT dm.*, u.username, u.avatar
      FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE dm.id = ?
    `).get(id);
  },

  getDMs(userId1, userId2, limit = 50) {
    return db.prepare(`
      SELECT dm.*, u.username, u.avatar
      FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE (dm.sender_id = ? AND dm.receiver_id = ?)
         OR (dm.sender_id = ? AND dm.receiver_id = ?)
      ORDER BY dm.created_at DESC
      LIMIT ?
    `).all(userId1, userId2, userId2, userId1, limit).reverse();
  },

  getDMContacts(userId) {
    return db.prepare(`
      SELECT DISTINCT
        CASE WHEN dm.sender_id = ? THEN dm.receiver_id ELSE dm.sender_id END as contact_id,
        u.username, u.avatar, u.status, u.custom_status,
        MAX(dm.created_at) as last_message_at
      FROM direct_messages dm
      JOIN users u ON (CASE WHEN dm.sender_id = ? THEN dm.receiver_id ELSE dm.sender_id END) = u.id
      WHERE dm.sender_id = ? OR dm.receiver_id = ?
      GROUP BY contact_id
      ORDER BY last_message_at DESC
    `).all(userId, userId, userId, userId);
  },

  // ===== FRIEND OPERATIONS =====
  sendFriendRequest(userId, friendId) {
    if (userId === friendId) throw new Error('Kendinize arkadaşlık isteği gönderemezsiniz');

    const existing = db.prepare('SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)')
      .get(userId, friendId, friendId, userId);

    if (existing) {
      if (existing.status === 'accepted') throw new Error('Zaten arkadaşsınız');
      if (existing.status === 'pending' && existing.user_id === userId) throw new Error('Zaten istek gönderilmiş');
      if (existing.status === 'pending' && existing.friend_id === userId) throw new Error('Bu kişi size zaten istek göndermiş, bekleyen isteklerinizi kontrol edin');
      throw new Error('Zaten bir arkadaşlık isteği mevcut');
    }

    db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)')
      .run(userId, friendId, 'pending');
  },

  acceptFriendRequest(userId, friendId) {
    db.prepare('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?')
      .run('accepted', friendId, userId);
  },

  rejectFriendRequest(userId, friendId) {
    db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?')
      .run(friendId, userId);
  },

  removeFriend(userId, friendId) {
    db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)')
      .run(userId, friendId, friendId, userId);
  },

  getFriends(userId) {
    return db.prepare(`
      SELECT u.id, u.username, u.avatar, u.status, u.custom_status, f.status as friendship_status
      FROM friends f
      JOIN users u ON (CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END) = u.id
      WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
    `).all(userId, userId, userId);
  },

  getPendingRequests(userId) {
    return db.prepare(`
      SELECT u.id, u.username, u.avatar, u.status, f.created_at
      FROM friends f
      JOIN users u ON f.user_id = u.id
      WHERE f.friend_id = ? AND f.status = 'pending'
    `).all(userId);
  },

  getSentRequests(userId) {
    return db.prepare(`
      SELECT u.id, u.username, u.avatar, u.status, f.created_at
      FROM friends f
      JOIN users u ON f.friend_id = u.id
      WHERE f.user_id = ? AND f.status = 'pending'
    `).all(userId);
  }
};

module.exports = dbOps;
