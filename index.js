const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { initDb, getCollection, write } = require('./db');
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

/**
 * Generic collections API backed by lowdb.
 * - GET    /api/collections/:col         -> list
 * - POST   /api/collections/:col         -> create (with idempotent deposit guard)
 * - PATCH  /api/collections/:col/:id     -> update
 * - DELETE /api/collections/:col/:id     -> delete (users deletion is blocked below)
 *
 * This keeps server authoritative persistence for collections and enforces server-side idempotency
 * for deposit creation so clients cannot create duplicate pending deposits on refresh.
 */

app.get('/api/collections/:col', async (req, res) => {
  try {
    const col = String(req.params.col || '').trim();
    const collection = getCollection(col);
    return res.json(Array.isArray(collection) ? collection.slice() : []);
  } catch (e) {
    console.error('collections GET error', e);
    return res.status(500).json({ error: 'internal' });
  }
});

app.post('/api/collections/:col', async (req, res) => {
  try {
    const col = String(req.params.col || '').trim();
    const payload = req.body || {};
    const collection = getCollection(col);

    // Strong early dedupe: if client supplied an explicit id or idempotency_key and a record already exists,
    // return the existing record instead of creating a duplicate. This prevents client retries or offline
    // fallbacks from producing thousands of near-duplicate records.
    try {
      if (payload && payload.id) {
        const exists = (collection || []).find(r => String(r.id) === String(payload.id));
        if (exists) return res.status(200).json(exists);
      }
      if (payload && payload.idempotency_key) {
        const existsKey = (collection || []).find(r => String(r.idempotency_key) === String(payload.idempotency_key));
        if (existsKey) return res.status(200).json(existsKey);
      }
    } catch (dedupeErr) {
      console.warn('early dedupe check failed', dedupeErr);
    }

    // Helper to compare numeric amounts with tolerance
    const approxEqual = (a, b, eps = 0.0001) => {
      return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
    };

    // STRONG SERVER-SIDE IDEMPOTENCY / DEDUPING

    // 1) Deposits: prefer returning an existing pending-like deposit for same user+amount+network or matching idempotency_key.
    if (col === 'transaction_v1' && String(payload.type || '').toLowerCase() === 'deposit') {
      try {
        const userId = payload.user_id || payload.user_uid || payload.uid || null;
        const amount = payload.amount !== undefined ? Number(payload.amount) : null;
        const network = payload.network ? String(payload.network).toLowerCase() : null;

        // If idempotency_key provided, return by key first
        if (payload.idempotency_key) {
          const byKey = (collection || []).find(t => String(t.idempotency_key) === String(payload.idempotency_key));
          if (byKey) return res.status(200).json(byKey);
        }

        // Match any pending-like deposit that is effectively the same request
        const candidate = (collection || []).find(t => {
          if (String(t.type || '').toLowerCase() !== 'deposit') return false;
          const st = String((t.status || '')).toLowerCase();
          const pendingLike = st === 'awaiting_deposit' || st === 'pending' || st === 'otp_sent';
          if (!pendingLike) return false;
          const sameUser = userId && (String(t.user_id) === String(userId) || String(t.user_uid) === String(userId) || String(t.uid) === String(userId));
          if (!sameUser) return false;
          if (amount !== null && typeof t.amount !== 'undefined' && !approxEqual(t.amount, amount)) return false;
          if (network && t.network && String(t.network).toLowerCase() !== network) return false;
          return true;
        });
        if (candidate) return res.status(200).json(candidate);
      } catch (e) {
        console.warn('deposit idempotency guard failure', e);
      }
    }

    // 2) Earnings: prevent duplicate earnings creation for the same device/user for the same day (server-side guard)
    if (col === 'transaction_v1' && String(payload.type || '').toLowerCase() === 'earning') {
      try {
        const userId = payload.user_id || payload.user_uid || payload.uid || null;
        const note = (payload.note || '').toString();
        const amount = payload.amount !== undefined ? Number(payload.amount) : null;

        // If note contains device name or purchase_tx_id, try to avoid duplicate earnings for same user+note+day
        const todayDay = (new Date(payload.created_at || new Date())).toISOString().slice(0,10);
        const existing = (collection || []).find(t => {
          if (String(t.type || '').toLowerCase() !== 'earning') return false;
          const tDay = (new Date(t.created_at || t.updated_at || new Date())).toISOString().slice(0,10);
          if (tDay !== todayDay) return false;
          const sameUser = userId && (String(t.user_id) === String(userId) || String(t.user_uid) === String(userId));
          if (!sameUser) return false;
          if (note && t.note && String(t.note) === String(note)) return true;
          // fallback: same user + same amount + same created_at day
          if (amount !== null && typeof t.amount !== 'undefined' && approxEqual(t.amount, amount)) return true;
          return false;
        });
        if (existing) return res.status(200).json(existing);
      } catch (e) {
        console.warn('earning dedupe guard failed', e);
      }
    }

    // 3) Withdraw / Purchase / Admin_otp: avoid creating multiple pending withdraws or purchases for the same user+amount within short window
    if (col === 'transaction_v1' && ['withdraw','purchase','admin_otp'].includes(String(payload.type || '').toLowerCase())) {
      try {
        const typ = String(payload.type || '').toLowerCase();
        const userId = payload.user_id || payload.user_uid || payload.uid || null;
        const amount = payload.amount !== undefined ? Number(payload.amount) : null;
        const now = Date.now();

        // look for a recent pending-like tx of same type for the user within last 2 minutes (to avoid retries causing duplicates)
        const recent = (collection || []).find(t => {
          if (String(t.type || '').toLowerCase() !== typ) return false;
          const st = String((t.status || '')).toLowerCase();
          // pending-like statuses for these types
          const pendingLike = st === 'awaiting_deposit' || st === 'pending' || st === 'otp_sent';
          if (!pendingLike) return false;
          const sameUser = userId && (String(t.user_id) === String(userId) || String(t.user_uid) === String(userId));
          if (!sameUser) return false;
          if (amount !== null && typeof t.amount !== 'undefined' && !approxEqual(t.amount, amount)) return false;
          const createdAt = new Date(t.created_at || t.updated_at || now).getTime();
          if ((now - createdAt) > 1000 * 60 * 2) return false; // older than 2 minutes -> not recent
          return true;
        });
        if (recent) return res.status(200).json(recent);
      } catch (e) {
        console.warn('withdraw/purchase dedupe guard failed', e);
      }
    }

    // Final safety re-check for deposits immediately before creating (race protection)
    if (col === 'transaction_v1' && String(payload.type || '').toLowerCase() === 'deposit') {
      try {
        const userId = payload.user_id || payload.user_uid || payload.uid || null;
        const amount = payload.amount !== undefined ? Number(payload.amount) : null;
        const network = payload.network ? String(payload.network).toLowerCase() : null;
        const existing = (collection || []).find(t => {
          if (String(t.type || '').toLowerCase() !== 'deposit') return false;
          const st = String((t.status || '')).toLowerCase();
          const pendingLike = st === 'awaiting_deposit' || st === 'pending' || st === 'otp_sent';
          if (!pendingLike) return false;
          const sameUser = userId && (String(t.user_id) === String(userId) || String(t.user_uid) === String(userId) || String(t.uid) === String(userId));
          if (!sameUser) return false;
          if (amount !== null && typeof t.amount !== 'undefined' && !approxEqual(t.amount, amount)) return false;
          if (network && t.network && String(t.network).toLowerCase() !== network) return false;
          return true;
        });
        if (existing) return res.status(200).json(existing);
      } catch (e) {
        console.warn('final deposit re-check failed', e);
      }
    }

    // create record with id and timestamps (preserve any client-supplied idempotency_key)
    // Enforce server policy: do not create deposits with 'awaiting_deposit' — normalize to 'pending'
    try {
      if (col === 'transaction_v1' && String(payload.type || '').toLowerCase() === 'deposit') {
        payload.status = 'pending';
      }
    } catch (e) { /* best-effort normalization */ }

    const { nanoid } = require('./db');
    const now = new Date().toISOString();
    const rec = Object.assign({}, payload, { id: nanoid(), created_at: payload.created_at || now, updated_at: payload.updated_at || now });
    if (payload.idempotency_key && !rec.idempotency_key) rec.idempotency_key = payload.idempotency_key;

    collection.unshift(rec);
    try { await write(); } catch(e){ console.warn('write failed after create', e); }

    // Post-create race-resolve: for deposits return earliest matching pending-like record if one exists
    if (col === 'transaction_v1' && String(rec.type || '').toLowerCase() === 'deposit') {
      try {
        const userId = rec.user_id || rec.user_uid || rec.uid || null;
        const amount = rec.amount !== undefined ? Number(rec.amount) : null;
        const network = rec.network ? String(rec.network).toLowerCase() : null;
        const list = getCollection('transaction_v1') || [];
        const match = list.find(t => {
          if (String(t.type || '').toLowerCase() !== 'deposit') return false;
          const st = String((t.status || '')).toLowerCase();
          const pendingLike = st === 'awaiting_deposit' || st === 'pending' || st === 'otp_sent';
          if (!pendingLike) return false;
          const sameUser = userId && (String(t.user_id) === String(userId) || String(t.user_uid) === String(userId) || String(t.uid) === String(userId));
          if (!sameUser) return false;
          if (amount !== null && typeof t.amount !== 'undefined' && !approxEqual(t.amount, amount)) return false;
          if (network && t.network && String(t.network).toLowerCase() !== network) return false;
          return true;
        });
        if (match && String(match.id) !== String(rec.id)) return res.status(200).json(match);
      } catch (e) {
        console.warn('post-create deposit dedupe check failed', e);
      }
    }

    return res.status(201).json(rec);
  } catch (e) {
    console.error('collections POST error', e);
    return res.status(500).json({ error: 'internal' });
  }
});

