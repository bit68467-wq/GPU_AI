const { nanoid, getCollection, write, generate6UniqueUserUid } = require('../db');

async function register(req, res) {
  try {
    // accept optional invite_code
    const { username, email, password } = req.body || {};
    // accept invite_code from several possible client field names for compatibility
    const invite_code = (req.body && (req.body.invite_code || req.body.invite || req.body.invite_code_input)) || null;
    if (!username || !email || !password) return res.status(400).json({ error: 'missing fields' });

    const users = getCollection('user_v1');
    if (users.find(u => String(u.email).toLowerCase() === String(email).toLowerCase())) {
      return res.status(409).json({ error: 'email exists' });
    }

    const now = new Date().toISOString();
    // generate persistent numeric UID and reuse it as the user's fixed invite_code
    const user_uid = generate6UniqueUserUid();
    const user = {
      id: nanoid(),
      username,
      email: String(email).toLowerCase(),
      password,
      user_uid: user_uid,
      invite_code: user_uid,
      referrer_a: null,
      referrer_b: null,
      referrer_c: null,
      deactivated: false,
      created_at: now,
      updated_at: now
    };

    // If an invite_code was supplied, try to resolve inviter and assign referral chain
    if (invite_code) {
      const inviter = users.find(u => String(u.invite_code) === String(invite_code) || String(u.user_uid) === String(invite_code));
      if (inviter) {
        user.referrer_a = inviter.user_uid || inviter.uid || inviter.id || null;
        // cascade up: inviter.referrer_a -> this user's referrer_b, inviter.referrer_b -> referrer_c
        user.referrer_b = inviter.referrer_a || inviter.referrer_b || null;
        user.referrer_c = inviter.referrer_b || null;
      }
    }

    users.push(user);
    await write();

    // Create referral reward transactions for up to 3 levels (best-effort)
    try {
      const txs = getCollection('transaction_v1');
      const nowTx = new Date().toISOString();
      // define flat referral rewards (demo values)
      const rewards = { a: 5, b: 3, c: 1 };
      if (user.referrer_a) {
        // find user record for referrer to attach real user_id if available
        const ra = users.find(u => String(u.user_uid) === String(user.referrer_a) || String(u.id) === String(user.referrer_a));
        const raId = (ra && ra.id) ? ra.id : user.referrer_a;
        txs.unshift({
          id: nanoid(),
          user_id: raId,
          type: 'earning',
          amount: rewards.a,
          created_at: nowTx,
          note: `Referral level A reward for inviting ${user.user_uid}`
        });
      }
      if (user.referrer_b) {
        const rb = users.find(u => String(u.user_uid) === String(user.referrer_b) || String(u.id) === String(user.referrer_b));
        const rbId = (rb && rb.id) ? rb.id : user.referrer_b;
        txs.unshift({
          id: nanoid(),
          user_id: rbId,
          type: 'earning',
          amount: rewards.b,
          created_at: nowTx,
          note: `Referral level B reward for invited ${user.user_uid}`
        });
      }
      if (user.referrer_c) {
        const rc = users.find(u => String(u.user_uid) === String(user.referrer_c) || String(u.id) === String(user.referrer_c));
        const rcId = (rc && rc.id) ? rc.id : user.referrer_c;
        txs.unshift({
          id: nanoid(),
          user_id: rcId,
          type: 'earning',
          amount: rewards.c,
          created_at: nowTx,
          note: `Referral level C reward for invited ${user.user_uid}`
        });
      }
      await write();
    } catch(e){
      console.warn('referral reward creation failed', e);
    }

    return res.status(201).json({ id: user.id, username: user.username, email: user.email, user_uid: user.user_uid, invite_code: user.invite_code });
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

    // block login if account has been deactivated: ensure permanence requires explicit admin reactivation
    if (user.deactivated) return res.status(403).json({ error: 'account_deactivated' });

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

    // set cookie when possible
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