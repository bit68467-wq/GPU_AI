/* Multi-page SPA with simple local user management (roles: admin/user).
   Added registration/login/logout, currentUser enforcement for admin actions,
   and a lightweight auth page rendered when no user is logged in. */

const STORAGE_KEYS = {
  BALANCE: 'cup9_balance', // kept for backwards compatibility (total), but new keys preferred
  DEPOSIT_BALANCE: 'cup9_deposit_balance',
  EARNINGS_BALANCE: 'cup9_earnings_balance',
  SERVERS: 'cup9_servers',
  REF: 'cup9_ref',
  DEPOSITS: 'cup9_deposits',
  WITHDRAWALS: 'cup9_withdrawals',
  USERS: 'cup9_users',
  SESSIONS: 'cup9_sessions', // persisted record of sessions for all accounts (no shared currentUser)
  CURRENT_USER: 'cup9_current_user' // retained for compatibility but currentUser remains in-memory
};

// Demo speed: 1 "day" = 10 seconds. In production set to 86400000 (24h).
const DAY_MS = 10000;

function $(id){return document.getElementById(id)}
function q(sel,root=document){return root.querySelector(sel)}
function fmt(n){return Number(n).toFixed(2)}

/* safeFetch: wraps fetch with a timeout so network/backend unavailability
   is detected quickly and the app can fallback to localStorage behaviors */
async function safeFetch(input, init = {}, timeout = 4000) {
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(input, Object.assign({}, init, { signal }));
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    // rethrow so callers can fallback to localStorage logic
    throw err;
  }
}

let state = {
  // depositBalance: funds added via deposits and withdrawals/returns, used for purchases and manual withdraws
  depositBalance: 0,
  // earnings: accumulated daily profits from servers (separate from depositBalance)
  earnings: 0,
  servers: [], // {id, amount, dailyRate, accumulated, createdAt}
  refCode: null,
  deposits: [], // pending deposits for admin verification
  users: [], // {id, username, password, role}
  currentUser: null
};

function load(){
  // load deposit & earnings balances (fall back to old BALANCE for compatibility)
  state.depositBalance = parseFloat(localStorage.getItem(STORAGE_KEYS.DEPOSIT_BALANCE) || '0');
  state.earnings = parseFloat(localStorage.getItem(STORAGE_KEYS.EARNINGS_BALANCE) || '0');
  // if old BALANCE exists and both new keys are zero, populate depositBalance for migration
  const legacy = parseFloat(localStorage.getItem(STORAGE_KEYS.BALANCE) || '0');
  if(legacy && !state.depositBalance && !state.earnings){
    state.depositBalance = legacy;
  }
  state.servers = JSON.parse(localStorage.getItem(STORAGE_KEYS.SERVERS) || '[]');
  state.refCode = localStorage.getItem(STORAGE_KEYS.REF) || null;
  state.deposits = JSON.parse(localStorage.getItem(STORAGE_KEYS.DEPOSITS) || '[]');
  state.withdrawals = JSON.parse(localStorage.getItem(STORAGE_KEYS.WITHDRAWALS) || '[]');
  state.users = JSON.parse(localStorage.getItem(STORAGE_KEYS.USERS) || '[]');
  // Load persisted sessions for all accounts so the app keeps a shared sessions registry across visits,
  // sessions allow restoring logins across browser sessions and devices when backend token is available.
  state.sessions = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSIONS) || '[]');

  // Attempt to restore a last active currentUser from persistent storage so users remain signed-in across reloads.
  try{
    const persistedCurrent = JSON.parse(localStorage.getItem(STORAGE_KEYS.CURRENT_USER) || 'null');
    if(persistedCurrent && persistedCurrent.username){
      // Basic validation: ensure user still exists locally; backend will revalidate token on first API call.
      const localUser = state.users.find(u => u.username === persistedCurrent.username);
      state.currentUser = {
        id: persistedCurrent.id || (localUser && localUser.id) || ('u' + Date.now()),
        username: persistedCurrent.username,
        role: persistedCurrent.role || (localUser && localUser.role) || 'user',
        token: persistedCurrent.token || null,
        lastLogin: persistedCurrent.lastLogin || Date.now()
      };
      // also ensure session registry contains this session
      state.sessions = state.sessions || [];
      const idx = state.sessions.findIndex(s => (s.username||'').toLowerCase() === (state.currentUser.username||'').toLowerCase());
      const sessionRecord = {
        id: state.currentUser.id,
        username: state.currentUser.username,
        role: state.currentUser.role,
        token: state.currentUser.token || null,
        lastLogin: state.currentUser.lastLogin || Date.now()
      };
      if(idx >= 0) state.sessions[idx] = Object.assign({}, state.sessions[idx], sessionRecord);
      else state.sessions.push(sessionRecord);
    } else {
      state.currentUser = null;
    }
  }catch(e){
    state.currentUser = null;
  }

  // ensure at least the default admin accounts exist (bootstrap)
  const defaultAdmins = [
    { id:'u-admin', username:'admin.cup.9@yahoo.com', password:'admincup9', role:'admin', refCode: 'ADMIN1' },
    { id:'u-admin2', username:'admin@gmail.com', password:'9090', role:'admin', refCode: 'ADMIN2' }
  ];
  // add any missing default admins without duplicating existing users
  defaultAdmins.forEach(def => {
    if(!state.users.find(u => u.username === def.username)){
      state.users.unshift(def);
    }
  });

  // Ensure every user has a unique id, referral code, and initialized balances
  state.users = state.users.map((u, idx) => {
    const user = Object.assign({}, u);
    if(!user.id) user.id = 'u' + Date.now() + String(Math.floor(Math.random()*9000)+1000) + idx;
    if(!user.refCode) {
      user.refCode = ('R' + Math.random().toString(36).substring(2,8)).toUpperCase();
    }
    // Ensure per-user balances exist and are numeric
    user.depositBalance = Number(user.depositBalance || 0);
    user.earnings = Number(user.earnings || 0);
    return user;
  });

  // If any user has explicit balances, derive the global aggregates from per-user data
  try{
    const sumDeposit = state.users.reduce((s,u) => s + (Number(u.depositBalance) || 0), 0);
    const sumEarnings = state.users.reduce((s,u) => s + (Number(u.earnings) || 0), 0);
    // Only override global totals if any per-user values are present (avoid clobbering legacy global when empty)
    if(sumDeposit > 0 || state.depositBalance > 0) state.depositBalance = sumDeposit > 0 ? +sumDeposit.toFixed(6) : state.depositBalance;
    if(sumEarnings > 0 || state.earnings > 0) state.earnings = sumEarnings > 0 ? +sumEarnings.toFixed(6) : state.earnings;
  }catch(e){ /* ignore aggregation errors */ }

  // Ensure servers have a lastAccrued timestamp so we can credit once-per-day reliably
  state.servers = (state.servers || []).map(s=>{
    const copy = Object.assign({}, s);
    if(!copy.createdAt) copy.createdAt = Date.now();
    // lastAccrued: timestamp (ms) when the last daily credit was applied; default to createdAt
    if(!copy.lastAccrued) copy.lastAccrued = copy.createdAt;
    return copy;
  });

  // persist any canonicalized user list (ids/refCodes/balances may have been added)
  localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(state.users));
}
function save(){
  // Ensure per-user numeric balances exist and compute aggregates
  try{
    state.users = state.users.map(u => {
      u.depositBalance = Number(u.depositBalance || 0);
      u.earnings = Number(u.earnings || 0);
      return u;
    });
    const sumDeposit = state.users.reduce((s,u) => s + (Number(u.depositBalance) || 0), 0);
    const sumEarnings = state.users.reduce((s,u) => s + (Number(u.earnings) || 0), 0);
    // Keep aggregate values consistent with per-user data when present
    if(sumDeposit > 0) state.depositBalance = +sumDeposit.toFixed(6);
    if(sumEarnings > 0) state.earnings = +sumEarnings.toFixed(6);
  }catch(e){ /* ignore */ }

  // persist new split balances (global aggregates for compatibility)
  localStorage.setItem(STORAGE_KEYS.DEPOSIT_BALANCE, state.depositBalance);
  localStorage.setItem(STORAGE_KEYS.EARNINGS_BALANCE, state.earnings);
  // keep legacy key for backward compatibility (sum)
  localStorage.setItem(STORAGE_KEYS.BALANCE, (Number(state.depositBalance || 0) + Number(state.earnings || 0)));
  localStorage.setItem(STORAGE_KEYS.SERVERS, JSON.stringify(state.servers));
  if(state.refCode) localStorage.setItem(STORAGE_KEYS.REF, state.refCode);
  localStorage.setItem(STORAGE_KEYS.DEPOSITS, JSON.stringify(state.deposits));
  localStorage.setItem(STORAGE_KEYS.WITHDRAWALS, JSON.stringify(state.withdrawals || []));
  // persist users (now including depositBalance and earnings)
  localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(state.users));
  // persist sessions registry (keeps sessions info for all accounts in this browser)
  localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(state.sessions || []));

  // Persist the currentUser (if present) so the session can be restored across reloads/browsers.
  // We intentionally persist only safe session metadata (id, username, role, token if provided) so the app can rehydrate.
  try{
    if(state.currentUser){
      const safeUser = {
        id: state.currentUser.id,
        username: state.currentUser.username,
        role: state.currentUser.role,
        token: state.currentUser.token || null,
        lastLogin: state.currentUser.lastLogin || Date.now()
      };
      localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(safeUser));
    } else {
      localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
    }
  }catch(e){
    console.debug('Error persisting currentUser', e);
  }

  // Mark a last-update timestamp so other tabs can detect changes and sync in near real-time
  try{
    localStorage.setItem('cup9_last_update', String(Date.now()));
  }catch(e){ /* ignore */ }

  // Fire-and-forget sync to backend Render service to keep users/current user globally synced.
  // Service ID: srv-d6sc2nnafjfc73et5l20
  (async function syncToBackend(){
    try{
      // Minimal payload: users list and currentUser for server-side persistence.
      const payload = {
        users: state.users,
        currentUser: state.currentUser,
        meta: { syncedAt: Date.now(), source: 'client-local' }
      };
      // Use the provided render app base URL
      const url = 'https://gpu-ai-jtlb.onrender.com/api/sync'; // server should expose an endpoint to accept sync
      // include service id as a header for server identification
      const headers = {
        'Content-Type': 'application/json',
        'x-service-id': 'srv-d6sc2nnafjfc73et5l20'
      };
      // If we have a backend token for the current session, include it as Bearer token
      if(state.currentUser && state.currentUser.token){
        headers['Authorization'] = `Bearer ${state.currentUser.token}`;
      }
      await safeFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      // intentionally ignore response; this is a best-effort sync
    }catch(err){
      // if sync fails, keep local state intact; no user disruption
      console.debug('Backend sync failed:', err);
    }
  })();
}

// Helper: get referral code for a given username or current user
function getRefForUser(username){
  if(!username) return null;
  const user = state.users.find(u=>u.username === username);
  if(user && user.refCode) return user.refCode;
  return null;
}
function getCurrentUserRef(){
  if(!state.currentUser) return null;
  return getRefForUser(state.currentUser.username) || state.currentUser.refCode || null;
}
// Build a sharable referral link (origin + ?ref=CODE)
function buildRefLink(code){
  if(!code) return '';
  try{
    const base = location.origin.replace(/\/$/, '');
    return `${base}/?ref=${encodeURIComponent(code)}`;
  }catch(e){
    return `/?ref=${encodeURIComponent(code)}`;
  }
}

