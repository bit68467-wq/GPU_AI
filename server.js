/*
 Minimal Express backend for CUP9GPU demo.
 - Exposes /sync (best-effort store), /register and /login used by the SPA.
 - Keeps an in-memory store and persists to a local JSON file (data.json) when possible.
 - Designed for quick deploy to Render or similar PaaS (single file, minimal deps).
*/

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, 'data.json');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// Simple persistent storage helper (best-effort)
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (e) {
    console.error('loadData error', e);
  }
  return { users: [], sessions: [] };
}
function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('saveData error', e);
  }
}

let store = loadData();
// Ensure minimal structure
store.users = store.users || [];
store.sessions = store.sessions || [];

/* Middleware: simple service ID check (optional but used by SPA) */
app.use((req, res, next) => {
  // Accept requests without header in demo, but log mismatch for debugging
  const svc = req.header('x-service-id') || '';
  req.serviceId = svc;
  next();
});

// Healthcheck
app.get('/', (req, res) => res.json({ ok: true, service: 'cup9gpu-backend-demo' }));

// /sync accepts best-effort sync payload from client to persist users + sessions
app.post('/sync', (req, res) => {
  try {
    const payload = req.body || {};
    // Merge users: prefer incoming users as authoritative for demo
    if (Array.isArray(payload.users)) {
      // naive merge: replace store.users with incoming users but preserve server-side ids if present
      store.users = payload.users.map(u => {
        // ensure id exists
        if (!u.id) u.id = 'u-' + uuidv4();
        return u;
      });
    }
    // Merge sessions: overwrite for demo
    if (Array.isArray(payload.sessions)) {
      store.sessions = payload.sessions;
    } else if (payload.currentUser) {
      // upsert currentUser into sessions
      const cur = payload.currentUser;
      const idx = store.sessions.findIndex(s => (s.username||'').toLowerCase() === (cur.username||'').toLowerCase());
      const sess = { id: cur.id || ('s-' + uuidv4()), username: cur.username, role: cur.role || 'user', token: cur.token || null, lastLogin: Date.now() };
      if (idx >= 0) store.sessions[idx] = Object.assign({}, store.sessions[idx], sess);
      else store.sessions.push(sess);
    }
    saveData(store);
    return res.json({ ok: true, syncedAt: Date.now() });
  } catch (e) {
    console.error('/sync error', e);
    return res.status(500).json({ ok: false, message: 'sync failed' });
  }
});

// /register creates a user on server-side store (demo). It will not replace client local password handling.
// For security: this demo returns minimal info and DOES NOT implement production password hashing.
app.post('/register', (req, res) => {
  try {
    const { username, password, role = 'user', referredBy } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok:false, message: 'username and password required' });

    const existing = store.users.find(u => (u.username||'').toLowerCase() === (username||'').toLowerCase());
    if (existing) return res.status(409).json({ ok:false, message: 'username exists' });

    const id = 'u-' + uuidv4();
    const refCode = ('R' + Math.random().toString(36).substring(2,8)).toUpperCase();
    const newUser = {
      id,
      username,
      // NOTE: storing plaintext password only for demo; never do this in production
      password,
      role,
      refCode,
      referredBy: referredBy || null,
      createdAt: Date.now()
    };
    store.users.push(newUser);
    saveData(store);

    // return a light-weight response
    return res.json({ ok:true, id: newUser.id, username: newUser.username, role: newUser.role });
  } catch (e) {
    console.error('/register error', e);
    return res.status(500).json({ ok:false, message: 'register failed' });
  }
});

// /login validates credentials against server store; returns token for session tracking (demo)
app.post('/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok:false, message: 'username and password required' });

    const user = store.users.find(u => (u.username||'').toLowerCase() === (username||'').toLowerCase());
    if (!user) return res.status(401).json({ ok:false, message: 'invalid credentials' });

    // demo password check (plaintext) — SPA falls back to local users if server unreachable
    if (user.password !== password) return res.status(401).json({ ok:false, message: 'invalid credentials' });

    // create a simple token
    const token = uuidv4();
    const session = { id: user.id, username: user.username, role: user.role || 'user', token, lastLogin: Date.now() };
    const idx = store.sessions.findIndex(s => (s.username||'').toLowerCase() === (user.username||'').toLowerCase());
    if (idx >= 0) store.sessions[idx] = session; else store.sessions.push(session);
    saveData(store);

    return res.json({ id: user.id, username: user.username, role: user.role, token });
  } catch (e) {
    console.error('/login error', e);
    return res.status(500).json({ ok:false, message: 'login failed' });
  }
});

// Simple endpoint to fetch users (admin debugging) — in demo protected by minimal token header
app.get('/users', (req, res) => {
  // optional header check: x-service-id
  const svc = req.header('x-service-id') || '';
  if (!svc) {
    // still allow for dev, but mark
    return res.json({ ok:true, count: store.users.length, users: store.users.map(u => ({ id: u.id, username: u.username, role: u.role, refCode: u.refCode })) });
  }
  return res.json({ ok:true, count: store.users.length, users: store.users.map(u => ({ id: u.id, username: u.username, role: u.role, refCode: u.refCode })) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CUP9GPU demo backend listening on port ${PORT}`);
});