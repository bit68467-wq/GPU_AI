/*
 Unified API client.
 If window.CUP9_API_BASE is defined -> uses real HTTP.
 Otherwise uses internal mock backend implemented below (WebSIM mode).
 The API always exposes async functions with the same signatures as a REST backend.
*/

/*
 API base selection:
 - If window.CUP9_API_BASE is set by the host page before loading the app, use that (real backend).
 - Otherwise run in WebSIM/mock mode (local in-memory DB).
*/
const API_BASE = (typeof window !== 'undefined' && window.CUP9_API_BASE) ? String(window.CUP9_API_BASE) : null;

/* Simple in-memory mock DB for WebSIM mode (enabled when CUP9_API_BASE is NOT set).
   This provides predictable behavior for auth, sessions, users, GPUs and transactions,
   so the UI works without loops or unexpected errors.
*/
const isMock = !API_BASE;

// Persisted mock DB key
const MOCK_DB_KEY = 'CUP9_MOCK_DB_V1';

// Helper to create a fresh DB shape
function freshMockDB(){
  return {
    now: () => new Date().toISOString(),
    users: {},          // keyed by userId
    sessions: {},       // keyed by token -> { userId, deviceId, created_at }
    gpus: {},           // keyed by gpuId
    transactions: {},   // keyed by txId
    notifications: {},  // keyed by noteId
    otpStore: {}        // optional mapping txId -> otp
  };
}

// Load persisted mock DB from localStorage if present (so data survives reloads)
let db = null;
if(isMock){
  try{
    const raw = localStorage.getItem(MOCK_DB_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      // restore shape and provide now() helper
      db = Object.assign(freshMockDB(), parsed);
    } else {
      db = freshMockDB();
      // seed small diagnostics if absent
      try{ localStorage.setItem(MOCK_DB_KEY, JSON.stringify({ users:{}, sessions:{}, gpus:{}, transactions:{}, notifications:{}, otpStore:{} })); }catch(e){}
    }
  }catch(e){
    // fallback to in-memory only if parse fails
    console.warn('CUP9: failed to load persisted mock DB, using fresh in-memory DB', e);
    db = freshMockDB();
  }
} else {
  db = null;
}