/* Export / Import helpers to share users across browsers:
   - exportUsers(): copies users JSON to clipboard
   - importUsers(): prompts for JSON to merge into local users
*/
async function exportUsers(){
  try{
    const payload = JSON.stringify(state.users, null, 2);
    if(navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(payload);
      showToast('Utenti copiati negli appunti');
    } else {
      // fallback: open prompt with content to copy manually
      window.prompt('Copia gli utenti (CTRL+C):', payload);
    }
  }catch(e){
    showToast('Errore durante l\'esportazione');
  }
}



/* Record invite actions (copy/share) so Team page can show sent invites.
   Stores simple invite entries in localStorage key 'cup9_invites'. */
function recordInvite({ code, by, method, to }){
  try{
    const list = JSON.parse(localStorage.getItem('cup9_invites') || '[]');
    const entry = { id: 'i'+Date.now(), code: code || '', by: by || (state.currentUser && state.currentUser.username) || 'guest', method: method || 'copy', to: to || null, at: Date.now(), link: buildRefLink(code) };
    list.unshift(entry);
    localStorage.setItem('cup9_invites', JSON.stringify(list.slice(0,200))); // cap to recent 200

    // Persist last invite info to localStorage so a visitor registering on the same browser/session
    // without an explicit code or URL param becomes a Level A subordinate of the inviter.
    if(code && by){
      try{
        localStorage.setItem('cup9_last_invite', JSON.stringify({ code: code.toString().toUpperCase(), by: by, at: Date.now() }));
      }catch(e){}
    }
  }catch(e){
    console.debug('recordInvite error', e);
  }
}

/* Auth helpers */
async function registerUser(username, password, role='user'){
  username = (username||'').trim();
  password = (password||'').trim();
  if(!username || !password) return {ok:false, msg:'Username e password richiesti'};

  // Ensure username is not already present locally
  if(state.users.find(u=>u.username === username)) return {ok:false, msg:'Username già esistente'};

  // Detect referral code: prefer an explicit invite input on the auth form,
  // fall back to URL ?ref=CODE, and finally fall back to a recently copied/shared invite
  // saved in localStorage by recordInvite(). This ensures a logged-in user who shared
  // an invite causes the registering visitor to become a Level A subordinate.
  let referredBy = null;
  try{
    const manual = (document.getElementById('inviteCode') && document.getElementById('inviteCode').value) ? document.getElementById('inviteCode').value.trim() : '';
    if(manual) {
      referredBy = manual.toUpperCase();
    } else {
      const params = new URLSearchParams(location.search);
      const refQ = (params.get('ref') || '').trim();
      if(refQ) referredBy = refQ.toUpperCase();
      else {
        // fallback: check for last invite recorded locally (copy/share)
        try{
          const last = localStorage.getItem('cup9_last_invite');
          if(last){
            const parsed = JSON.parse(last);
            if(parsed && parsed.code) referredBy = (parsed.code || '').toString().toUpperCase();
          }
        }catch(e){}
      }
    }
  }catch(e){ /* ignore */ }

  // Require an invite code for registration
  if(!referredBy) {
    return { ok:false, msg: 'Codice invito richiesto per la registrazione' };
  }

  // Create local user first and persist to localStorage (guarantees local/global availability)
  const id = 'u' + Date.now() + String(Math.floor(Math.random()*9000)+1000);
  const refCode = ('R' + Math.random().toString(36).substring(2,8)).toUpperCase();

  // Normalize referredBy: if a code or username was provided, try to resolve to the inviter user
  // and store both the inviter's refCode (in referredBy) and inviter's username (as manager) so the
  // three-level lookup can consistently follow refCode/username links.
  let normalizedReferredBy = null;
  let managerUsername = null;
  if(referredBy){
    const refKey = referredBy.toString().toUpperCase();
    const inviter = state.users.find(u => ((u.refCode || '').toString().toUpperCase() === refKey) || ((u.username || '').toString().toUpperCase() === refKey));
    if(inviter){
      normalizedReferredBy = (inviter.refCode || inviter.username || '').toString().toUpperCase();
      managerUsername = inviter.username;
    } else {
      // if we couldn't resolve, keep the provided code (uppercased) so it can still match if inviter appears later
      normalizedReferredBy = refKey;
    }
  }

  const localUser = { id, username, password, role, refCode, referredBy: normalizedReferredBy || null, manager: managerUsername || null, createdAt: Date.now() };
  state.users.push(localUser);

  // record that this user was invited (if referredBy present) for Team listings
  if(normalizedReferredBy){
    // resolve the inviter username if not already known
    const refKey = normalizedReferredBy.toString().toUpperCase();
    const inviter = state.users.find(u => (u.refCode || '').toString().toUpperCase() === refKey || (u.username || '').toString().toUpperCase() === refKey);
    const inviterName = inviter ? inviter.username : (managerUsername || 'unknown');
    // record invite with the correct inviter as "by" so Team page shows correct hierarchy
    recordInvite({ code: normalizedReferredBy, by: inviterName, method: 'accepted', to: localUser.username });
  }
  save(); // save() will persist locally and start a best-effort background sync to backend
  showToast('Registrazione salvata localmente. Tentativo di sincronizzazione in corso...');

  // Then attempt to register on backend to keep server copy in sync and reconcile ids
  try{
    const resp = await safeFetch('/api/register', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password, role, referredBy: localUser.referredBy })
    });
    if(resp.ok){
      const data = await resp.json().catch(()=>null);
      if(data && data.username){
        // update local user record with any canonical server id/role returned (avoid losing password locally)
        const idx = state.users.findIndex(u=>u.username===username);
        if(idx>=0){
          state.users[idx] = Object.assign(state.users[idx], {
            id: data.id || state.users[idx].id,
            role: data.role || state.users[idx].role
          });
          save();
        }
        showToast('Registrazione sincronizzata con server. Effettua il login.');
        return { ok:true, user: data };
      } else {
        showToast('Registrazione locale creata; server ha risposto inaspettatamente.');
        return { ok:true, user: localUser };
      }
    } else {
      const err = await resp.json().catch(()=>({message:'Errore server'}));
      showToast('Registrazione locale creata; sync server fallita.');
      return { ok:true, user: localUser, msg: err.message || 'Registrazione fallita su server' };
    }
  }catch(e){
    // If backend unreachable, we keep the local registration and inform user that sync will be retried by save()
    showToast('Registrazione locale creata; impossibile raggiungere il server ora.');
    return { ok:true, user: localUser };
  }
}

async function loginUser(username, password){
  username = (username||'').trim();
  password = (password||'').trim();
  if(!username || !password) return {ok:false, msg:'Username e password richiesti'};

  // Try backend login
  try{
    const resp = await safeFetch('/api/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password })
    });
    if(resp.ok){
      const data = await resp.json();
      // expected: { id, username, role, token? }
      // store token when provided by backend to synchronize session across devices
      state.currentUser = {
        id: data.id || ('u' + Date.now()),
        username: data.username || username,
        role: data.role || 'user',
        token: data.token || data.accessToken || null
      };

      // Upsert a session record for this account so multiple accounts can be tracked/persisted
      state.sessions = state.sessions || [];
      const existingIdx = state.sessions.findIndex(s => (s.username||'').toString().toLowerCase() === (state.currentUser.username||'').toString().toLowerCase());
      const sessionRecord = {
        id: state.currentUser.id,
        username: state.currentUser.username,
        role: state.currentUser.role,
        token: state.currentUser.token || null,
        lastLogin: Date.now()
      };
      if(existingIdx >= 0) state.sessions[existingIdx] = Object.assign({}, state.sessions[existingIdx], sessionRecord);
      else state.sessions.push(sessionRecord);

      save();
      showToast(`Login effettuato come ${state.currentUser.username} (${state.currentUser.role})`);
      if(state.currentUser.role === 'admin'){
        renderCurrentPage();
        setTimeout(()=> openAdmin(), 120);
      } else {
        renderCurrentPage();
      }
      return {ok:true};
    } else {
      // Try a local fallback if server denies login (useful when backend unavailable or for local-only users)
      const u = state.users.find(x=>x.username===username && x.password===password);
      if(u){
        state.currentUser = { id:u.id, username:u.username, role:u.role, token: null };
        save();
        showToast(`Login locale effettuato come ${u.username} (${u.role})`);
        if(state.currentUser.role === 'admin'){
          renderCurrentPage();
          setTimeout(()=> openAdmin(), 120);
        } else {
          renderCurrentPage();
        }
        return {ok:true};
      }
      const err = await resp.json().catch(()=>({message:'Credenziali non valide'}));
      return {ok:false, msg: err.message || 'Credenziali non valide'};
    }
  }catch(e){
    // Fallback to local login if backend unreachable
    const u = state.users.find(x=>x.username===username && x.password===password);
    if(!u) return {ok:false, msg:'Credenziali non valide (fallback)'};
    state.currentUser = { id:u.id, username:u.username, role:u.role, token: null };

    // store local session record as well
    state.sessions = state.sessions || [];
    const existingLocal = state.sessions.findIndex(s => (s.username||'').toString().toLowerCase() === (u.username||'').toString().toLowerCase());
    const localSession = { id: u.id, username: u.username, role: u.role, token: null, lastLogin: Date.now() };
    if(existingLocal >= 0) state.sessions[existingLocal] = Object.assign({}, state.sessions[existingLocal], localSession);
    else state.sessions.push(localSession);

    save();
    showToast(`Login locale effettuato come ${u.username} (${u.role})`);
    if(state.currentUser.role === 'admin'){
      renderCurrentPage();
      setTimeout(()=> openAdmin(), 120);
    } else {
      renderCurrentPage();
    }
    return {ok:true};
  }
}
function logoutUser(){
  state.currentUser = null;
  save();
  showToast('Logout eseguito');
  renderCurrentPage();
}
function requireAdmin(){
  if(!state.currentUser) { showToast('Devi essere loggato come admin'); return false; }
  if(state.currentUser.role !== 'admin'){ showToast('Accesso negato: non sei admin'); return false; }
  return true;
}

/* Toast & Modal (kept simple) */
function showToast(text){
  const t = document.createElement('div');
  t.textContent = text;
  Object.assign(t.style,{
    position:'fixed',left:'50%',transform:'translateX(-50%)',bottom:'20px',background:'#021014',color:'#bfeadf',padding:'8px 12px',borderRadius:'8px',zIndex:9999,opacity:0
  });
  document.body.appendChild(t);
  requestAnimationFrame(()=>t.style.opacity=1);
  setTimeout(()=>{t.style.opacity=0; setTimeout(()=>t.remove(),300)},2000);
}

function openModal(title, bodyHTML, actions=[]){
  const modal = $('modal');
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHTML;
  const actionsEl = $('modalActions');
  actionsEl.innerHTML = '';
  actions.forEach(a=>{
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.onclick = ()=>{ a.onClick(); closeModal(); };
    if(a.class) btn.className = a.class;
    actionsEl.appendChild(btn);
  });
  modal.classList.remove('hidden');
}
function closeModal(){
  const modal = $('modal');
  if(!modal) return;
  modal.classList.add('hidden');
  // remove special fullscreen class if present
  modal.classList.remove('company-modal');
  const inner = modal.querySelector('.modal-inner');
  if(inner) inner.classList.remove('company-inner');
}

/* Business logic (unchanged behaviour) */
function createServer(amount){
  const id = 's'+Date.now();
  const dailyRate = Number((amount * 0.01).toFixed(6));
  const now = Date.now();
  // record owner when current user exists so purchases can be attributed
  const owner = state.currentUser ? state.currentUser.username : 'guest';
  // add lastAccrued so server is credited once-per-day relative to creation
  const server = { id, amount, dailyRate, accumulated:0, createdAt: now, lastAccrued: now, owner };
  state.servers.push(server);
  save();
  startServerProfitCycle(server);
}

/* Apply any missed daily accruals (for servers that were offline or created earlier).
   This computes how many whole "days" have passed since lastAccrued and applies them immediately,
   then updates lastAccrued so future intervals only add one "day" at a time. */
