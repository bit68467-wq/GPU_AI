const { nanoid, getCollection, write, generate6UniqueUserUid } = require('../db');

/**
 * New policy: all registrations create a pending/unapproved user that must be activated by an admin.
 * - created users are marked deactivated: true and approved: false
 * - login is blocked until an admin approves the account
 */

async function register(req, res) {
  try {
    const { username, email, password } = req.body || {};
    const invite_code = (req.body && (req.body.invite_code || req.body.invite || req.body.invite_code_input)) || null;
    if (!username || !email || !password) return res.status(400).json({ error: 'missing fields' });

    const users = getCollection('user_v1');
    if (users.find(u => String(u.email).toLowerCase() === String(email).toLowerCase())) {
      return res.status(409).json({ error: 'email exists' });
    }

    const now = new Date().toISOString();
    const user_uid = generate6UniqueUserUid();

    // New: create user as deactivated/unapproved so admin centrally manages activation
    const user = {
      id: nanoid(),
      username,
      email: String(email).toLowerCase(),
      password,
      user_uid,
      invite_code: user_uid,
      referrer_a: null,
      referrer_b: null,
      referrer_c: null,
      deactivated: true,    // blocked by default until admin review
      approved: false,      // explicit approval flag
      approval_requested_at: now,
      created_at: now,
      updated_at: now
    };

    if (invite_code) {
      const inviter = users.find(u => String(u.invite_code) === String(invite_code) || String(u.user_uid) === String(invite_code));
      if (inviter) {
        user.referrer_a = inviter.user_uid || inviter.uid || inviter.id || null;
        user.referrer_b = inviter.referrer_a || inviter.referrer_b || null;
        user.referrer_c = inviter.referrer_b || null;
      }
    }

    users.push(user);
    await write();

    // Do NOT create referral rewards automatically until admin approves the account.
    // Inform client the account is pending approval.
    return res.status(201).json({
      id: user.id,
      username: user.username,
      email: user.email,
      user_uid: user.user_uid,
      invite_code: user.invite_code,
      message: 'account_created_pending_approval'
    });
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ error: 'internal' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing fields' });

    const users = getCollection('user_v1');
    const user = users.find(u => u.email === String(email).toLowerCase() && u.password === password);
    if (!user) return res.status(401).json({ error: 'invalid credentials' });

    // Block login until admin explicitly approves the account
    if (!user.approved || user.deactivated) {
      return res.status(403).json({ error: 'account_pending_approval', message: 'Account pending admin approval' });
    }

    // create or update session
    const sessions = getCollection('session_v1');
    const now = new Date().toISOString();
    const token = nanoid();
    let session = sessions.find(s => String(s.uid) === String(user.user_uid) || String(s.user_id) === String(user.id));
    if (session) {
      Object.assign(session, { user_id: user.id, uid: user.user_uid, username: user.username, email: user.email, updated_at: now, token });
    } else {
      session = { id: nanoid(), user_id: user.id, uid: user.user_uid, username: user.username, email: user.email, token, created_at: now, updated_at: now };
      sessions.push(session);
    }
    await write();

    try { res.cookie && res.cookie('cup9gpu_token', token, { httpOnly: true, sameSite: 'lax' }); } catch(e){}

    return res.json({ token, session_id: session.id, uid: session.uid, username: session.username, email: session.email, user_id: session.user_id });
  } catch (e) {
    console.error('login error', e);
    return res.status(500).json({ error: 'internal' });
  }
}

async function findByUid(req, res) {
  try {
    const uid = req.params.uid;
    const users = getCollection('user_v1');
    const found = users.find(u => String(u.user_uid) === String(uid) || String(u.id) === String(uid));
    if (!found) return res.status(404).json({ error: 'not found' });
    return res.json(found);
  } catch (e) {
    console.error('findByUid error', e);
    return res.status(500).json({ error: 'internal' });
  }
}

module.exports = {
  register,
  login,
  findByUid
};