app.patch('/api/collections/:col/:id', async (req, res) => {
  try {
    const col = String(req.params.col || '').trim();
    const id = String(req.params.id || '').trim();
    const payload = req.body || {};
    const collection = getCollection(col);
    const idx = collection.findIndex(r => String(r.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'not_found' });

    // Protect deposits: do not allow clients to mark deposits as credited/confirmed/accredited
    try {
      const existing = collection[idx];
      if (col === 'transaction_v1' && String(existing.type || '').toLowerCase() === 'deposit') {
        const incomingStatus = (payload.status || '').toString().toLowerCase();
        const incomingCredited = payload.credited === true || String(payload.credited) === 'true';
        if (incomingCredited || incomingStatus === 'confirmed' || incomingStatus === 'accredited') {
          // sanitize client attempt
          delete payload.credited;
          delete payload.credited_at;
          if (incomingStatus === 'rejected') {
            payload.status = 'rejected';
            payload.rejected_at = payload.rejected_at || new Date().toISOString();
            payload.credited = false;
            payload.credited_at = null;
            payload.note = (payload.note || '') + ' (client accreditation prevented)';
          } else {
            payload.status = existing.status || 'pending';
            payload.note = (payload.note || '') + ' (client accreditation prevented)';
          }
        }
      }
    } catch (guardErr) {
      console.warn('deposit guard error', guardErr);
    }

    // merge and persist
    const now = new Date().toISOString();
    const merged = Object.assign({}, collection[idx], payload, { updated_at: now });
    collection[idx] = merged;
    try { await write(); } catch(e){ console.warn('write failed after patch', e); }
    return res.json(merged);
  } catch (e) {
    console.error('collections PATCH error', e);
    return res.status(500).json({ error: 'internal' });
  }
});