// Save helper to persist mock DB to localStorage after any mutation
function saveMockDB(){
  try{
    if(!isMock || !db) return;
    // Only persist the serializable parts (exclude functions like now)
    const snapshot = {
      users: db.users || {},
      sessions: db.sessions || {},
      gpus: db.gpus || {},
      transactions: db.transactions || {},
      notifications: db.notifications || {},
      otpStore: db.otpStore || {}
    };
    localStorage.setItem(MOCK_DB_KEY, JSON.stringify(snapshot));

    // Mirror key application-level stores so UI using localStorage backend stays in sync with mock DB.
    try{
      // Users -> CUP9_USERS (array)
      const usersArr = Object.values(db.users || {}).map(u => ({
        id: u.id,
        email: u.email,
        role: u.role,
        created_at: u.created_at,
        balance: u.balance || 0,
        // preserve any demo/debug fields if present
        meta: u.meta || {}
      }));
      localStorage.setItem('CUP9_USERS', JSON.stringify(usersArr));
    }catch(e){ console.warn('CUP9: mirror users to CUP9_USERS failed', e); }

    try{
      // Transactions -> CUP9_TRANSACTIONS (array)
      const txArr = Object.values(db.transactions || {}).map(t => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount || 0),
        txhash: t.txhash || (t.meta && t.meta.txhash) || '',
        created_at: t.created_at || new Date().toISOString(),
        status: t.status || 'accredited',
        email: t.email || '',
        meta: t.meta || {}
      }));
      // preserve existing local transactions and append any new ones idempotently
      const existingRaw = localStorage.getItem('CUP9_TRANSACTIONS') || '[]';
      let existing = [];
      try{ existing = JSON.parse(existingRaw) || []; }catch(e){ existing = []; }
      const existingIds = new Set((existing || []).map(x => x.id));
      for(const tx of txArr){
        if(!existingIds.has(tx.id)) existing.push(tx);
      }
      localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(existing));
    }catch(e){ console.warn('CUP9: mirror transactions to CUP9_TRANSACTIONS failed', e); }

    try{
      // GPUs -> CUP9_OWNED_GPUS (array)
      const gArr = Object.values(db.gpus || {}).map(g => ({
        id: g.id,
        name: g.name,
        model: g.model,
        status: g.status,
        assigned_at: g.assigned_at,
        ownerId: g.ownerId || null,
        price_per_hour: Number(g.price_per_hour || 0),
        meta: g.meta || {}
      }));
      const existingG = localStorage.getItem('CUP9_OWNED_GPUS') || '[]';
      let owned = [];
      try{ owned = JSON.parse(existingG) || []; }catch(e){ owned = []; }
      const ownedIds = new Set((owned || []).map(x => x.id));
      for(const g of gArr){
        if(!ownedIds.has(g.id)) owned.push(g);
        else {
          // merge shallow missing fields without overwriting existing local data
          const idx = owned.findIndex(x=>x.id===g.id);
          if(idx !== -1){
            owned[idx] = Object.assign({}, g, owned[idx], { meta: Object.assign({}, g.meta || {}, owned[idx].meta || {}) });
          }
        }
      }
      localStorage.setItem('CUP9_OWNED_GPUS', JSON.stringify(owned));
    }catch(e){ console.warn('CUP9: mirror gpus to CUP9_OWNED_GPUS failed', e); }

    try{
      // Earnings map mirror (build from accredited txs)
      const earnings = JSON.parse(localStorage.getItem('CUP9_EARNINGS') || '{}') || {};
      // scan db.transactions for accredited earnings and aggregate by email
      for(const t of Object.values(db.transactions || {})){
        try{
          const typ = String(t.type || '').toLowerCase();
          const st = String(t.status || '').toLowerCase();
          if((typ === 'scheduled_earning' || typ === 'earning' || typ === 'checkin' || typ === 'contract_dividend' || typ === 'claim') && (st === 'accredited' || st === 'confirmed')){
            const em = String(t.email || '').toLowerCase();
            if(!em) continue;
            earnings[em] = Number((Number(earnings[em] || 0) + Number(t.amount || 0)).toFixed(8));
          }
        }catch(e){}
      }
      localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
      // Emit UI update events so recent actions and balances refresh after mock DB persist.
      try{
        // notify transaction list update
        if(typeof notify === 'function'){
          try{ notify('tx:changed', JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]')); }catch(e){}
          // notify withdrawable/earnings change for each updated email
          try{
            const earningsMap = JSON.parse(localStorage.getItem('CUP9_EARNINGS') || '{}') || {};
            for(const em in earningsMap){
              try{ notify('balance:withdrawable:changed', { email: em, withdrawable: earningsMap[em] }); }catch(e){}
            }
          }catch(e){}
          // notify persistent user balance changes if CUP9_USERS present
          try{
            const usersArr = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]') || [];
            for(const u of usersArr){
              try{ notify('balance:changed', { email: String(u.email||'').toLowerCase(), balance: u.balance || 0 }); }catch(e){}
            }
          }catch(e){}
        } else if(window && window.dispatchEvent){
          // Fallback DOM event for integrators: a generic custom event indicating mockDB update
          try{ window.dispatchEvent(new CustomEvent('CUP9:mockdb:updated')); }catch(e){}
        }
      }catch(e){
        console.warn('CUP9: mock DB UI notify failed', e);
      }
    }catch(e){ console.warn('CUP9: mirror earnings failed', e); }

  }catch(e){
    console.warn('CUP9: failed to persist mock DB', e);
  }
}

/* Minimal helpers */
function gen(prefix='id'){ return prefix + Math.random().toString(36).slice(2,10); }
function sanitizeUser(user){
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
    avatar_url: `https://images.websim.com/avatar/${encodeURIComponent((user.email||'').split('@')[0]||'user')}`
  };
}