function applyMissedAccruals(server){
  const now = Date.now();
  const last = server.lastAccrued || server.createdAt || now;
  const elapsed = now - last;
  // compute whole day ticks passed
  const ticks = Math.floor(elapsed / DAY_MS);
  if(ticks > 0){
    const total = +(server.dailyRate * ticks).toFixed(6);
    server.accumulated += total;

    // Prefer per-user earnings: credit to the server owner if present, otherwise fall back to global earnings
    const ownerName = server.owner || 'guest';
    const owner = state.users.find(u => u.username === ownerName);
    if(owner){
      owner.earnings = +( (owner.earnings || 0) + total ).toFixed(6);
    } else {
      state.earnings += total;
    }

    // also update global aggregate for backward compatibility
    if(!owner) state.earnings = +(state.earnings).toFixed(6);
    else {
      // recompute global earnings as sum of per-user earnings + any global leftover deposits/earnings
      try{
        const perUserSum = state.users.reduce((s,u)=> s + (u.earnings || 0), 0);
        state.earnings = +perUserSum.toFixed(6);
      }catch(e){}
    }

    // advance lastAccrued by ticks * DAY_MS
    server.lastAccrued = last + ticks * DAY_MS;
    save();
  }
}

/* Start a repeating cycle that credits the server once every DAY_MS.
   We use lastAccrued to ensure exactly one credit per day even across reloads. */
function startServerProfitCycle(server){
  // Apply any missed accruals immediately on start
  applyMissedAccruals(server);

  // Clear any existing timer to avoid duplicates
  if(server._timer) { clearInterval(server._timer); delete server._timer; }

  // Schedule interval that credits once per DAY_MS and updates lastAccrued
  server._timer = setInterval(()=>{
    // Credit once
    server.accumulated += server.dailyRate;

    // Credit to owner user when possible
    const ownerName = server.owner || 'guest';
    const owner = state.users.find(u => u.username === ownerName);
    if(owner){
      owner.earnings = +( (owner.earnings || 0) + server.dailyRate ).toFixed(6);
      // update global aggregate as sum of per-user earnings
      try{
        const perUserSum = state.users.reduce((s,u)=> s + (u.earnings || 0), 0);
        state.earnings = +perUserSum.toFixed(6);
      }catch(e){
        state.earnings = +(state.earnings + server.dailyRate).toFixed(6);
      }
    } else {
      // fallback: credit global earnings
      state.earnings += server.dailyRate;
    }

    // record when we credited
    server.lastAccrued = Date.now();
    save();
    // refresh view if currently showing relevant pages
    if(location.hash==='#profile' || location.hash==='#home' || location.hash==='' ) renderCurrentPage();
  }, DAY_MS);
}

function startAllServerTimers(){
  state.servers.forEach(s=>{
    if(!s._timer) startServerProfitCycle(s);
  });
}

function stopAllTimers(){
  state.servers.forEach(s=>{
    if(s._timer) { clearInterval(s._timer); delete s._timer; }
  });
}

function createDeposit(amount, network='USDT'){
  const dep = { id: 'd'+Date.now(), amount, network, createdAt: Date.now(), verified: false, by: state.currentUser ? state.currentUser.username : 'guest' };
  state.deposits.push(dep);
  save();
  showToast('Deposito creato in attesa di verifica admin');
}

function adminVerifyDeposit(id, approve){
  if(!requireAdmin()) return;
  const idx = state.deposits.findIndex(d=>d.id===id);
  if(idx<0) return;
  const dep = state.deposits[idx];

  // Find the user who made this deposit (if any)
  const targetUsername = dep.by || 'guest';
  const targetUser = state.users.find(u => u.username === targetUsername);

  if(approve){
    // Credit the deposit amount to the requesting user's depositBalance property
    if(targetUser){
      targetUser.depositBalance = +( (targetUser.depositBalance || 0) + dep.amount ).toFixed(6);
    } else {
      // if user not found, fall back to global depositBalance (compatibility)
      state.depositBalance += dep.amount;
    }
    dep.verified = true;
    dep.notified = true; // flag for the user's notification
  } else {
    // remove deposit if rejected (no global side-effects)
    state.deposits.splice(idx,1);
  }

  save();
  renderCurrentPage();
}

/* Server actions */
function withdrawServerCapital(id){
  const s = state.servers.find(x=>x.id===id);
  if(!s) return;
  // return server principal to depositBalance
  state.depositBalance += s.amount;
  if(s._timer) clearInterval(s._timer);
  state.servers = state.servers.filter(x=>x.id!==s.id);
  save();
  showToast('Capitale ritirato e server rimosso');
  renderCurrentPage();
}

/* Routing & Page rendering */

const pages = {
  auth: renderAuth,
  home: renderHome,
  catalog: renderCatalog,
  devices: renderDevices,
  team: renderTeam,
  profile: renderProfile,
  account: renderAccountHistory,    // Account Info -> detailed history page
  orders: renderDevices,            // My Orders -> devices list (reuse)
  membership: renderCatalog,        // Purchase Membership -> catalog
  market: renderCatalog,            // My Market -> catalog
  rewards: renderRewards,           // My Rewards
  password: renderPasswordSettings, // Password Settings
  notifications: renderNotifications, // Message Notifications
  help: renderHelp,                 // Help Center
  about: renderAbout,               // About Us
  admin: openAdmin            // Fullscreen admin page (two buttons)
};

function navTo(route){
  location.hash = route;
}

function initRouting(){
  // primary nav buttons (bottom navigation)
  document.querySelectorAll('.bottom-nav .nav-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>navTo(btn.dataset.route));
  });

  // dropdown menu wiring
  const menuToggle = document.getElementById('menuToggle');
  const menuList = document.getElementById('menuList');
  if(menuToggle && menuList){
    menuToggle.addEventListener('click', (e)=>{
      menuList.classList.toggle('hidden');
      menuList.setAttribute('aria-hidden', menuList.classList.contains('hidden') ? 'true' : 'false');
    });
    // route buttons: navigate and close menu
    // Map dropdown semantic routes to actual SPA page routes
    const DROPDOWN_ROUTE_MAP = {
      // route the "Account Info" dropdown entry to the dedicated account history page
      'account': 'account',
      'orders': 'devices',
      'membership': 'catalog',
      'market': 'catalog',
      'rewards': 'rewards',
      'password': 'password',
      'notifications': 'notifications',
      'help': 'help',
      'home': 'home',
      'about': 'about'
    };
    menuList.querySelectorAll('[data-route]').forEach(mi=>{
      mi.addEventListener('click', (ev)=>{
        const r = ev.currentTarget.dataset.route;
        const target = DROPDOWN_ROUTE_MAP[r] || r || 'home';
        menuList.classList.add('hidden');
        navTo(target);
      });
    });

    // action buttons inside dropdown: perform custom actions then close menu
    menuList.querySelectorAll('[data-action]').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{
        const action = ev.currentTarget.dataset.action;
        menuList.classList.add('hidden');
        // handle known actions
        if(action === 'lang-switch'){
          // simple toggle between Italian and English labels (demo)
          const current = document.documentElement.lang || 'it';
          const next = current === 'it' ? 'en' : 'it';
          document.documentElement.lang = next;
          showToast(next === 'it' ? 'Lingua impostata: Italiano' : 'Language set: English');
          // you can extend this to actually translate strings
        } else if(action === 'download-app'){
          openDownloadModal();
        } else {
          // fallback: show action name
          showToast(`Azione: ${action}`);
        }
      });
    });

    const menuDeposit = document.getElementById('menuDeposit');
    if(menuDeposit) menuDeposit.addEventListener('click', ()=>{ menuList.classList.add('hidden'); openDepositModal(); });
    const menuAdmin = document.getElementById('menuAdmin');
    if(menuAdmin) menuAdmin.addEventListener('click', ()=>{ menuList.classList.add('hidden'); navTo('admin'); });
    const menuLogout = document.getElementById('menuLogout');
    if(menuLogout) menuLogout.addEventListener('click', ()=>{ menuList.classList.add('hidden'); logoutUser(); });

    document.addEventListener('click', (ev)=>{
      if(!menuList.classList.contains('hidden') && !ev.target.closest('.dropdown-wrap')) {
        menuList.classList.add('hidden');
      }
    });
  }

  // small helper modal for app download action
  function openDownloadModal(){
    openModal('Scarica l\'app', `
      <div class="muted">Scarica l'app per il tuo dispositivo</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <a href="#" id="dl-android">Android (APK)</a>
        <a href="#" id="dl-ios">iOS (App Store)</a>
        <a href="#" id="dl-web">Versione Web</a>
      </div>
    `, [{label:'Chiudi', class:'small-btn', onClick:()=>{}}]);

    // wire links (these are placeholders; replace with real URLs)
    const aAndroid = document.getElementById('dl-android');
    const aIos = document.getElementById('dl-ios');
    const aWeb = document.getElementById('dl-web');
    if(aAndroid) aAndroid.addEventListener('click', (e)=>{ e.preventDefault(); showToast('Download APK non disponibile in demo'); closeModal(); });
    if(aIos) aIos.addEventListener('click', (e)=>{ e.preventDefault(); showToast('Link App Store non disponibile in demo'); closeModal(); });
    if(aWeb) aWeb.addEventListener('click', (e)=>{ e.preventDefault(); showToast('Apri versione Web'); closeModal(); navTo('home'); });
  }

  window.addEventListener('hashchange', renderCurrentPage);
  // if not logged, show auth; if logged and no hash, default to home
  if(!state.currentUser) location.hash = '#auth';
  else if(!location.hash) location.hash = '#home';
  renderCurrentPage();
  // if an admin is already logged in when the app initializes, open the admin panel immediately
  if(state.currentUser && state.currentUser.role === 'admin'){
    setTimeout(()=> openAdmin(), 120);
  }
}

function renderCurrentPage(){
  const hash = location.hash.replace('#','') || (state.currentUser ? 'home' : 'auth');
  const renderer = pages[hash] || renderHome;
  renderer();
  highlightActiveNav(hash);
  updateTopbarUser();
}

/* Helpers to build small UI blocks */
function card(html){ return `<section class="card">${html}</section>`; }
function smallInput(attrs='') { return `<input ${attrs} style="width:100%;margin-top:8px;padding:10px;border-radius:8px;background:var(--glass);border:1px solid rgba(255,255,255,0.04);color:var(--text)" />`; }

/* Auth page */
function renderAuth(){
  const el = $('app');

  // Prefill invite code from URL ?ref=CODE if present
  let preRef = '';
  try{
    const params = new URLSearchParams(location.search);
    preRef = (params.get('ref') || '').trim();
  }catch(e){ preRef = ''; }

  el.innerHTML = `
    ${card(`<div class="label">Accesso / Registrazione</div>
      <div class="muted">Usa un account esistente o crea un nuovo account user. Il codice invito è obbligatorio per registrarsi; gli account admin demo sono pre-creati.</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <input id="authUser" placeholder="Username (email o username)" />
        <input id="authPass" type="password" placeholder="Password" />
        <input id="inviteCode" placeholder="Codice invito (obbligatorio)" value="${preRef}" required />
        <div style="display:flex;gap:8px">
          <button id="loginBtn">Accedi</button>
          <button id="registerBtn" class="small-btn">Registrati</button>
        </div>
      </div>
    `)}
  `;
  if($('loginBtn')) $('loginBtn').addEventListener('click', async ()=>{
    const u = $('authUser').value.trim(), p = $('authPass').value.trim();
    const res = await loginUser(u,p);
    if(!res.ok) showToast(res.msg);
  });

  if($('registerBtn')) $('registerBtn').addEventListener('click', async ()=>{
    const u = $('authUser').value.trim(), p = $('authPass').value.trim();
    const res = await registerUser(u,p);
    if(!res.ok) { showToast(res.msg); return; }
    // auto-login new user (attempt backend login first)
    const loginRes = await loginUser(u,p);
    if(!loginRes.ok) showToast(loginRes.msg);
  });

  if($('logoutBtn')) $('logoutBtn').addEventListener('click', ()=>{ logoutUser(); });

  // copy referral button (Team page) wiring (global listener because elements are dynamic)
  document.addEventListener('click', (e)=>{
    if(e.target && e.target.id === 'copyTeamRef'){
      const code = getCurrentUserRef();
      const link = buildRefLink(code);
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(link).then(()=> showToast('Link referral copiato'));
      } else {
        window.prompt('Copia il link referral', link);
      }
    }
  });

  
}