// DELETE: allow deletes for non-user collections; block user account deletion centrally
app.delete('/api/collections/:col/:id', async (req, res) => {
  try {
    const col = String(req.params.col || '').trim();
    const id = String(req.params.id || '').trim();

    // Block deletion of user_v1 accounts (deactivate instead)
    if (col === 'user_v1') {
      try {
        const users = getCollection('user_v1');
        const user = users.find(u => String(u.id) === String(id));
        if (user) {
          user.deactivated = true;
          user.deactivated_at = new Date().toISOString();
          try { await write(); } catch(e){}
        }
      } catch (e) { /* ignore */ }
      return res.status(200).json({ ok: false, error: 'deletion_blocked', message: 'User deletion is blocked; account was deactivated instead.' });
    }

    const collection = getCollection(col);
    const idx = collection.findIndex(r => String(r.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'not_found' });
    collection.splice(idx, 1);
    try { await write(); } catch(e){ console.warn('write failed after delete', e); }
    return res.json({ ok: true });
  } catch (e) {
    console.error('collections DELETE error', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * Admin helper endpoint: approve a pending user.
 * POST /api/users/approve
 * body: { id: "<user id>" }
 * This centralizes the approve action so admin UI can call one endpoint to activate accounts.
 */
app.post('/api/users/approve', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'missing id' });
    try {
      const { getCollection, write } = require('./db');
      const users = getCollection('user_v1');
      const user = users.find(u => String(u.id) === String(id) || String(u.user_uid) === String(id));
      if (!user) return res.status(404).json({ error: 'not_found' });
      user.approved = true;
      user.deactivated = false;
      user.approved_at = new Date().toISOString();
      user.updated_at = new Date().toISOString();
      await write();
      return res.json({ ok: true, user });
    } catch (e) {
      console.error('approve user failed', e);
      return res.status(500).json({ error: 'internal' });
    }
  } catch (e) {
    console.error('approve endpoint error', e);
    return res.status(500).json({ error: 'internal' });
  }
});

