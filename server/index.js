const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { users: [], skips: [], userData: {} };
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d.userData) d.userData = {};
    if (!d.users) d.users = [];
    if (!d.skips) d.skips = [];
    return d;
  } catch { return { users: [], skips: [], userData: {} }; }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

function hashPw(pw) { return crypto.createHash('sha256').update(pw || '').digest('hex'); }

// --- existing endpoints ---
app.post('/api/signup', (req, res) => {
  const { name, email, device } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'email required' });
  const data = loadData();
  const existing = data.users.find((u) => u.email === email);
  if (existing) {
    existing.name = name || existing.name;
    existing.lastSeen = new Date().toISOString();
    existing.device = device || existing.device;
  } else {
    data.users.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || '', email, device: device || '', createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(), passwordHash: '' });
  }
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/skip', (req, res) => {
  const { device } = req.body || {};
  const data = loadData();
  data.skips.push({ device: device || '', at: new Date().toISOString() });
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'invalid password' });
  res.json({ ok: true, token: ADMIN_PASSWORD });
});

function authAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/api/users', authAdmin, (req, res) => {
  const data = loadData();
  const allNotes = Object.values(data.userData || {}).flatMap((d) => d.notes || []);
  const allFolders = Object.values(data.userData || {}).flatMap((d) => d.folders || []);
  res.json({
    ok: true,
    stats: {
      totalUsers: data.users.length,
      totalSkips: data.skips.length,
      totalInteractions: data.users.length + data.skips.length,
      totalNotes: allNotes.length,
      totalFolders: allFolders.length,
    },
    users: data.users,
    skips: data.skips,
    userData: data.userData || {},
  });
});
// Admin personal notes — the admin can write notes just like a normal user.
const ADMIN_NOTES_ID = '__admin__';
app.get('/api/admin/notes', authAdmin, (req, res) => {
  const data = loadData();
  const ud = data.userData[ADMIN_NOTES_ID] || { notes: [], folders: [], lastSync: 0 };
  res.json({ ok: true, notes: ud.notes || [] });
});
app.post('/api/admin/notes', authAdmin, (req, res) => {
  const data = loadData();
  if (!data.userData[ADMIN_NOTES_ID]) data.userData[ADMIN_NOTES_ID] = { notes: [], folders: [], lastSync: 0 };
  const ud = data.userData[ADMIN_NOTES_ID];
  const { id, title, content } = req.body || {};
  const noteId = id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const existing = (ud.notes || []).find((n) => n.id === noteId);
  const next = {
    id: noteId,
    title: String(title || 'Untitled'),
    content: String(content || ''),
    updatedAt: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
  };
  ud.notes = existing ? ud.notes.map((n) => n.id === noteId ? next : n) : [next, ...(ud.notes || [])];
  ud.lastSync = Date.now();
  saveData(data);
  res.json({ ok: true, note: next });
});
app.delete('/api/admin/notes/:id', authAdmin, (req, res) => {
  const data = loadData();
  const ud = data.userData[ADMIN_NOTES_ID];
  if (!ud) return res.json({ ok: true });
  ud.notes = (ud.notes || []).filter((n) => n.id !== req.params.id);
  ud.lastSync = Date.now();
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/admin/user/:id', authAdmin, (req, res) => {
  const data = loadData();
  const user = data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: 'user not found' });
  res.json({ ok: true, user, userData: data.userData[user.id] || { notes: [], folders: [], lastSync: 0 } });
});
app.delete('/api/admin/user/:id', authAdmin, (req, res) => {
  const data = loadData();
  const id = req.params.id;
  if (!data.users.some((u) => u.id === id)) return res.status(404).json({ ok: false, error: 'user not found' });
  data.users = data.users.filter((u) => u.id !== id);
  delete data.userData[id];
  saveData(data);
  res.json({ ok: true });
});
app.delete('/api/admin/note/:userId/:noteId', authAdmin, (req, res) => {
  const data = loadData();
  const ud = data.userData[req.params.userId];
  if (!ud || !Array.isArray(ud.notes)) return res.status(404).json({ ok: false, error: 'user data not found' });
  ud.notes = ud.notes.filter((n) => n.id !== req.params.noteId);
  ud.lastSync = Date.now();
  saveData(data);
  res.json({ ok: true });
});
app.get('/api/admin/export', authAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="notes-backup.json"');
  res.send(fs.readFileSync(DATA_FILE));
});
app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- cloud sync auth ---
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });
  const data = loadData();
  if (data.users.find((u) => u.email === email)) return res.status(409).json({ ok: false, error: 'email already registered' });
  const user = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || '', email, passwordHash: hashPw(password), createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(), device: '' };
  data.users.push(user);
  data.userData[user.id] = { notes: [], folders: [], lastSync: 0 };
  saveData(data);
  res.json({ ok: true, token: user.id, userId: user.id });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const data = loadData();
  const user = data.users.find((u) => u.email === email);
  if (!user || user.passwordHash !== hashPw(password)) return res.status(401).json({ ok: false, error: 'invalid credentials' });
  user.lastSeen = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, token: user.id, userId: user.id, name: user.name });
});

function authUser(req, res, next) {
  const token = req.headers['x-user-token'] || req.query.token;
  const data = loadData();
  const user = data.users.find((u) => u.id === token);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.user = user; req.data = data;
  next();
}

// push local data to cloud
app.post('/api/sync/push', authUser, (req, res) => {
  const { notes, folders } = req.body || {};
  const data = req.data;
  if (!data.userData[req.user.id]) data.userData[req.user.id] = { notes: [], folders: [], lastSync: 0 };
  data.userData[req.user.id].notes = Array.isArray(notes) ? notes : data.userData[req.user.id].notes;
  data.userData[req.user.id].folders = Array.isArray(folders) ? folders : data.userData[req.user.id].folders;
  data.userData[req.user.id].lastSync = Date.now();
  saveData(data);
  res.json({ ok: true, lastSync: data.userData[req.user.id].lastSync });
});

// pull cloud data
app.get('/api/sync/pull', authUser, (req, res) => {
  const data = req.data;
  const ud = data.userData[req.user.id] || { notes: [], folders: [], lastSync: 0 };
  res.json({ ok: true, notes: ud.notes || [], folders: ud.folders || [], lastSync: ud.lastSync || 0 });
});

// --- real-time collaboration via socket.io ---
io.on('connection', (socket) => {
  socket.on('join-note', (noteId) => {
    socket.join('note:' + noteId);
    socket.to('note:' + noteId).emit('peer-joined', socket.id);
  });
  socket.on('note-change', ({ noteId, content, title }) => {
    socket.to('note:' + noteId).emit('note-change', { content, title, from: socket.id });
  });
  socket.on('leave-note', (noteId) => {
    socket.leave('note:' + noteId);
  });
});

server.listen(PORT, () => {
  console.log(`Notes backend running on http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
});