/* Page: Home */
function renderHome(){
  if(!state.currentUser){ renderAuth(); return; }
  const el = $('app');

  // Hero image: use local provided AI chip illustration asset for Home
  const heroImgHtml = `<img class="hero-img" src="isometric-artificial-intelligence-chip-animation-artificial-intelligence-server-futuristic-microchip-processor-isometric-clo.jpg" alt="AI Chip Network">`;

  // Prefer per-user balances when available to ensure admin actions affect only targeted users
  const curUserObj = state.users.find(u => state.currentUser && u.username === state.currentUser.username);
  const userDeposit = curUserObj ? (curUserObj.depositBalance || 0) : state.depositBalance;
  const userEarnings = curUserObj ? (curUserObj.earnings || 0) : state.earnings;
  const totalUser = +(userDeposit + userEarnings).toFixed(6);

  // Show hero + split balances and three circular actions (deposit, withdraw, check-in) and a company logo button
  el.innerHTML = `
    ${card(`${heroImgHtml}<div class="label">Saldo</div>
      <div style="display:flex;gap:8px">
        <div style="flex:1">
          <div class="muted">Saldo deposito</div>
          <div class="big">${fmt(userDeposit)}</div>
        </div>
        <div style="flex:1">
          <div class="muted">Saldo guadagni</div>
          <div class="big">${fmt(userEarnings)}</div>
        </div>
      </div>
      <div class="muted" style="margin-top:8px">Totale: ${fmt(totalUser)} USDT</div>

      <!-- Circular action buttons -->
      <div class="action-circles" style="margin-top:12px">
        <button id="homeDeposit" class="circle-btn" aria-label="Deposita">
          <div class="circle-icon">↓</div>
          <div class="circle-label">Deposita</div>
        </button>
        <button id="homeWithdraw" class="circle-btn" aria-label="Prelievo">
          <div class="circle-icon">↑</div>
          <div class="circle-label">Prelievo</div>
        </button>
        <button id="homeCheckin" class="circle-btn" aria-label="Check-in">
          <div class="circle-icon">✓</div>
          <div class="circle-label">Check-in</div>
        </button>
      </div>

      <!-- CUP9GPU logo image beneath the circles which opens a full-screen company info page -->
      <div style="margin-top:12px;display:flex;flex-direction:column;align-items:center;gap:8px">
        <!-- Keep only the tappable image logo (no text) -->
        <div style="width:100%;display:flex;justify-content:center">
          <img id="homeLogoImg" class="logo-image" src="isometric-artificial-intelligence-chip-animation-artificial-intelligence-server-futuristic-microchip-processor-isometric-clo.jpg" alt="CUP9GPU Logo" />
        </div>
      </div>
    `)}
  `;

  // Wire circle buttons to existing modals/actions
  const depBtn = $('homeDeposit');
  const withBtn = $('homeWithdraw');
  const checkBtn = $('homeCheckin');
  const logoBtn = $('homeLogo');
  if(depBtn) depBtn.addEventListener('click', ()=> openDepositModal());
  if(withBtn) withBtn.addEventListener('click', ()=> openWithdrawModal());
  if(checkBtn) checkBtn.addEventListener('click', ()=>{
    // per-user check-in: give a small earning and prevent spam by storing lastCheckin on the user object
    const now = Date.now();
    const DAY_MS_LOCAL = 1000 * 60 * 60 * 24;
    const curUser = state.currentUser ? state.users.find(u => u.username === state.currentUser.username) : null;
    const bonus = 0.10; // small check-in bonus

    if(curUser){
      const last = Number(curUser.lastCheckin || 0);
      if(now - last < DAY_MS_LOCAL){
        showToast('Hai già fatto il check-in oggi');
        return;
      }
      // credit to the specific user's earnings
      curUser.earnings = +( (curUser.earnings || 0) + bonus ).toFixed(6);
      curUser.lastCheckin = now;
      // update global aggregate as sum of per-user earnings
      try{
        const perUserSum = state.users.reduce((s,u)=> s + (Number(u.earnings) || 0), 0);
        state.earnings = +perUserSum.toFixed(6);
      }catch(e){
        state.earnings = +(state.earnings + bonus).toFixed(6);
      }
      save();
      showToast(`Check-in completato: +${fmt(bonus)} USDT`);
      renderCurrentPage();
    } else {
      // guest fallback: use a temporary session-based check to avoid abuse in anonymous state
      const last = Number(sessionStorage.getItem('lastCheckin') || 0);
      if(now - last < DAY_MS_LOCAL){
        showToast('Hai già fatto il check-in oggi');
        return;
      }
      state.earnings = +(state.earnings + bonus).toFixed(6);
      sessionStorage.setItem('lastCheckin', String(now));
      save();
      showToast(`Check-in completato: +${fmt(bonus)} USDT`);
      renderCurrentPage();
    }
  });

  // wire the tappable image logo to open the fullscreen company info modal
  const logoImg = $('homeLogoImg');
  if(logoImg) logoImg.addEventListener('click', ()=> openCompanyModal());

  // buy controls removed from Home; buy actions remain available in Catalog page
}

/* Page: Catalog (sample device packages) */
function renderCatalog(){
  if(!state.currentUser){ renderAuth(); return; }
  const el = $('app');
  const catalog = [
    {id:'pkg-small', title:'GPU Small', price:50, daily: +(50*0.01).toFixed(2)},
    {id:'pkg-medium', title:'GPU Medium', price:200, daily: +(200*0.01).toFixed(2)},
    {id:'pkg-large', title:'GPU Large', price:1000, daily: +(1000*0.01).toFixed(2)}
  ];
  let itemsHtml = '';
  catalog.forEach(p=>{
    itemsHtml += `<div class="server catalog-item">
      <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
        <div>
          <div style="font-size:16px;font-weight:700">${p.title}</div>
          <div class="muted" style="margin-top:4px">Rendimento giornaliero ~ ${fmt(p.daily)} USDT</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:700;font-size:15px">${fmt(p.price)} USDT</div>
          <div style="margin-top:8px"><button data-buy="${p.price}" class="buy-package">Acquista</button></div>
        </div>
      </div>
    </div>`;
  });

  // Render catalog as a full page section (not inside a card)
  el.innerHTML = `
    <div class="catalog-full">
      <div class="catalog-header">
        <div class="label">Catalogo dispositivi</div>
        <div class="muted">Scegli un pacchetto e acquistalo usando il saldo</div>
      </div>
      <div class="catalog-list">${itemsHtml}</div>
    </div>
  `;

  el.querySelectorAll('.buy-package').forEach(b=>{
    b.addEventListener('click', ()=>{
      const price = parseFloat(b.dataset.buy);
      // prefer per-user deposit balance
      const curUserObj = state.currentUser ? state.users.find(u => u.username === state.currentUser.username) : null;
      const userDeposit = curUserObj ? (curUserObj.depositBalance || 0) : state.depositBalance;
      if(price > userDeposit){ showToast('Saldo deposito insufficiente. Deposita prima.'); return; }
      // deduct from user's depositBalance when available, otherwise from global
      if(curUserObj){
        curUserObj.depositBalance = +( (curUserObj.depositBalance || 0) - price ).toFixed(6);
        if(curUserObj.depositBalance < 0) curUserObj.depositBalance = 0;
      } else {
        state.depositBalance = +(state.depositBalance - price).toFixed(6);
        if(state.depositBalance < 0) state.depositBalance = 0;
      }
      createServer(price);
      save();
      showToast('Pacchetto acquistato e server attivato');
      renderCurrentPage();
    });
  });
}