/**
 * Cleanup endpoint: remove duplicate transactions and duplicate admin-action records.
 * POST /api/clean/duplicates
 * - Scans transaction_v1 and removes duplicate records per-user where duplicates are defined
 *   as same user identifier + type + amount + calendar day + (optional note) — keeps the earliest created record.
 * - Also cleans duplicate 'admin_action' transaction records using the same matching rules.
 * - Returns a summary report of removed IDs per collection.
 *
 * This endpoint is intended to be an admin tool invoked once to "clean only duplicates".
 */
app.post('/api/clean/duplicates', async (req, res) => {
  try {
    const { getCollection, write } = require('./db');

    const txs = getCollection('transaction_v1');
    if (!Array.isArray(txs)) return res.status(500).json({ error: 'transaction collection missing' });

    // Helper: normalize a key for deduping
    const dayString = (d) => {
      try { return new Date(d || '').toISOString().slice(0,10); } catch(e){ return ''; }
    };
    const approx = (n) => (typeof n === 'number' ? Number(n) : (Number(n) || 0));

    const removedIds = [];
    const seen = new Map();

    // iterate in original order (oldest last in array? lowdb pushes/unshifts may vary) - keep earliest created_at
    // Build list sorted by created_at ascending so first occurrence is earliest
    const sorted = txs.slice().sort((a,b)=>{
      const ta = new Date(a.created_at || a.updated_at || 0).getTime();
      const tb = new Date(b.created_at || b.updated_at || 0).getTime();
      return ta - tb;
    });

    for (const t of sorted) {
      try {
        const userId = t.user_id || t.user_uid || t.uid || '__anon__';
        const typ = String(t.type || '').toLowerCase();
        const amt = approx(t.amount);
        const day = dayString(t.created_at || t.updated_at || '');
        // include note when available to avoid collapsing distinct semantic entries, but trim length
        const note = t.note ? String(t.note).slice(0,120) : '';
        const key = `${userId}||${typ}||${amt.toFixed(6)}||${day}||${note}`;

        if (!seen.has(key)) {
          seen.set(key, t.id);
        } else {
          // Found duplicate (same key) -> mark for removal
          removedIds.push(t.id);
        }
      } catch(e){
        // best-effort: skip problematic record
        console.warn('dedupe iterate failed for tx id', t && t.id, e);
      }
    }

    // filter out removed ids from the actual collection array
    if (removedIds.length) {
      for (let i = txs.length - 1; i >= 0; i--) {
        if (removedIds.includes(String(txs[i].id))) {
          txs.splice(i, 1);
        }
      }
    }

    // Additionally, perform a lightweight OTP dedupe (same tx_id + code) to avoid orphan duplicates
    const otps = getCollection('otp_v1') || [];
    const otpRemoved = [];
    try {
      const otpSeen = new Set();
      // keep earliest OTP per tx_id+code
      const otpSorted = otps.slice().sort((a,b)=>{
        const ta = new Date(a.created_at || a.updated_at || 0).getTime();
        const tb = new Date(b.created_at || b.updated_at || 0).getTime();
        return ta - tb;
      });
      for (const o of otpSorted) {
        const k = `${o.tx_id || ''}||${o.code || ''}`;
        if (!otpSeen.has(k)) otpSeen.add(k);
        else otpRemoved.push(o.id);
      }
      if (otpRemoved.length) {
        for (let i = otps.length - 1; i >= 0; i--) {
          if (otpRemoved.includes(String(otps[i].id))) otps.splice(i,1);
        }
      }
    } catch(e){
      console.warn('otp dedupe failed', e);
    }

    // Persist changes
    try { await write(); } catch(e){ console.warn('write after dedupe failed', e); }

    return res.json({
      ok: true,
      removed_transactions: removedIds.length,
      removed_transaction_ids: removedIds,
      removed_otps: otpRemoved.length,
      removed_otp_ids: otpRemoved
    });
  } catch (e) {
    console.error('clean duplicates error', e);
    return res.status(500).json({ error: 'internal' });
  }
});

// API routes (users remain handled by routes/users)
app.use('/api/users', usersRoutes);

// Serve static SPA (root folder)
app.use(express.static(path.join(__dirname, '..')));

// fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
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