/* ---- HTTP wrapper for production mode ---- */
async function httpPost(path, body, token){
  const url = (API_BASE || '') + path;
  const headers = { 'Content-Type':'application/json' };
  if(token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { method:'POST', headers, body: JSON.stringify(body) });
  if(!res.ok){
    const text = await res.text();
    let err;
    try{ err = JSON.parse(text); }catch(e){ err = { message: text || res.statusText } }
    throw { status:res.status, message: err.message || res.statusText };
  }
  return res.json();
}

/* ---- Mock API implementation (only used when isMock === true) ---- */
const mockApi = {
  async register({email,password}){
    if(!isMock) throw { status:500, message:'Mock disabled' };
    if(!email || !password) throw { status:400, message: 'email & password required' };
    const existing = Object.values(db.users).find(u => u.email === email.toLowerCase());
    if(existing) throw { status:409, message: 'User already exists' };
    const id = 'u_' + gen(6);
    const user = { id, email: email.toLowerCase(), password, role:'user', balance:0, created_at: db.now() };
    db.users[id] = user;
    // persist mock DB
    try{ saveMockDB(); }catch(e){}
    return { user: sanitizeUser(user) };
  },

  async login({email,password,deviceId}){
    if(!isMock) throw { status:500, message:'Mock disabled' };
    if(!email || !password) throw { status:400, message: 'email & password required' };
    const user = Object.values(db.users).find(u => u.email === email.toLowerCase());
    if(!user || user.password !== password) throw { status:401, message: 'Invalid credentials' };
    const token = 'tok_' + gen(8);
    db.sessions[token] = { userId: user.id, deviceId: deviceId || null, created_at: db.now() };
    try{ saveMockDB(); }catch(e){}
    return { token, user: sanitizeUser(user) };
  },

  async loginTelegram({deviceId}){
    if(!isMock) throw { status:500, message:'Mock disabled' };
    const device = deviceId || ('d_' + gen(6));
    const telegramEmail = `telegram:${device}@telegram.local`;
    let user = Object.values(db.users).find(u => u.email === telegramEmail);
    if(!user){
      const id = 'u_' + gen(6);
      user = { id, email: telegramEmail, password: null, role:'user', balance:0, created_at: db.now() };
      db.users[id] = user;
    }
    const token = 'tok_' + gen(8);
    db.sessions[token] = { userId: user.id, deviceId: device, created_at: db.now() };
    try{ saveMockDB(); }catch(e){}
    return { token, user: sanitizeUser(user) };
  },

  async me({token}){
    if(!isMock) throw { status:500, message:'Mock disabled' };
    if(!token) throw { status:401, message: 'Not authenticated' };
    const s = db.sessions[token];
    if(!s) throw { status:401, message: 'Invalid session' };
    const user = db.users[s.userId];
    if(!user) throw { status:401, message: 'User not found' };
    return { user: sanitizeUser(user), session: { token, deviceId: s.deviceId, created_at: s.created_at } };
  },

  async logout({token}){
    if(!isMock) throw { status:500, message:'Mock disabled' };
    if(token && db.sessions[token]) delete db.sessions[token];
    return { ok:true };
  }
};