/* Page: Devices (detailed list + detail open) — now shown as a full-screen modal */
function renderDevices(){
  if(!state.currentUser){ renderAuth(); return; }

  // Use the same modal pattern as the company modal to present servers full-screen on mobile
  const modal = $('modal');
  if(!modal) return;

  modal.classList.add('company-modal');
  const inner = modal.querySelector('.modal-inner');
  if(inner) inner.classList.add('company-inner');

  $('modalTitle').textContent = 'I miei server — Fullscreen';
  $('modalBody').innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;gap:12px;padding-right:8px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="label">I miei server</div>
          <div class="muted">Gestisci i server attivi e ritira capitale</div>
        </div>
        <div style="text-align:right">
          <div class="muted">Server attivi</div>
          <div style="font-weight:700;font-size:18px">${(state.servers||[]).length}</div>
        </div>
      </div>

      <div style="flex:1;overflow:auto;padding-right:6px">
        <div id="devicesListFull" class="list" style="padding-bottom:18px">
          ${renderServersListHTML(true)}
        </div>
      </div>

      <div class="muted" style="font-size:13px">Tocca "Dettagli" per visualizzare il server o "Ritira capitale" per chiuderlo.</div>
    </div>
  `;

  // actions area: close button placed in modal actions
  const actionsEl = $('modalActions');
  actionsEl.innerHTML = '';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Chiudi';
  closeBtn.className = 'small-btn';
  closeBtn.onclick = ()=> closeModal();
  actionsEl.appendChild(closeBtn);

  modal.classList.remove('hidden');

  // wire buttons inside the modal
  const wrap = document.getElementById('devicesListFull');
  if(wrap){
    // delegate clicks for details and withdraw buttons
    wrap.querySelectorAll('[data-detail]').forEach(btn=>{
      btn.addEventListener('click', ()=> openServerDetailModal(btn.dataset.detail));
    });
    wrap.querySelectorAll('[data-withdraw]').forEach(btn=>{
      btn.addEventListener('click', ()=> {
        withdrawServerCapital(btn.dataset.withdraw);
        // refresh the modal content to reflect removal
        closeModal();
        renderDevices();
        renderCurrentPage();
      });
    });
  }
}

/* Page: Profile */
function renderProfile(){
  if(!state.currentUser){ renderAuth(); return; }
  const el = $('app');

  // Prefer per-user balances where present
  const curUserObj = state.users.find(u => state.currentUser && u.username === state.currentUser.username);
  const userDeposit = curUserObj ? (curUserObj.depositBalance || 0) : state.depositBalance;
  const userEarnings = curUserObj ? (curUserObj.earnings || 0) : state.earnings;

  // Profile now only shows personal info and settings (no balance-actions)
  el.innerHTML = `
    ${card(`<div class="label">Informazioni personali</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div><strong>Username:</strong> ${state.currentUser.username}</div>
        <div class="muted"><strong>Role:</strong> ${state.currentUser.role}</div>
        <div class="muted"><strong>ID:</strong> ${state.currentUser.id}</div>
      </div>
    `)}
    ${card(`<div class="label">Impostazioni</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;gap:8px"><button id="goPassword" class="small-btn">Cambia password</button> <button id="logoutSmall" class="small-btn">Logout</button></div>
      </div>
      <div class="muted" style="margin-top:8px">Queste impostazioni riguardano solo il tuo account personale.</div>
    `)}
    ${card(`<div class="label">Bilancio dettagliato</div>
      <div class="muted">Saldo deposito: ${fmt(userDeposit)} USDT • Guadagni: ${fmt(userEarnings)} USDT</div>
    `)}
  `;

  // Wiring: referral, collab toggle, password settings navigation, logout
  const applyRefBtn = $('applyRef');
  if(applyRefBtn) applyRefBtn.addEventListener('click', ()=>{
    const code = $('refCode').value.trim();
    if(!code){ showToast('Inserisci codice referral'); return; }
    // apply referral code to current user's refCode (stored on user object)
    const u = state.users.find(x=> x.username === state.currentUser.username);
    if(u){
      u.refCode = code.toUpperCase();
      // also save to state.currentUser for immediate UI usage
      state.currentUser.refCode = u.refCode;
      save(); showToast('Referral applicato');
      renderCurrentPage();
    } else {
      // fallback: set global (rare)
      state.refCode = code.toUpperCase(); save(); showToast('Referral applicato'); renderCurrentPage();
    }
  });

  

  const goPass = $('goPassword');
  if(goPass) goPass.addEventListener('click', ()=> { navTo('password'); });

  const logoutSmall = $('logoutSmall');
  if(logoutSmall) logoutSmall.addEventListener('click', ()=> { logoutUser(); });
}

/* Team page: referrals, invites, and team operations */
function renderTeam(){
  if(!state.currentUser){ renderAuth(); return; }
  const el = $('app');
  const ref = getRefForUser(state.currentUser.username) || state.currentUser.refCode || '';
  // build three-level team view: levelA (direct), levelB (referrals of direct), levelC (next level)
  // Compute three-level referrals for the logged-in user so every logged user
  // always sees their own level A/B/C members.
  const team = getThreeLevelFor(state.currentUser.username);

  const inviteLink = ref ? buildRefLink(ref) : '';

  // Merge levels preferring A over B over C and ensure uniqueness (user appears in highest applicable level only)
  const mergedList = [];
  const seen = new Set();
  function pushUniqueList(list, levelLabel){
    (list || []).forEach(u=>{
      const key = (u.username || u.id || '').toString();
      if(!key) return;
      if(seen.has(key)) return;
      seen.add(key);
      mergedList.push(Object.assign({}, u, { level: levelLabel }));
    });
  }
  pushUniqueList(team.levelA, 'A');
  pushUniqueList(team.levelB, 'B');
  pushUniqueList(team.levelC, 'C');

  el.innerHTML = `
    ${card(`<div class="label">My Team</div><div class="muted">Gestisci e visualizza i referral su 3 livelli (A, B, C)</div>`)}
    ${card(`<div style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="muted">Codice Referral</div>
          <div style="font-weight:700;font-size:18px">${ref || '<span class=\"muted\">Non impostato</span>'}</div>
        </div>
        <div style="text-align:right">
          <div class="muted">Totale team (A+B+C)</div>
          <div style="font-weight:700;font-size:18px">${mergedList.length}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="teamRef" placeholder="Codice referral" value="${ref}" style="flex:1" />
        <button id="saveRefBtn">Salva</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between">
        <div class="muted" style="font-size:13px">Link invito: ${inviteLink ? `<a id="teamRefLink" href="${inviteLink}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);word-break:break-all">${inviteLink}</a>` : 'Nessun codice'}</div>
        ${inviteLink ? `<div style="display:flex;gap:8px"><button id="copyTeamRef" class="small-btn">Copia link</button><button id="shareTeamRef" class="small-btn">Condividi</button></div>` : '<div></div>'}
      </div>
      <div style="display:flex;gap:8px;justify-content:space-between;margin-top:8px">
        <div id="levelA" style="text-align:center;cursor:pointer"><div class="muted">Livello A</div><div style="font-weight:700;font-size:18px">${team.levelA.length}</div></div>
        <div id="levelB" style="text-align:center;cursor:pointer"><div class="muted">Livello B</div><div style="font-weight:700;font-size:18px">${team.levelB.length}</div></div>
        <div id="levelC" style="text-align:center;cursor:pointer"><div class="muted">Livello C</div><div style="font-weight:700;font-size:18px">${team.levelC.length}</div></div>
      </div>
    </div>`)}
    ${card(`<div class="label">Referral dettagliati</div>
      <div class="muted">La colonna 'Livello' mostra A (diretti), B (secondo livello), C (terzo livello).</div>
      <div id="referralsTableWrap" style="padding-top:6px" data-full='${encodeURIComponent(JSON.stringify(mergedList))}'>${renderReferralsTableHTML(mergedList)}</div>
    `)}
  `;

  // Save referral code handler
  $('saveRefBtn').addEventListener('click', ()=>{
    const code = $('teamRef').value.trim();
    if(!code){ showToast('Inserisci codice referral'); return; }
    const u = state.users.find(x=> x.username === state.currentUser.username);
    if(u){
      u.refCode = code.toUpperCase();
      state.currentUser.refCode = u.refCode;
    } else {
      state.refCode = code.toUpperCase();
    }
    save();
    showToast('Referral salvato');
    renderCurrentPage();
  });

  // Clickable level filters: open a full-screen modal showing the detailed referrals table for the chosen level
  function showLevel(level){
    const wrap = document.getElementById('referralsTableWrap');
    if(!wrap) return;
    const full = wrap.dataset.full ? JSON.parse(decodeURIComponent(wrap.dataset.full)) : mergedList;
    // determine items to show
    const items = (!level || level === 'ALL') ? full : (full || []).filter(u => (u.level || '').toString().toUpperCase() === level.toString().toUpperCase());

    // Build modal body with header + table and instructions
    const levelLabel = level ? `Livello ${level}` : 'Tutti i livelli';
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;height:100%;gap:12px;padding-right:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="label">Referral dettagliati</div>
            <div class="muted">La colonna 'Livello' mostra A (diretti), B (secondo livello), C (terzo livello).</div>
            <div style="margin-top:6px;font-weight:700">${levelLabel}</div>
          </div>
          <div style="text-align:right">
            <div class="muted">Totale mostrati</div>
            <div style="font-weight:700;font-size:18px">${items.length}</div>
          </div>
        </div>

        <div style="flex:1;overflow:auto;padding-right:6px">
          <div id="referralsFullTableWrap">${renderReferralsTableHTML(items)}</div>
        </div>

        <div class="muted" style="font-size:13px">Tocca le intestazioni per ordinare. Premi Ctrl/Cmd+clic su una riga per copiare lo username.</div>
      </div>
    `;

    // Open modal in company (full-screen) style to maximize space on mobile
    openModal(`Referral dettagliati — ${levelLabel}`, bodyHtml, [{label:'Chiudi', class:'small-btn', onClick:()=>{}}]);
    const modal = $('modal');
    if(modal) modal.classList.add('company-modal');
    const inner = modal.querySelector('.modal-inner');
    if(inner) inner.classList.add('company-inner');

    // Add event delegation inside modal for sorting and ctrl/cmd copy
    const tableWrap = document.getElementById('referralsFullTableWrap');
    if(!tableWrap) return;

    // Sorting: delegate clicks on th[data-sort]
    tableWrap.addEventListener('click', function onTableClick(e){
      const th = e.target.closest('th[data-sort]');
      if(th){
        const key = th.dataset.sort;
        // gather current rows into objects
        const rows = Array.from(tableWrap.querySelectorAll('tbody tr')).map(tr=>{
          return {
            username: tr.children[0].textContent,
            id: tr.children[1].textContent,
            role: tr.children[2].textContent,
            refCode: tr.children[3].textContent,
            referredBy: tr.children[4].textContent,
            level: tr.children[5].textContent,
            createdAt: tr.children[6].textContent
          };
        });
        const currentDir = tableWrap.dataset.sortKey === key ? tableWrap.dataset.sortDir || 'asc' : 'asc';
        const nextDir = currentDir === 'asc' ? 'desc' : 'asc';
        tableWrap.dataset.sortKey = key;
        tableWrap.dataset.sortDir = nextDir;
        const sorted = sortReferrals(rows, key, nextDir);
        tableWrap.innerHTML = renderReferralsTableHTML(sorted);
        return;
      }

      // Copy username on Ctrl/Cmd + click on a table row
      const tr = e.target.closest('tr');
      if(tr && (e.ctrlKey || e.metaKey)){
        const username = tr.children[0]?.textContent || '';
        if(username){
          if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(username).then(()=> showToast('Username copiato'));
          } else {
            window.prompt('Copia username', username);
          }
        }
      }
    }, { once: false });
  }

  const lvlA = document.getElementById('levelA');
  const lvlB = document.getElementById('levelB');
  const lvlC = document.getElementById('levelC');
  if(lvlA) lvlA.addEventListener('click', ()=> showLevel('A'));
  if(lvlB) lvlB.addEventListener('click', ()=> showLevel('B'));
  if(lvlC) lvlC.addEventListener('click', ()=> showLevel('C'));

  // Copy/share handlers & copy from table
  document.getElementById('referralsTableWrap').addEventListener('click', (e)=>{
    const td = e.target.closest('td');
    if(td && td.parentElement && td.parentElement.tagName === 'TR'){
      if(e.ctrlKey || e.metaKey){
        const username = td.parentElement.children[0]?.textContent || '';
        if(username){
          if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(username).then(()=> showToast('Username copiato'));
          } else {
            window.prompt('Copia username', username);
          }
        }
      }
    }
  });

  const copyBtn = $('copyTeamRef');
  if(copyBtn){
    copyBtn.addEventListener('click', ()=>{
      if(!inviteLink) return showToast('Nessun link referral da copiare');
      const by = state.currentUser && state.currentUser.username;
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(inviteLink).then(()=> {
          showToast('Link referral copiato');
          recordInvite({ code: ref, by, method: 'copy', to: null });
        });
      } else {
        window.prompt('Copia il link referral', inviteLink);
        recordInvite({ code: ref, by, method: 'copy', to: null });
      }
    });
  }
  const shareBtn = $('shareTeamRef');
  if(shareBtn){
    shareBtn.addEventListener('click', ()=>{
      if(!inviteLink) return showToast('Nessun link referral da condividere');
      const by = state.currentUser && state.currentUser.username;
      if(navigator.share){
        navigator.share({ title: 'Join me on CUP9GPU', text: 'Iscriviti con il mio referral', url: inviteLink }).then(()=> {
          showToast('Link condiviso');
          recordInvite({ code: ref, by, method: 'share', to: null });
        }).catch(()=> showToast('Condivisione non disponibile'));
      } else {
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(inviteLink).then(()=> {
            showToast('Link copiato negli appunti');
            recordInvite({ code: ref, by, method: 'copy', to: null });
          });
        } else {
          window.prompt('Copia il link referral', inviteLink);
          recordInvite({ code: ref, by, method: 'copy', to: null });
        }
      }
    });
  }

  // wire sorting via event delegation (headers have data-sort attr)
  document.getElementById('referralsTableWrap').addEventListener('click', (e)=>{
    const th = e.target.closest('th[data-sort]');
    if(th){
      const key = th.dataset.sort;
      const wrap = document.getElementById('referralsTableWrap');
      const rows = Array.from(document.querySelectorAll('#referralsTableWrap tbody tr')).map(tr=>{
        return {
          username: tr.children[0].textContent,
          id: tr.children[1].textContent,
          role: tr.children[2].textContent,
          refCode: tr.children[3].textContent,
          referredBy: tr.children[4].textContent,
          level: tr.children[5].textContent,
          createdAt: tr.children[6].textContent
        };
      });
      const current = wrap.dataset.sortKey === key ? wrap.dataset.sortDir || 'asc' : 'asc';
      const nextDir = current === 'asc' ? 'desc' : 'asc';
      wrap.dataset.sortKey = key;
      wrap.dataset.sortDir = nextDir;
      const sorted = sortReferrals(rows, key, nextDir);
      wrap.innerHTML = renderReferralsTableHTML(sorted);
    }
  });
}

