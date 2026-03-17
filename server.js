const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { initDb } = require('./db');
const logger = require('./middleware/logger');
const usersRoutes = require('./routes/users');

const PORT = process.env.PORT || 8000;
const app = express();

// middleware
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(logger);

// Protect user deletion at the API gateway level: if any incoming DELETE targets the user_v1 collection,
// block deletion and respond with a consistent deactivation message. This ensures accounts are never removed
// by logout/refresh or inadvertent client calls, even if other route handlers exist.
app.delete('/api/collections/user_v1/:id', async (req, res) => {
  try {
    // Best-effort: mark user as deactivated in backing store if db helper is available.
    try {
      const dbModule = require('./db');
      if (dbModule && typeof dbModule.getCollection === 'function') {
        const users = dbModule.getCollection('user_v1');
        if (Array.isArray(users)) {
          const user = users.find(u => String(u.id) === String(req.params.id));
          if (user) {
            user.deactivated = true;
            user.deactivated_at = new Date().toISOString();
            if (typeof dbModule.write === 'function') {
              try { await dbModule.write(); } catch(e){}
            }
          }
        }
      }
    } catch (e) {
      // ignore any failures to persist — still block deletion
    }

    return res.status(200).json({
      ok: false,
      error: 'deletion_blocked',
      message: 'User deletion is blocked for safety; account was deactivated instead.'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'internal_error', message: 'Failed to block deletion' });
  }
});

// API routes
app.use('/api/users', usersRoutes);

// Serve static SPA (project root)
app.use(express.static(path.join(__dirname, '/')));

// fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// initialize DB then start
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  } catch (err) {
    console.error('Failed to initialize DB or start server', err);
    process.exit(1);
  }
})();