/* ---- Public client API (same signatures for both modes) ---- */
export const api = {
  async register({email,password}){
    if(API_BASE){
      // call real backend
      const resp = await httpPost('/auth/register',{email,password});
      // mirror minimal user into localStorage-backed mock snapshot for durability/cross-tab visibility
      try{
        const usersRaw = localStorage.getItem('CUP9_USERS') || '[]';
        const users = JSON.parse(usersRaw);
        const u = resp && resp.user ? resp.user : null;
        if(u){
          // avoid duplicate by email
          if(!users.find(x=>String(x.email||'').toLowerCase() === String(u.email||'').toLowerCase())){
            users.push({ id: u.id || ('u_'+Math.random().toString(36).slice(2,9)), email: u.email, role: u.role || 'user', created_at: u.created_at || new Date().toISOString(), balance: 0 });
            localStorage.setItem('CUP9_USERS', JSON.stringify(users));
          }
        }
      }catch(e){ console.warn('mirror register to localStorage failed', e); }
      return resp;
    }
    return mockApi.register({email,password});
  },

  async login({email,password,deviceId}){
    if(API_BASE){
      const resp = await httpPost('/auth/login',{email,password,deviceId});
      // mirror into local users and session for offline / local UI consistency
      try{
        const usersRaw = localStorage.getItem('CUP9_USERS') || '[]';
        const users = JSON.parse(usersRaw);
        const u = resp && resp.user ? resp.user : null;
        if(u && !users.find(x=>String(x.email||'').toLowerCase() === String(u.email||'').toLowerCase())){
          users.push({ id: u.id || ('u_'+Math.random().toString(36).slice(2,9)), email: u.email, role: u.role || 'user', created_at: u.created_at || new Date().toISOString(), balance: 0 });
          localStorage.setItem('CUP9_USERS', JSON.stringify(users));
        }
        // persist per-device token mapping for compatibility with auth.js helpers
        try{
          const deviceIdLocal = deviceId || localStorage.getItem('cup9:deviceId') || ('d_'+Math.random().toString(36).slice(2,9));
          const devs = JSON.parse(localStorage.getItem('cup9:devices') || '{}');
          devs[deviceIdLocal] = { token: resp.token, updated_at: new Date().toISOString() };
          localStorage.setItem('cup9:devices', JSON.stringify(devs));
        }catch(e){}
      }catch(e){ console.warn('mirror login to localStorage failed', e); }
      return resp;
    }
    return mockApi.login({email,password,deviceId});
  },

  async loginTelegram({deviceId}){
    if(API_BASE){
      const resp = await httpPost('/auth/loginTelegram',{deviceId});
      try{
        const usersRaw = localStorage.getItem('CUP9_USERS') || '[]';
        const users = JSON.parse(usersRaw);
        const u = resp && resp.user ? resp.user : null;
        if(u && !users.find(x=>String(x.email||'').toLowerCase() === String(u.email||'').toLowerCase())){
          users.push({ id: u.id || ('u_'+Math.random().toString(36).slice(2,9)), email: u.email, role: u.role || 'user', created_at: u.created_at || new Date().toISOString(), balance: 0 });
          localStorage.setItem('CUP9_USERS', JSON.stringify(users));
        }
        const deviceIdLocal = deviceId || localStorage.getItem('cup9:deviceId') || ('d_'+Math.random().toString(36).slice(2,9));
        const devs = JSON.parse(localStorage.getItem('cup9:devices') || '{}');
        devs[deviceIdLocal] = { token: resp.token, updated_at: new Date().toISOString() };
        localStorage.setItem('cup9:devices', JSON.stringify(devs));
      }catch(e){ console.warn('mirror loginTelegram to localStorage failed', e); }
      return resp;
    }
    return mockApi.loginTelegram({deviceId});
  },

  async me({token}){
    if(API_BASE){
      const resp = await httpPost('/auth/me',{}, token);
      // mirror minimal session/user into local storage for UI continuity
      try{
        const u = resp && resp.user ? resp.user : null;
        if(u){
          const usersRaw = localStorage.getItem('CUP9_USERS') || '[]';
          const users = JSON.parse(usersRaw);
          if(!users.find(x=>String(x.email||'').toLowerCase() === String(u.email||'').toLowerCase())){
            users.push({ id: u.id || ('u_'+Math.random().toString(36).slice(2,9)), email: u.email, role: u.role || 'user', created_at: u.created_at || new Date().toISOString(), balance: 0 });
            localStorage.setItem('CUP9_USERS', JSON.stringify(users));
          }
        }
        // persist current session like auth.writeCurrentSession expects
        try{
          const session = { userId: (resp.user && resp.user.id) || null, email: (resp.user && resp.user.email) || null, token: token, deviceId: localStorage.getItem('cup9:deviceId') || null, created_at: new Date().toISOString() };
          localStorage.setItem('CURRENT_USER', JSON.stringify(session));
        }catch(e){}
      }catch(e){ console.warn('mirror me to localStorage failed', e); }
      return resp;
    }
    return mockApi.me({token});
  },

  async logout({token}){
    if(API_BASE){
      const resp = await httpPost('/auth/logout',{}, token);
      // clear per-device token mapping in localStorage for this token if present
      try{
        const devs = JSON.parse(localStorage.getItem('cup9:devices') || '{}');
        for(const k of Object.keys(devs || {})){
          try{ if(devs[k] && devs[k].token === token) { devs[k].token = null; devs[k].updated_at = new Date().toISOString(); } }catch(e){}
        }
        localStorage.setItem('cup9:devices', JSON.stringify(devs));
        localStorage.removeItem('CURRENT_USER');
      }catch(e){ console.warn('mirror logout local cleanup failed', e); }
      return resp;
    }
    return mockApi.logout({token});
  },

  // Admin helper: restore expired withdraw transactions for a given email back to awaiting_otp.
  // When running against a real backend this calls a protected admin endpoint; in mock mode it performs
  // the same localStorage adjustments and notifications as previous local-only code.
  async adminRestoreWithdraws({ email, token }){
    if(API_BASE){
      // call backend admin endpoint; backend should implement idempotent restore behavior.
      return httpPost('/admin/restore_withdraws', { email }, token);
    }
    // Mock/local behavior: mirror previous local restoration for expired withdraws for the specified email.
    try{
      const TARGET = String(email || '').toLowerCase();
      const TX_KEY = 'CUP9_TRANSACTIONS';
      const EARNINGS_KEY = 'CUP9_EARNINGS';
      const USERS_KEY = 'CUP9_USERS';

      function readTxs(){ try{ return JSON.parse(localStorage.getItem(TX_KEY) || '[]'); }catch(e){ return []; } }
      function writeTxs(txs){ try{ localStorage.setItem(TX_KEY, JSON.stringify(txs||[])); }catch(e){} }
      function readEarnings(){ try{ return JSON.parse(localStorage.getItem(EARNINGS_KEY) || '{}'); }catch(e){ return {}; } }
      function writeEarnings(obj){ try{ localStorage.setItem(EARNINGS_KEY, JSON.stringify(obj||{})); }catch(e){} }
      function readUsers(){ try{ return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); }catch(e){ return []; } }
      function writeUsers(u){ try{ localStorage.setItem(USERS_KEY, JSON.stringify(u||[])); }catch(e){} }

      let txs = readTxs();
      let modified = false;
      for(const t of txs){
        try{
          const typ = String(t.type||'').toLowerCase();
          const st = String(t.status||'').toLowerCase();
          const em = String(t.email||'').toLowerCase();
          if(typ === 'withdraw' && st === 'expired' && em === TARGET){
            const amt = Number(t.amount || 0);
            if(amt && !isNaN(amt)){
              const earnings = readEarnings();
              earnings[em] = Number((Number(earnings[em] || 0) + Number(amt)).toFixed(8));
              writeEarnings(earnings);
              try{ if(window && window.notify) notify('balance:withdrawable:changed', { email: em, withdrawable: earnings[em] }); }catch(e){}
              try{
                const users = readUsers();
                const idx = users.findIndex(u=> String(u.email || '').toLowerCase() === em);
                if(idx !== -1){
                  users[idx].balance = Number(Math.max(0, Number(users[idx].balance || 0) + Number(amt)).toFixed(8));
                  writeUsers(users);
                  try{ if(window && window.notify) notify('balance:changed', { email: em, balance: users[idx].balance }); }catch(e){}
                }
              }catch(e){}
            }
            t.status = 'awaiting_otp';
            t.meta = t.meta || {};
            t.meta._reinstated_by_admin = new Date().toISOString();
            modified = true;
          }
        }catch(e){}
      }
      if(modified){
        writeTxs(txs);
        try{ if(window && window.notify) notify('tx:changed', readTxs()); }catch(e){}
        try{ if(window && window.toastMessage) window.toastMessage(`Restore withdraw expired -> awaiting_otp completato per ${TARGET}`, { type:'success', duration:5000 }); }catch(e){}
      }
      return { ok:true, restored: modified };
    }catch(e){
      console.error('adminRestoreWithdraws mock failed', e);
      return { ok:false, error: String(e) };
    }
  },

  /* ---- GPU-hosting related endpoints (mocked in WebSIM) ---- */
  async listGPUs({token}){
    if(API_BASE) return httpPost('/gpu/list',{}, token);
    const resp = await mockApi.me({token});
    const userId = resp.user.id;
    const gpus = Object.values(db.gpus || {}).filter(g => String(g.ownerId || '') === String(userId));
    return { gpus: gpus.map(sanitizeGpu) };
  },

  async createGPU({token, spec}){
    if(API_BASE){
      const resp = await httpPost('/gpu/create',{spec}, token);
      // mirror created GPU into local owned list for UI continuity
      try{
        const g = resp && resp.gpu ? resp.gpu : null;
        if(g){
          const ownedRaw = localStorage.getItem('CUP9_OWNED_GPUS') || '[]';
          const owned = JSON.parse(ownedRaw);
          if(!owned.find(x=>String(x.id) === String(g.id))){
            owned.push(Object.assign({}, g));
            localStorage.setItem('CUP9_OWNED_GPUS', JSON.stringify(owned));
          }
        }
      }catch(e){ console.warn('mirror createGPU to localStorage failed', e); }
      return resp;
    }
    const resp = await mockApi.me({token});
    const userId = resp.user.id;
    db.gpus = db.gpus || {};
    const gid = 'g' + gen(6);
    const gpu = {
      id: gid,
      name: spec.name || `gpu-${gid}`,
      model: spec.model || 'A100',
      status: 'idle',
      assigned_at: db.now(),
      ownerId: userId,
      price_per_hour: spec.price_per_hour || 1.5,
      meta: spec.meta || {}
    };
    db.gpus[gid] = gpu;
    db.transactions = db.transactions || {};
    const tid = 't' + gen(6);
    db.transactions[tid] = { id: tid, userId, type: 'create_gpu', amount: 0, created_at: db.now(), meta:{gpuId: gid} };
    try{ saveMockDB(); }catch(e){}
    return { gpu: sanitizeGpu(gpu) };
  },

  async updateGPU({token, gpuId, updates}){
    if(API_BASE){
      const resp = await httpPost('/gpu/update',{gpuId,updates}, token);
      // mirror update into local owned list if present
      try{
        const ownedRaw = localStorage.getItem('CUP9_OWNED_GPUS') || '[]';
        const owned = JSON.parse(ownedRaw);
        const idx = owned.findIndex(x=>String(x.id) === String(gpuId));
        if(idx !== -1){
          owned[idx] = Object.assign({}, owned[idx], updates, { meta: Object.assign({}, owned[idx].meta || {}, (updates.meta || {})) });
          localStorage.setItem('CUP9_OWNED_GPUS', JSON.stringify(owned));
        }
      }catch(e){ console.warn('mirror updateGPU to localStorage failed', e); }
      return resp;
    }
    const resp = await mockApi.me({token});
    const userId = resp.user.id;
    db.gpus = db.gpus || {};
    const g = db.gpus[gpuId];
    if(!g || String(g.ownerId || '') !== String(userId)) throw { status:404, message:'GPU not found' };
    Object.assign(g, updates);
    try{ saveMockDB(); }catch(e){}
    return { gpu: sanitizeGpu(g) };
  },

  async listTransactions({token}){
    if(API_BASE) return httpPost('/transactions/list',{}, token);
    const resp = await mockApi.me({token});
    const userId = resp.user.id;
    db.transactions = db.transactions || {};
    const tx = Object.values(db.transactions).filter(t=>String(t.userId||'')===String(userId||'')).sort((a,b)=>b.created_at.localeCompare(a.created_at));
    return { transactions: tx };
  },

  async createDeposit({token, amount}){
    if(API_BASE){
      const resp = await httpPost('/wallet/deposit',{amount}, token);
      // mirror deposit tx into local transactions store for UI history
      try{
        const tx = resp && resp.transaction ? resp.transaction : null;
        if(tx){
          const txsRaw = localStorage.getItem('CUP9_TRANSACTIONS') || '[]';
          const txs = JSON.parse(txsRaw);
          if(!txs.find(x=>String(x.id) === String(tx.id))){
            txs.push(tx);
            localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(txs));
          }
        }
      }catch(e){ console.warn('mirror createDeposit to localStorage failed', e); }
      return resp;
    }
    const resp = await mockApi.me({token});
    const userId = resp.user.id;
    db.transactions = db.transactions || {};
    const tid = 't' + gen(6);
    db.transactions[tid] = { id: tid, userId, type: 'deposit', amount: Number(amount)||0, created_at: db.now(), meta:{} };
    try{ saveMockDB(); }catch(e){}
    return { ok:true, transaction: db.transactions[tid] };
  },

  async requestWithdraw({token, amount}){
    if(API_BASE){
      const resp = await httpPost('/wallet/withdraw',{amount}, token);
      // mirror withdraw request into local transactions for UI/history
      try{
        const tx = resp && resp.transaction ? resp.transaction : null;
        if(tx){
          const txsRaw = localStorage.getItem('CUP9_TRANSACTIONS') || '[]';
          const txs = JSON.parse(txsRaw);
          if(!txs.find(x=>String(x.id) === String(tx.id))){
            txs.push(tx);
            localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(txs));
          }
        }
      }catch(e){ console.warn('mirror requestWithdraw to localStorage failed', e); }
      return resp;
    }
    const resp = await mockApi.me({token});
    const userId = resp.user.id;
    db.transactions = db.transactions || {};
    const tid = 't' + gen(6);
    db.transactions[tid] = { id: tid, userId, type: 'withdraw_request', amount: Number(amount)||0, created_at: db.now(), meta:{status:'pending'} };
    try{ saveMockDB(); }catch(e){}
    return { ok:true, transaction: db.transactions[tid] };
  },

  async referUser({token, code}){
    if(API_BASE) return httpPost('/referral/refer',{code}, token);
    const resp = await mockApi.me({token});
    const userId = resp.user.id;
    db.transactions = db.transactions || {};
    const tid = 't' + gen(6);
    db.transactions[tid] = { id: tid, userId, type: 'referral', amount: 5, created_at: db.now(), meta:{code} };
    try{ saveMockDB(); }catch(e){}
    return { ok:true, transaction: db.transactions[tid] };
  },

  async listNotifications({token}){
    if(API_BASE) return httpPost('/notifications/list',{}, token);
    const resp = await mockApi.me({token});
    const userId = resp.user.id;
    db.notifications = db.notifications || {};
    const notes = Object.values(db.notifications).filter(n=>String(n.userId||'')===String(userId||'')).sort((a,b)=>b.created_at.localeCompare(a.created_at));
    return { notifications: notes };
  },

  // Expose internals for debugging in WebSIM only
  __internal__: {
    isMock,
    db
  }
};

/* Helpers specific to GPU mock */
function sanitizeGpu(g){
  return {
    id: g.id,
    name: g.name,
    model: g.model,
    status: g.status,
    price_per_hour: g.price_per_hour,
    assigned_at: g.assigned_at,
    ownerId: g.ownerId || null,
    meta: g.meta || null
  };
}