/* Helper: return three-level referral lists for a username.
   This is a more defensive implementation that always returns unique users
   for level A (direct), B (second level) and C (third level). It accepts either
   a referral code or username stored in users[].referredBy and handles missing
   ref codes by falling back to username keys.
*/
function getThreeLevelFor(username){
  const res = { levelA: [], levelB: [], levelC: [] };
  if(!username) return res;

  // Normalize map: referredBy (uppercased) -> array of users
  // Also include legacy/explicit manager links so inviters always see subordinated users
  const byRef = {};
  state.users.forEach(u=>{
    // primary referral key saved in the user record
    const rb = (u.referredBy || '').toString().toUpperCase();
    if(rb){
      byRef[rb] = byRef[rb] || [];
      byRef[rb].push(u);
    }
    // legacy/alternate linking via manager property should also be considered a referral link
    const mgr = (u.manager || '').toString().toUpperCase();
    if(mgr){
      byRef[mgr] = byRef[mgr] || [];
      // avoid duplicating the same user if both referredBy and manager match
      if(!byRef[mgr].find(x => x.username === u.username)){
        byRef[mgr].push(u);
      }
    }
  });

  // Compute the canonical keys that can be used to match referredBy values:
  // - user's referral code (if any)
  // - user's username
  const myUserObj = state.users.find(u => (u.username||'') === (username||'')) || {};
  const myRefCode = (myUserObj.refCode || getRefForUser(username) || '').toString().toUpperCase();
  const myUsernameKey = (username || '').toString().toUpperCase();

  function collect(keys){
    const out = [];
    keys.forEach(k=>{
      (byRef[k] || []).forEach(u=>{
        if(!out.find(x=>x.username === u.username)) out.push(Object.assign({}, u));
      });
    });
    return out;
  }

  // Level A keys = myRefCode and my username
  const levelAKeys = Array.from(new Set([myRefCode, myUsernameKey].filter(Boolean)));
  const lvlA = collect(levelAKeys);
  res.levelA = lvlA.map(u=>Object.assign({}, u, { level: 'A' }));

  // Level B: collect by Level A users' refCodes/usernames
  const levelBKeys = Array.from(new Set(lvlA.flatMap(u=>[(u.refCode||'').toString().toUpperCase(), (u.username||'').toString().toUpperCase()].filter(Boolean))));
  const lvlB = collect(levelBKeys).filter(u => !lvlA.find(x=>x.username===u.username) && u.username.toUpperCase() !== myUsernameKey);
  res.levelB = lvlB.map(u=>Object.assign({}, u, { level: 'B' }));

  // Level C: collect by Level B users' refCodes/usernames
  const levelCKeys = Array.from(new Set(lvlB.flatMap(u=>[(u.refCode||'').toString().toUpperCase(), (u.username||'').toString().toUpperCase()].filter(Boolean))));
  const lvlC = collect(levelCKeys).filter(u => !lvlA.find(x=>x.username===u.username) && !lvlB.find(x=>x.username===u.username) && u.username.toUpperCase() !== myUsernameKey);
  res.levelC = lvlC.map(u=>Object.assign({}, u, { level: 'C' }));

  return res;
}

// Backwards-compatible wrapper kept for other callers
function buildThreeLevelTeam(username){
  return getThreeLevelFor(username);
}

/* Return list of referrals for current user (by refCode or manager) */
function getReferralsForCurrentUser(){
  // DEPRECATED for three-level view; kept for compatibility but returns direct referrals (level A)
  const cur = state.currentUser;
  if(!cur) return [];
  const myRef = getCurrentUserRef();
  return state.users.filter(u=>{
    if(u.username === cur.username) return false;
    if(u.referredBy && myRef && u.referredBy.toUpperCase() === myRef.toUpperCase()) return true;
    return false;
  }).map(u=>({
    username: u.username,
    id: u.id,
    role: u.role,
    refCode: u.refCode || '',
    referredBy: u.referredBy || '',
    manager: u.manager || '',
    createdAt: u.createdAt || 0,
    level: 'A'
  }));
}

/* Render referrals table HTML (improved, compact and accessible) */
function renderReferralsTableHTML(list){
  if(!list || list.length===0) return '<div class="muted">Nessun referral trovato</div>';

  // normalize rows to a consistent shape
  const normalized = list.map(r=>{
    return {
      username: r.username || '',
      id: r.id || '',
      role: r.role || '',
      refCode: r.refCode || '',
      referredBy: r.referredBy || '',
      level: r.level || (r.referredBy ? 'A' : '-'),
      createdAt: r.createdAt || 0
    };
  });

  // build rows with semantic markup and data attributes for easier JS handling
  const rows = normalized.map((r, idx)=>{
    const created = r.createdAt ? new Date(r.createdAt).toLocaleString() : '-';
    // use classes for styling instead of inline styles
    return `<tr class="ref-row ${idx % 2 === 0 ? 'even' : 'odd'}" data-username="${escapeHtml(r.username)}" data-id="${escapeHtml(r.id)}">
      <td class="ref-username">${escapeHtml(r.username)}</td>
      <td class="ref-id">${escapeHtml(r.id)}</td>
      <td class="ref-role">${escapeHtml(r.role)}</td>
      <td class="ref-code">${escapeHtml(r.refCode)}</td>
      <td class="ref-referred">${escapeHtml(r.referredBy)}</td>
      <td class="ref-level">${escapeHtml(r.level)}</td>
      <td class="ref-created">${escapeHtml(created)}</td>
    </tr>`;
  }).join('');

  // compact table with semantic headers; callers rely on data-sort attributes for sorting already wired in renderTeam
  return `<div class="table-wrap">
    <table class="ref-table" role="table" aria-label="Referral table">
      <thead>
        <tr>
          <th data-sort="username" scope="col" class="th-left">Username ▾</th>
          <th data-sort="id" scope="col">ID</th>
          <th data-sort="role" scope="col">Role</th>
          <th data-sort="refCode" scope="col">Ref Code</th>
          <th data-sort="referredBy" scope="col">Referred By</th>
          <th data-sort="level" scope="col">Livello</th>
          <th data-sort="createdAt" scope="col">Created</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

// small helper to safely escape text going into HTML
function escapeHtml(s){
  if(s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Sort helper for referrals */
function sortReferrals(list, key, dir='asc'){
  if(!Array.isArray(list)) return list;
  const sorted = list.slice().sort((a,b)=>{
    const va = a[key] || '';
    const vb = b[key] || '';
    if(typeof va === 'number' || typeof vb === 'number'){
      return (Number(va)||0) - (Number(vb)||0);
    }
    return String(va).localeCompare(String(vb));
  });
  if(dir === 'desc') sorted.reverse();
  return sorted;
}

function renderAccountHistory(){
  if(!state.currentUser){ renderAuth(); return; }
  const el = $('app');

  // Filter deposits/withdrawals/purchases relevant to the logged user
  const user = state.currentUser.username;
  const deposits = (state.deposits || []).filter(d=> (d.by && d.by === user) || (d.by===undefined && user==='guest') );
  const withdrawals = (state.withdrawals || []).filter(w=> (w.by && w.by === user) || (w.by===undefined && user==='guest') );
  // purchases inferred from servers where owner matches user (and also include removed servers by checking historical records if present)
  const purchases = (state.servers || []).filter(s=> s.owner && s.owner === user);

  function renderDepositsList(){
    if(deposits.length===0) return '<div class="muted">Nessun deposito trovato per il tuo account</div>';
    return deposits.map(d=>`<div style="padding:12px;border-radius:10px;background:rgba(255,255,255,0.02);margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center"><div><strong>${fmt(d.amount)} USDT</strong></div><div class="muted">${fmtDate(d.createdAt)}</div></div>
      <div class="muted" style="margin-top:6px">ID: ${d.id} • Stato: ${d.verified? 'Verificato' : 'In attesa'} • Da: ${d.by||'guest'} • Rete: ${d.network}</div>
    </div>`).join('');
  }
  function renderWithdrawalsList(){
    if(withdrawals.length===0) return '<div class="muted">Nessuna richiesta di prelievo trovata</div>';
    return withdrawals.map(w=>`<div style="padding:12px;border-radius:10px;background:rgba(255,255,255,0.02);margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center"><div><strong>${fmt(w.amount)} USDT</strong></div><div class="muted">${fmtDate(w.createdAt)}</div></div>
      <div class="muted" style="margin-top:6px">ID: ${w.id} • Stato: ${w.approved? 'Approvato' : 'In attesa'} • Indirizzo: ${w.addr||'--'} • Fee: ${fmt(w.fee)}</div>
    </div>`).join('');
  }
  function renderPurchasesList(){
    if(purchases.length===0) return '<div class="muted">Nessun acquisto/pacchetto trovato</div>';
    return purchases.map(p=>`<div style="padding:12px;border-radius:10px;background:rgba(255,255,255,0.02);margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center"><div><strong>${fmt(p.amount)} USDT</strong> • <span class="muted">Rend. g: ${fmt(p.dailyRate)} USDT</span></div><div class="muted">${fmtDate(p.createdAt)}</div></div>
      <div class="muted" style="margin-top:6px">ID server: ${p.id} • Accreditato: ${fmt(p.accumulated)} USDT</div>
      <div style="margin-top:8px"><button data-detail="${p.id}">Vedi dettagli</button></div>
    </div>`).join('');
  }

  // Full-page history layout: header + three scrollable columns stacked vertically to fit mobile viewport
  el.innerHTML = `
    <div class="catalog-full" style="padding-top:4px;padding-bottom:12px;gap:12px">
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="label">Storico Account — ${user}</div>
            <div class="muted">Visualizzi qui le cronologie dettagliate dei tuoi depositi, prelievi e acquisti.</div>
          </div>
          <div style="text-align:right">
            <div class="muted">Totale server attivi</div>
            <div style="font-weight:700;font-size:18px">${(state.servers||[]).filter(s=>s.owner===user).length}</div>
          </div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        <div class="label">Storico Depositi</div>
        <div style="padding-right:6px">${renderDepositsList()}</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        <div class="label">Storico Prelievi</div>
        <div style="padding-right:6px">${renderWithdrawalsList()}</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        <div class="label">Storico Acquisti / Server attivati</div>
        <div style="padding-right:6px">${renderPurchasesList()}</div>
      </div>
    </div>
  `;

  // wire detail buttons for purchases to reuse existing modal
  el.querySelectorAll('[data-detail]').forEach(btn=>{
    btn.addEventListener('click', ()=> openServerDetailModal(btn.dataset.detail));
  });
}

function renderRewards(){
  if(!state.currentUser){ renderAuth(); return; }
  const el = $('app');
  el.innerHTML = `
    ${card(`<div class="label">My Rewards</div><div class="muted">Visualizza i tuoi premi e bonus</div>`)}
    ${card(`<div class="label">Bonus attivi</div><div class="muted">${state.rewards && state.rewards.length ? '' : 'Nessun premio attivo'}</div>`)}
  `;
}

function renderPasswordSettings(){
  if(!state.currentUser){ renderAuth(); return; }
  const el = $('app');
  el.innerHTML = `
    ${card(`<div class="label">Impostazioni Password</div>
      <div class="muted">Cambia la password del tuo account</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <input id="oldPass" type="password" placeholder="Password attuale" />
        <input id="newPass" type="password" placeholder="Nuova password" />
        <div style="display:flex;gap:8px"><button id="changePassBtn">Modifica</button></div>
      </div>
    `)}
  `;
  if($('changePassBtn')) $('changePassBtn').addEventListener('click', ()=>{
    const oldP = $('oldPass').value.trim(), newP = $('newPass').value.trim();
    if(!oldP || !newP){ showToast('Compila entrambi i campi'); return; }
    const u = state.users.find(x=> x.username === state.currentUser.username);
    if(!u || u.password !== oldP){ showToast('Password attuale errata'); return; }
    u.password = newP;
    save();
    showToast('Password aggiornata');
    $('oldPass').value = $('newPass').value = '';
  });
}

function renderNotifications(){
  if(!state.currentUser){ renderAuth(); return; }
  const el = $('app');
  const curUser = state.currentUser.username;

  // Aggregate notifications only for the current user (deposits/withdrawals addressed to them)
  const depNotifs = (state.deposits || [])
    .filter(d => d.verified && d.notified && d.by === curUser)
    .map(d => ({ id: d.id, title: 'Deposito verificato', body: `${fmt(d.amount)} USDT verificati.`, ts: d.createdAt || Date.now() }));

  const withNotifs = (state.withdrawals || [])
    .filter(w => w.approved && w.notified && w.by === curUser)
    .map(w => ({ id: w.id, title: 'Prelievo processato', body: `${fmt(w.amount)} USDT processati.`, ts: w.processedAt || Date.now() }));

  const notes = [...depNotifs, ...withNotifs].sort((a,b)=> (b.ts||0) - (a.ts||0));
  const html = notes.length === 0 ? '<div class="muted">Nessuna notifica</div>' : notes.map(n=>`<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:8px"><div><strong>${n.title}</strong></div><div class="muted">${n.body}</div><div class="muted" style="margin-top:6px;font-size:11px">${new Date(n.ts).toLocaleString()}</div></div>`).join('');
  el.innerHTML = `
    ${card(`<div class="label">Message Notifications</div><div class="muted">Le notifiche dell'account</div>`)}
    ${card(html)}
  `;

  // Mark notifications as read for current user only
  (state.deposits || []).forEach(d => { if(d.verified && d.notified && d.by === curUser) d.notified = false; });
  (state.withdrawals || []).forEach(w => { if(w.approved && w.notified && w.by === curUser) w.notified = false; });
  save();
  // refresh topbar badge after clearing
  updateTopbarUser();
}

function renderHelp(){
  const el = $('app');
  el.innerHTML = `
    ${card(`<div class="label">Help Center</div><div class="muted">FAQ e Contatti</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        <div><strong>Come depositare?</strong><div class="muted">Usa la sezione Deposita nel tuo profilo per creare una richiesta.</div></div>
        <div><strong>Assistenza</strong><div class="muted">Contatta support@cup9gpu.example (simulato)</div></div>
      </div>
    `)}
  `;
}

function renderAbout(){
  const el = $('app');
  el.innerHTML = `
    ${card(`<div class="label">About Us</div><div class="muted">Informazioni su CUP9GPU</div>
      <div style="margin-top:8px">CUP9GPU demo app • Servizio di hosting GPU simulato per scopi dimostrativi.</div>
    `)}
  `;
}

function renderInvitesHTML(){
  const invites = JSON.parse(localStorage.getItem('cup9_invites') || '[]');
  if(invites.length===0) return '<div class="muted">Nessun invito inviato</div>';
  return invites.map(i=>`<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:8px">
    <div><strong>${i.to}</strong></div><div class="muted">Inviato: ${fmtDate(i.at)} • da: ${i.by||'--'}</div>
  </div>`).join('');
}

/* Small render helpers */
function fmtDate(ts){
  try{
    const d = new Date(ts);
    return d.toLocaleString();
  }catch(e){ return ''; }
}
function renderServersListHTML(withActions=false){
  if(state.servers.length===0) return '<div class="muted">Nessun server attivo</div>';
  return state.servers.map(s=>{
    const created = fmtDate(s.createdAt);
    const acc = fmt(s.accumulated);
    const amt = fmt(s.amount);
    const daily = fmt(s.dailyRate);
    const actions = withActions
      ? `<div class="server-actions"><button data-detail="${s.id}">Dettagli</button> <button data-withdraw="${s.id}" class="small-btn">Ritira capitale</button></div>`
      : `<div class="meta">Accreditato: ${acc}</div>`;
    return `<div class="server">
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><strong>${amt} USDT</strong></div>
          <div style="text-align:right"><div class="meta">Creato: ${created}</div></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div class="muted">Rendimento: ${daily} USDT/g</div>
          <div style="text-align:right">${actions}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderDepositsHTML(){
  if(state.deposits.length===0) return '<div class="muted">Nessun deposito in attesa</div>';
  return state.deposits.filter(d=>!d.verified).map(d=>{
    return `<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:8px">
      <div><strong>${fmt(d.amount)} USDT</strong> • ${d.network}</div>
      <div class="muted">ID: ${d.id} • da: ${d.by||'guest'}</div>
    </div>`;
  }).join('');
}

/* UI wiring for Home actions */
function wireHomeActions(){
  if($('buyBtn')){
    $('buyBtn').addEventListener('click', ()=>{
      const amt = parseFloat($('buyAmount').value||0);
      if(!amt || amt<=0){ showToast('Importo non valido'); return; }
      // prefer per-user deposit balance
      const curUserObj = state.currentUser ? state.users.find(u => u.username === state.currentUser.username) : null;
      const userDeposit = curUserObj ? (curUserObj.depositBalance || 0) : state.depositBalance;
      if(amt > userDeposit){ showToast('Saldo deposito insufficiente. Deposita prima.'); return; }
      // deduct safely
      if(curUserObj){
        curUserObj.depositBalance = +( (curUserObj.depositBalance || 0) - amt ).toFixed(6);
        if(curUserObj.depositBalance < 0) curUserObj.depositBalance = 0;
      } else {
        state.depositBalance = +(state.depositBalance - amt).toFixed(6);
        if(state.depositBalance < 0) state.depositBalance = 0;
      }
      createServer(amt);
      save();
      showToast('Server acquistato e attivato • accrediti giornalieri attivi');
      renderCurrentPage();
    });
  }
}

/* Modal helpers reused by pages */
function openDepositModal(){
  openModal('Deposita USDT', `
    <div>Inserisci importo USDT da depositare (nessun minimo)</div>
    <input id="modalDepositAmt" type="number" min="1" placeholder="Es. 50" />
    <div class="muted" style="margin-top:8px">I depositi vengono verificati dall'admin per maggiore sicurezza.</div>
  `, [
    {label:'Annulla', class:'small-btn', onClick:()=>{}},
    {label:'Invia deposito', onClick:()=>{
      const amt = parseFloat($('modalDepositAmt').value||0);
      if(!amt || amt<=0){ showToast('Importo non valido'); return; }
      createDeposit(amt);
      renderCurrentPage();
    }}
  ]);
}

function openWithdrawModal(){
  const min = 100;
  // show the current user's depositBalance if available (per-user balances are preferred)
  const curUserObj = state.currentUser ? state.users.find(u => u.username === state.currentUser.username) : null;
  const userDeposit = curUserObj ? (curUserObj.depositBalance || 0) : state.depositBalance;

  openModal('Prelievo', `
    <div>Saldo disponibile (deposito): ${fmt(userDeposit)} USDT</div>
    <div class="muted" style="margin-top:6px">Nota: i guadagni non vengono prelevati automaticamente qui; usa lo smart withdrawal se previsto.</div>
    <div style="margin-top:8px">Prelievo minimo: ${min}$ • Commissione: 3%</div>
    <input id="modalWithdrawAmt" type="number" min="${min}" placeholder="Importo da prelevare" />
    <input id="modalWithdrawAddr" placeholder="Indirizzo wallet (es. ERC20/USDT)" style="margin-top:8px" />
    <div class="muted" style="margin-top:8px">Le richieste verranno verificate dall'admin prima dell'addebito. L'importo richiesto verrà temporaneamente trattenuto dal tuo saldo deposito fino a verifica.</div>
  `, [
    {label:'Annulla', class:'small-btn', onClick:()=>{}},
    {label:'Richiedi Prelievo', onClick:()=>{
      const amt = parseFloat($('modalWithdrawAmt').value||0);
      const addr = $('modalWithdrawAddr').value || '';
      if(!amt || amt < min){ showToast(`Importo minimo ${min}$`); return; }

      // Compute available for the current user (exclude their own held amounts)
      const currentUsername = state.currentUser ? state.currentUser.username : 'guest';
      const heldTotalForUser = (state.withdrawals || []).filter(w=>w.by === currentUsername && w.held && !w.processedAt).reduce((s,w)=>s + (w.amount||0), 0);
      const userObj = state.users.find(u => u.username === currentUsername);
      const userAvailable = +( (userObj ? (userObj.depositBalance || 0) : state.depositBalance) - heldTotalForUser ).toFixed(6);

      if(amt > userAvailable){ showToast('Saldo deposito disponibile insufficiente per nuove richieste (tenute in sospeso)'); return; }

      const fee = +(amt * 0.03).toFixed(6);
      const net = +(amt - fee).toFixed(6);

      // create a withdrawal request and immediately hold the requested amount on the user's record to avoid duplicates
      state.withdrawals = state.withdrawals || [];
      const req = {
        id: 'w' + Date.now(),
        amount: amt,
        addr,
        fee,
        net,
        by: currentUsername,
        createdAt: Date.now(),
        approved: false,
        processedAt: null,
        // mark as held: amount reserved from user's depositBalance until admin decision
        held: true,
        heldSnapshot: { userDepositBalance: userObj ? (userObj.depositBalance || 0) : state.depositBalance }
      };

      // deduct held amount immediately from the user's depositBalance (preferred) or global fallback
      if(userObj){
        userObj.depositBalance = +( (userObj.depositBalance || 0) - amt ).toFixed(6);
      } else {
        state.depositBalance = +(state.depositBalance - amt).toFixed(6);
      }

      state.withdrawals.push(req);
      save();
      renderCurrentPage();
      showToast(`Richiesta di prelievo inviata e ${fmt(amt)} USDT trattenuti in sospeso. In attesa di approvazione admin.`);
    }}
  ]);
}

/* Server detail modal for devices page */
function openServerDetailModal(id){
  const s = state.servers.find(x=>x.id===id);
  if(!s) return;
  openModal('Dettagli server', `
    <div><strong>Investito: ${fmt(s.amount)} USDT</strong></div>
    <div class="muted">Rendimento giornaliero: ${fmt(s.dailyRate)} USDT</div>
    <div class="muted">Totale accreditato: ${fmt(s.accumulated)} USDT</div>
  `, [
    {label:'Chiudi', class:'small-btn', onClick:()=>{}},
    {label:'Ritira capitale (chiude server)', onClick:()=>{ withdrawServerCapital(s.id); renderCurrentPage(); }}
  ]);
}

/* Company full-screen modal (opens from Home logo) */
function openCompanyModal(){
  const modal = $('modal');
  if(!modal) return;
  // mark modal as company-style so styles can make it full-screen
  modal.classList.add('company-modal');
  const inner = modal.querySelector('.modal-inner');
  if(inner) inner.classList.add('company-inner');

  $('modalTitle').textContent = 'CUP9GPU — Informazioni Aziendali';
  $('modalBody').innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;gap:12px;padding-right:8px">
      <div style="display:flex;gap:12px;align-items:center">
        <div style="width:76px;height:76px;border-radius:12px;background:linear-gradient(180deg,#042018,#08302a);display:flex;align-items:center;justify-content:center;font-weight:900;color:var(--accent);font-size:20px">C9</div>
        <div>
          <div style="font-weight:700;font-size:18px">CUP9GPU</div>
          <div class="muted" style="margin-top:4px">Soluzioni di hosting GPU • Servizi di compute per AI e rendering</div>
        </div>
      </div>

      <div style="flex:1;overflow:auto;padding-right:6px">
        <h3 style="margin:8px 0 6px 0">Chi siamo</h3>
        <div class="muted">CUP9GPU fornisce hosting GPU virtuale per sviluppatori e team AI. Questa istanza demo mostra funzioni di gestione account, depositi, acquisti di pacchetti GPU e profitti giornalieri simulati.</div>

        <h3 style="margin:12px 0 6px 0">Cosa offriamo</h3>
        <ul class="muted" style="padding-left:18px">
          <li>Pacchetti GPU configurabili e attivazione server</li>
          <li>Monitoraggio dei profitti giornalieri e ritiro capitale</li>
          <li>Sistema referral per incentivare la crescita del network</li>
          <li>Pannello admin per verifica depositi e prelievi</li>
        </ul>

        <h3 style="margin:12px 0 6px 0">Contatti</h3>
        <div class="muted">Email demo: support@cup9gpu.example • Sito: cup9gpu.example (simulato)</div>

        <div style="margin-top:16px">
          <strong>Nota:</strong>
          <div class="muted" style="margin-top:6px">Questa pagina è una vista informativa a schermo intero. Usa il pulsante Chiudi qui sotto per tornare all'app.</div>
        </div>
      </div>
    </div>
  `;
  const actionsEl = $('modalActions');
  actionsEl.innerHTML = '';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Chiudi';
  closeBtn.className = 'small-btn';
  closeBtn.onclick = ()=> closeModal();
  actionsEl.appendChild(closeBtn);

  modal.classList.remove('hidden');
}

/* Admin panel (requires logged admin) */
function openAdmin(){
  if(!requireAdmin()) return;

  // Build two-pane admin modal: buttons to toggle "Lista Utenti" e "Lista Richieste"
  function buildUsersHtml(){
    let usersHtml = '';
    state.users.forEach(u=>{
      usersHtml += `<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:8px">
        <div><strong>${u.username}</strong> • <span class="muted">${u.role}</span></div>
        <div class="muted">ID: ${u.id} • Manager: ${u.manager||'--'}</div>
        <div style="margin-top:8px">
          <button data-uid="${u.id}" data-action="promote">${u.role==='admin' ? 'Demote' : 'Promote to Admin'}</button>
          <button data-uid="${u.id}" data-action="setadmin" class="small-btn">Assegna ad Admin</button>
        </div>
      </div>`;
    });
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div><strong>Utenti (${state.users.length})</strong></div>
      <div style="display:flex;gap:8px"><button id="adminExportBtn" class="small-btn">Esporta</button></div>
    </div>${usersHtml || '<div class="muted">Nessun utente</div>'}`;
  }

  function buildRequestsHtml(){
    const pendingDeposits = state.deposits.filter(d=>!d.verified);
    const pendingWithdrawals = (state.withdrawals || []).filter(w=>!w.approved);
    const depsHtml = pendingDeposits.length===0 ? '<div class="muted">Nessun deposito in attesa</div>' : pendingDeposits.map(d=>{
      return `<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:8px">
        <div><strong>${fmt(d.amount)} USDT</strong> • ${d.network}</div>
        <div class="muted">ID: ${d.id} • da: ${d.by||'guest'}</div>
        <div style="margin-top:8px"><button data-id="${d.id}" data-action="approve-dep">Approva</button> <button data-id="${d.id}" data-action="reject-dep" class="small-btn">Rifiuta</button></div>
      </div>`;
    }).join('');

    const withHtml = pendingWithdrawals.length===0 ? '<div class="muted">Nessuna richiesta di prelievo in attesa</div>' : pendingWithdrawals.map(w=>{
      return `<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:8px">
        <div><strong>${fmt(w.amount)} USDT</strong> • Net: ${fmt(w.net)} • Fee: ${fmt(w.fee)}</div>
        <div class="muted">ID: ${w.id} • da: ${w.by||'guest'} • Addr: ${w.addr||'--'}</div>
        <div style="margin-top:8px"><button data-id="${w.id}" data-action="approve-w">Approva</button> <button data-id="${w.id}" data-action="reject-w" class="small-btn">Rifiuta</button></div>
      </div>`;
    }).join('');

    return `<div style="margin-bottom:8px"><strong>Depositi in attesa: ${pendingDeposits.length}</strong> • <strong>Prelievi in attesa: ${pendingWithdrawals.length}</strong></div>
      <div style="margin-top:6px">${depsHtml}</div>
      <hr style="margin:10px 0;border:none;border-top:1px solid rgba(255,255,255,0.04)"/>
      <div style="margin-top:6px">${withHtml}</div>`;
  }

  // initial content shows users list
  const initialBody = `<div id="adminToggleRow" style="display:flex;gap:8px;margin-bottom:12px">
    <button id="showUsers" class="small-btn">Lista Utenti</button>
    <button id="showRequests" class="small-btn">Lista Richieste</button>
  </div>
  <div id="adminContent" style="max-height:60vh;overflow:auto">${buildUsersHtml()}</div>`;

  openModal('Pannello Admin', initialBody, [{label:'Chiudi', class:'small-btn', onClick:()=>{}}]);

  // toggle handlers
  const showUsersBtn = document.getElementById('showUsers');
  const showReqBtn = document.getElementById('showRequests');
  const contentEl = document.getElementById('adminContent');

  function refreshUsersView(){
    if(!contentEl) return;
    contentEl.innerHTML = buildUsersHtml();
  }
  function refreshRequestsView(){
    if(!contentEl) return;
    contentEl.innerHTML = buildRequestsHtml();
  }

  if(showUsersBtn) showUsersBtn.addEventListener('click', ()=>{ refreshUsersView(); });
  if(showReqBtn) showReqBtn.addEventListener('click', ()=>{ refreshRequestsView(); });

  // wire export/import buttons via event delegation
  document.getElementById('modalBody').addEventListener('click', (e)=>{
    const t = e.target;
    if(t && t.id === 'adminExportBtn'){ exportUsers(); }
    // wire data-action buttons for user management and requests and requests
    const action = t.dataset && t.dataset.action;
    const uid = t.dataset && t.dataset.uid;
    const did = t.dataset && t.dataset.id;
    if(action){
      const adminId = state.users.find(u=>u.role==='admin')?.id || (state.currentUser && state.currentUser.id);
      if(action==='promote' && uid){
        const user = state.users.find(x=>x.id===uid);
        if(!user) return;
        if(user.role === 'admin'){
          user.role = 'user';
          showToast(`${user.username} demoted to user`);
        } else {
          user.role = 'admin';
          showToast(`${user.username} promoted to admin`);
        }
        user.manager = user.role === 'admin' ? (adminId || null) : (user.manager || adminId);
        save();
        refreshUsersView();
      } else if(action==='setadmin' && uid){
        const user = state.users.find(x=>x.id===uid);
        if(!user) return;
        user.manager = adminId || user.manager;
        save();
        showToast(`${user.username} ora subordinato all'admin`);
        refreshUsersView();
      } else if(did){
        if(action==='approve-dep') adminVerifyDeposit(did, true);
        else if(action==='reject-dep') adminVerifyDeposit(did, false);
        else if(action==='approve-w') adminVerifyWithdrawal(did, true);
        else if(action==='reject-w') adminVerifyWithdrawal(did, false);
        // after handling requests, refresh current view
        if(contentEl && contentEl.innerHTML.includes('Depositi in attesa')) refreshRequestsView();
        else refreshUsersView();
      }
    }
  });
}

/* End of original openAdmin modal-based implementation */

function openDepositVerification(){
  let body = '';
  const pending = state.deposits.filter(d=>!d.verified);
  if(pending.length===0) body = '<div class="muted">Nessun deposito in attesa</div>';
  else {
    pending.forEach(d=>{
      body += `<div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:8px">
        <div><strong>${fmt(d.amount)} USDT</strong> • ${d.network}</div>
        <div class="muted">ID: ${d.id} • da: ${d.by||'guest'}</div>
        <div style="margin-top:8px"><button data-id="${d.id}" data-action="approve">Approva</button> <button data-id="${d.id}" data-action="reject" class="small-btn">Rifiuta</button></div>
      </div>`;
    });
  }
  openModal('Verifica Depositi', body, [{label:'Chiudi', class:'small-btn', onClick:()=>{}}]);
  document.querySelectorAll('[data-action]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const id = e.currentTarget.dataset.id;
      const action = e.currentTarget.dataset.action;
      if(action==='approve') adminVerifyDeposit(id, true);
      else adminVerifyDeposit(id, false);
      closeModal();
      openDepositVerification();
    });
  });
}

/* Admin: verify/handle withdrawals */
function adminVerifyWithdrawal(id, approve){
  if(!requireAdmin()) return;
  state.withdrawals = state.withdrawals || [];
  const idx = state.withdrawals.findIndex(w=>w.id===id);
  if(idx<0) return;
  const req = state.withdrawals[idx];

  // Find the user who requested this withdrawal
  const targetUsername = req.by || 'guest';
  const targetUser = state.users.find(u => u.username === targetUsername);

  if(approve){
    // If amount was held on the user's record at request time, finalize without double-deducting.
    if(req.held){
      req.approved = true;
      req.processedAt = Date.now();
      req.held = false;
      req.notified = true;
      showToast(`Prelievo ${fmt(req.amount)} approvato e processato (fondi trattenuti per ${targetUsername}).`);
    } else {
      // legacy path: if not held, attempt to deduct from the user's depositBalance (preferred) or global fallback
      const userBalance = (targetUser && (targetUser.depositBalance || 0)) || state.depositBalance || 0;
      if(userBalance >= req.amount){
        if(targetUser){
          targetUser.depositBalance = +( (targetUser.depositBalance || 0) - req.amount ).toFixed(6);
        } else {
          state.depositBalance = +(state.depositBalance - req.amount).toFixed(6);
        }
        req.approved = true;
        req.processedAt = Date.now();
        req.notified = true;
        showToast(`Prelievo ${fmt(req.amount)} approvato e processato.`);
      } else {
        showToast('Saldo deposito dell\'utente insufficiente per processare il prelievo.');
        return;
      }
    }
  } else {
    // reject: if funds were held, release them back to the requesting user's depositBalance; otherwise just remove
    if(req.held){
      if(targetUser){
        targetUser.depositBalance = +( (targetUser.depositBalance || 0) + req.amount ).toFixed(6);
      } else {
        state.depositBalance = +(state.depositBalance + req.amount).toFixed(6);
      }
    }
    // remove the request from queue
    state.withdrawals.splice(idx,1);
    showToast('Richiesta di prelievo rifiutata e fondi rilasciati se trattenuti');
  }
  save();
  renderCurrentPage();
}

/* Utilities */
function highlightActiveNav(route){
  // only toggle active on bottom navigation buttons
  document.querySelectorAll('.bottom-nav .nav-btn').forEach(b=> b.classList.toggle('active', b.dataset.route===route));
}
function updateTopbarUser(){
  const brand = document.querySelector('.brand');
  if(!brand) return;
  // Keep topbar static: always display platform title. User info is available in the Profile page.
  brand.textContent = 'CUP9GPU';

  // Update bell badge based on deposits verified or withdrawals approved that still have 'notified' flag,
  // but only for the currently logged-in user.
  const badgeEl = document.getElementById('bellBadge');
  const bellBtn = document.getElementById('topBell');
  if(!badgeEl || !bellBtn) return;

  const curUser = state.currentUser ? state.currentUser.username : null;
  if(!curUser){
    badgeEl.classList.add('hidden');
    bellBtn.onclick = ()=> { navTo('auth'); };
    return;
  }

  const depNotifs = (state.deposits || []).filter(d => d.verified && d.notified && d.by === curUser).length;
  const withNotifs = (state.withdrawals || []).filter(w => w.approved && w.notified && w.by === curUser).length;
  const total = depNotifs + withNotifs;

  if(total > 0){
    badgeEl.textContent = String(total);
    badgeEl.classList.remove('hidden');
  } else {
    badgeEl.classList.add('hidden');
  }

  // clicking bell opens notifications page
  bellBtn.onclick = () => {
    // navigate to notifications page which will clear notifications after view
    navTo('notifications');
  };
}

/* Boot */
load();
startAllServerTimers();
initRouting();
window.addEventListener('beforeunload', ()=>save());