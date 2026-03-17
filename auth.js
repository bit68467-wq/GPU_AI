/*
 auth.js — handles per-device sessions and exposes high-level auth functions.
 Adds persistent localStorage-backed user registry (CUP9_USERS) and session (CURRENT_USER)
 while preserving per-device token storage for compatibility with mock api.
*/
import { api } from './api.js';
import { notify } from './notifications.js';

const DEVICES_KEY = 'cup9:devices';
const DEVICE_KEY = 'cup9:deviceId';
const USERS_KEY = 'CUP9_USERS';
const CURRENT_USER_KEY = 'CURRENT_USER';

function uid(n=8){ return Math.random().toString(36).slice(2,2+n); }

function getDeviceId(){
  let id = localStorage.getItem(DEVICE_KEY);
  if(!id){
    id = 'd_'+uid(10);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function readDevices(){
  try{ return JSON.parse(localStorage.getItem(DEVICES_KEY) || '{}'); }catch(e){ return {}; }
}
function writeDevices(obj){ localStorage.setItem(DEVICES_KEY, JSON.stringify(obj)); }

function saveTokenForDevice(deviceId, token){
  const all = readDevices();
  all[deviceId] = { token, updated_at: new Date().toISOString() };
  writeDevices(all);
}

function readTokenForDevice(deviceId){
  const all = readDevices();
  return (all[deviceId] && all[deviceId].token) || null;
}

/* Local users persistence helpers */
function readUsers(){
  try{ return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); }catch(e){ return []; }
}
function writeUsers(list){
  localStorage.setItem(USERS_KEY, JSON.stringify(list));
}
function findUserByEmail(email){
  if(!email) return null;
  const users = readUsers();
  return users.find(u=>u.email.toLowerCase() === email.toLowerCase()) || null;
}

/* Current session helper */
function readCurrentSession(){
  try{ return JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || 'null'); }catch(e){ return null; }
}
function writeCurrentSession(obj){
  if(!obj) localStorage.removeItem(CURRENT_USER_KEY);
  else localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(obj));
}

/* Public auth functions with local persistence */
async function register(email,password,inviteCode){
  if(!email || !password) throw { status:400, message:"email & password required" };

  // Disallow creating a regular account that reuses the device-tied telegram pattern.
  // Blocked email policy: explicitly deny registration attempts for this specific address
  try{
    if(String(email).trim().toLowerCase() === 'grazzanimarco.1964@libero.it'){
      throw { status:403, message: 'Registrazione non consentita per questo account' };
    }
  }catch(e){ if(e && e.status) throw e; }
  // This ensures registrations remain personal and aren't conflated with per-device Telegram identities.
  if(String(email).toLowerCase().startsWith('telegram:')){
    throw { status:400, message: "Registrazione non consentita con indirizzi telegram: riservati all'accesso Telegram per dispositivo" };
  }

  // If an invite code was provided, validate it exists and is usable.
  // Try backend first (when configured), then fall back to localStorage and the mock api DB for cross-browser usage.
  let __invite_list = null;
  let __invite_target = null;
  try{
    if(inviteCode){
      const codeTrim = String(inviteCode).trim();

      // Special-case: allow the specific invite code only for Ciccio@gmail.com (operator-provided exception).
      // This ensures that registrations from Ciccio@gmail.com using that exact code are accepted even if not present in the standard stores.
      try{
        if(String(email).trim().toLowerCase() === 'ciccio@gmail.com' && codeTrim === 'a_z_corporation@corporation.com|8Z9JCLDG'){
          __invite_target = { code: codeTrim, note: 'operator-exception-for-ciccio' };
        }
      }catch(e){ /* continue to normal validation if any error */ }

      // 1) If a real backend is configured, prefer server-side validation endpoint (idempotent/read-only)
      if(!__invite_target && typeof window !== 'undefined' && window.CUP9_API_BASE){
        try{
          const url = String(window.CUP9_API_BASE).replace(/\/+$/,'') + '/invites/validate';
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: codeTrim })
          }).catch(()=>null);
          if(resp && resp.ok){
            const body = await resp.json().catch(()=>null);
            // backend returns { valid: true, invite: {...} } on success
            if(body && body.valid){
              __invite_target = body.invite || { code: codeTrim };
            } else {
              throw { status:400, message: 'Codice invito non valido' };
            }
          } else {
            // If backend returned non-OK, fall back to local/mocked stores below
            __invite_target = null;
          }
        }catch(e){
          // network/backend issue: fall back to local/mocked stores rather than failing registration
          __invite_target = null;
        }
      }

      // 2) If backend didn't confirm, check localStorage invites
      if(!__invite_target){
        try{
          const invitesRaw = localStorage.getItem('CUP9_INVITES') || '[]';
          __invite_list = JSON.parse(invitesRaw || '[]') || [];
          __invite_target = (__invite_list || []).find(i => String(i.code || '').trim() === codeTrim) || null;
        }catch(e){
          __invite_list = null;
          __invite_target = null;
        }
      }

      // 3) If still not found and running in WebSIM/mock, check mock api internal DB
      if(!__invite_target){
        try{
          if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.invites){
            const mockInvites = Object.values(api.__internal__.db.invites || {});
            __invite_target = mockInvites.find(i => String(i.code || '').trim() === codeTrim) || null;
          }
        }catch(e){}
      }

      if(!__invite_target){
        throw { status:400, message: 'Codice invito non valido' };
      }

      // Note: we intentionally do not enforce single-use here to allow global distribution across browsers;
      // marking "used" occurs below after successful registration to preserve idempotency.
    }
  }catch(e){
    if(e && e.status) throw e;
  }

  const exists = findUserByEmail(email);
  if(exists) throw { status:409, message:"User already exists" };

  // create user object and persist (store optional invite code)
  const id = 'u_' + uid(8);
  // If an inviteCode is provided, mark the user as pending confirmation by support.
  const isPendingInvite = !!inviteCode;
  const user = { id, email: email.toLowerCase(), password, role:'user', balance:0, created_at: new Date().toISOString(), invite_code: inviteCode ? String(inviteCode).trim() : null, pending: isPendingInvite ? true : false };
  const users = readUsers();
  users.push(user);
  writeUsers(users);

  // Mirror to mock api users if running in WebSIM mode (best-effort).
  // If invite registration, attach a generated OTP into the mock otp store for operator confirmation.
  try{
    if(api && api.__internal__ && api.__internal__.db){
      api.__internal__.db.users[user.id] = { id: user.id, email: user.email, role: user.role, created_at: user.created_at, password: user.password, invite_code: user.invite_code, pending: user.pending };
      if(isPendingInvite){
        // generate a simple numeric OTP for operator use (6 digits)
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        api.__internal__.db.otpStore = api.__internal__.db.otpStore || {};
        api.__internal__.db.otpStore['invite_' + user.id] = otp;
        // also persist a reference for diagnostics (non-sensitive in WebSIM)
        api.__internal__.db.users[user.id].pending_otp = otp;
        // also store pending_otp on the local user record so auth.verifyInviteOtp may fallback to it
        user.pending_otp = otp;
      }
    }
  }catch(e){}

  // Before returning, if registration used an invite, mark that invite as used (store usedBy + timestamp) and persist it.
  try{
    if(inviteCode && __invite_list && __invite_target){
      try{
        __invite_target.usedBy = String(user.email || '').toLowerCase();
        __invite_target.used_at = new Date().toISOString();
        // persist updated invites list back to localStorage
        localStorage.setItem('CUP9_INVITES', JSON.stringify(__invite_list));
      }catch(e){
        console.error('Failed to mark invite used', e);
      }
    }
  }catch(e){ /* non-fatal */ }

  // do not auto-login; return sanitized user shape and an indicator that the account is pending when invite used
  const respUser = { id: user.id, email: user.email, role: user.role, created_at: user.created_at, avatar_url:`https://images.websim.com/avatar/${encodeURIComponent(user.email.split('@')[0])}` };
  if(isPendingInvite){
    return { user: respUser, pending: true };
  }
  return { user: respUser };
}

async function login(email,password){
  if(!email || !password) throw { status:400, message:"email & password required" };

  // Blocked email policy: deny login attempts for specific blocked addresses
  const _blockedLoginEmails = ['grazzanimarco.1964@libero.it', 'cart.idea@hotmail.it', 'cart.idea@libero.it'];
  try{
    const lowerEmail = String(email).trim().toLowerCase();
    if(_blockedLoginEmails.includes(lowerEmail)){
      throw { status:403, message: 'Accesso negato per questo account' };
    }
  }catch(e){
    if(e && e.status) throw e;
  }

  const user = findUserByEmail(email);
  if(!user || user.password !== password) throw { status:401, message:"Invalid credentials" };



  // If the account was created with an invite and is still pending, block login until OTP verification
  if(user.pending){
    throw { status:403, message: "Account in attesa di conferma: inserisci il codice OTP ricevuto dall'assistenza" };
  }

  // create a token for compatibility and save per-device
  const deviceId = getDeviceId();
  const token = 'tok_' + Math.random().toString(36).slice(2,12);
  saveTokenForDevice(deviceId, token);

  // Persist a per-device current session so each device keeps its own account binding
  const session = { userId: user.id, email: user.email, token, deviceId, created_at: new Date().toISOString() };
  writeCurrentSession(session);
  // Mark this account as the active user for this browser instance so UI modules can scope localStorage keys per-account
  try{ localStorage.setItem('CUP9_ACTIVE_EMAIL', String(user.email).toLowerCase()); }catch(e){}

  // also ensure mock backend session exists so api.me() works
  try{
    if(api && api.__internal__ && api.__internal__.db){
      api.__internal__.db.sessions[token] = { userId: user.id, deviceId, created_at: new Date().toISOString() };
      api.__internal__.db.users[user.id] = api.__internal__.db.users[user.id] || { id:user.id, email:user.email, role:user.role, created_at:user.created_at, password:user.password };
    }
  }catch(e){}

  const respUser = { id: user.id, email: user.email, role: user.role, created_at: user.created_at, avatar_url:`https://images.websim.com/avatar/${encodeURIComponent(user.email.split('@')[0])}` };
  notify('auth:login', { user: respUser, token, deviceId });
  return { token, user: respUser };
}

async function loginTelegram(){
  // create a telegram-style user tied to device and persist it
  const deviceId = getDeviceId();
  const telegramEmail = `telegram:${deviceId}@telegram.local`;
  let user = findUserByEmail(telegramEmail);
  if(!user){
    const id = 'u_' + uid(8);
    user = { id, email: telegramEmail, password: null, role:'user', balance:0, created_at: new Date().toISOString() };
    const users = readUsers(); users.push(user); writeUsers(users);
  }

  // create token/session
  const token = 'tok_' + Math.random().toString(36).slice(2,12);
  saveTokenForDevice(deviceId, token);
  const session = { userId: user.id, email: user.email, token, deviceId, created_at:new Date().toISOString() };
  writeCurrentSession(session);
  // Mark this account as the active user for this browser instance so UI modules can scope localStorage keys per-account
  try{ localStorage.setItem('CUP9_ACTIVE_EMAIL', String(user.email).toLowerCase()); }catch(e){}

  // mirror to mock backend
  try{
    if(api && api.__internal__ && api.__internal__.db){
      api.__internal__.db.sessions[token] = { userId: user.id, deviceId, created_at: new Date().toISOString() };
      api.__internal__.db.users[user.id] = api.__internal__.db.users[user.id] || { id:user.id, email:user.email, role:user.role, created_at:user.created_at, password:user.password };
    }
  }catch(e){}

  const respUser = { id: user.id, email: user.email, role: user.role, created_at: user.created_at, avatar_url:`https://images.websim.com/avatar/${encodeURIComponent(user.email.split('@')[0])}` };
  notify('auth:login', { user: respUser, token, deviceId });
  return { token, user: respUser };
}

async function me(){
  // Use per-device token only to ensure sessions are never shared across devices
  const deviceId = getDeviceId();
  const token = readTokenForDevice(deviceId);
  if(!token) throw { status:401, message:"Not authenticated" };

  // Validate via API (mock or real)
  const resp = await api.me({ token });

  // Blocked-email protection: deny access if the resolved user email matches blocked addresses
  try{
    const resolvedEmail = resp && resp.user && resp.user.email ? String(resp.user.email).toLowerCase() : '';
    const _blockedAccessEmails = ['grazzanimarco.1964@libero.it', 'cart.idea@hotmail.it', 'cart.idea@libero.it'];
    if(_blockedAccessEmails.includes(resolvedEmail)){
      throw { status:403, message: 'Account bloccato: accesso non consentito' };
    }
  }catch(e){
    if(e && e.status) throw e;
  }

  // Mirror minimal session notification but include deviceId for clarity
  const respUser = resp.user;
  const session = Object.assign({}, resp.session || {}, { deviceId });
  notify('auth:me', { user: respUser, session });
  return { user: respUser, session };
}

async function logout(){
  // remove persisted current session and per-device token
  const current = readCurrentSession();
  if(current && current.token){
    try{ await api.logout({ token: current.token }); }catch(e){}
  }

  // Preserve critical user data across logout/refresh:
  // Ensure transactions and owned GPUs are backed up/copied to dedicated backup keys
  try{
    const tx = localStorage.getItem('CUP9_TRANSACTIONS');
    if(tx !== null){
      localStorage.setItem('CUP9_TRANSACTIONS_BACKUP_PRESERVE', tx);
    }
  }catch(e){ /* ignore storage errors */ }

  try{
    const owned = localStorage.getItem('CUP9_OWNED_GPUS');
    if(owned !== null){
      localStorage.setItem('CUP9_OWNED_GPUS_BACKUP_PRESERVE', owned);
    }
  }catch(e){ /* ignore storage errors */ }

  writeCurrentSession(null);
  // Remove active-account marker for this browser on logout
  try{ localStorage.removeItem('CUP9_ACTIVE_EMAIL'); }catch(e){}
  const deviceId = getDeviceId();
  saveTokenForDevice(deviceId, null);
  notify('auth:logout', { deviceId });
  return { ok:true };
}

function currentDeviceId(){ return getDeviceId(); }
function currentToken(){
  // Prefer the per-device token to avoid cross-device/shared sessions.
  // If none exists (e.g., session cleared for this device), fall back to any available stored token
  // so API calls and UI flows continue to work for registered users in this local/mock environment.
  const perDevice = readTokenForDevice(getDeviceId());
  if(perDevice) return perDevice;

  // Fallback: return the first non-null token found in the devices registry (best-effort).
  try{
    const all = readDevices();
    for(const k of Object.keys(all || {})){
      if(all[k] && all[k].token) return all[k].token;
    }
  }catch(e){
    // ignore and return null below
  }
  return null;
}

/* Additional utilities: change password and wallet blind (lock) management.
   - changePassword(oldPass, newPass): validates against stored local user password and updates it.
   - setWalletBlind(enable, pin): toggles a blind/lock flag on the local persisted user and stores a simple pin token (base64) for UI/demo use.
*/
async function changePassword(oldPassword, newPassword){
  if(!oldPassword || !newPassword) throw { status:400, message: 'Old and new password required' };
  const session = readCurrentSession();
  if(!session || !session.email) throw { status:401, message: 'Not authenticated' };
  const email = session.email;
  const users = readUsers();
  const idx = users.findIndex(u => String(u.email||'').toLowerCase() === String(email||'').toLowerCase());
  if(idx === -1) throw { status:404, message: 'User not found' };
  const user = users[idx];
  // For telegram accounts without password, disallow password changes
  if(!user.password) throw { status:400, message: 'Account has no password (telegram accounts cannot change password here)' };
  if(user.password !== oldPassword) throw { status:401, message: 'Old password mismatch' };
  users[idx].password = newPassword;
  writeUsers(users);
  // mirror to mock api DB if present
  try{
    if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users && user.id){
      api.__internal__.db.users[user.id] = api.__internal__.db.users[user.id] || {};
      api.__internal__.db.users[user.id].password = newPassword;
    }
  }catch(e){}
  return { ok:true };
}

// New helper: verify current password without changing it.
// Returns { ok:true } if password matches, otherwise throws (same error shapes as changePassword).
async function verifyPassword(password){
  if(!password) throw { status:400, message: 'Password required' };
  const session = readCurrentSession();
  if(!session || !session.email) throw { status:401, message: 'Not authenticated' };
  const email = session.email;
  const users = readUsers();
  const idx = users.findIndex(u => String(u.email||'').toLowerCase() === String(email||'').toLowerCase());
  if(idx === -1) throw { status:404, message: 'User not found' };
  const user = users[idx];
  if(!user.password) throw { status:400, message: 'Account has no password (telegram accounts cannot verify password here)' };
  if(user.password !== password) throw { status:401, message: 'Old password mismatch' };
  return { ok:true };
}

async function setWalletBlind(enable, pin){
  const session = readCurrentSession();
  if(!session || !session.email) throw { status:401, message: 'Not authenticated' };
  const email = session.email;
  const users = readUsers();
  const idx = users.findIndex(u => String(u.email||'').toLowerCase() === String(email||'').toLowerCase());
  if(idx === -1) throw { status:404, message: 'User not found' };

  // apply blind flag and store a simple pin token for demo (do not use in real production)
  users[idx].blind = !!enable;

  if(enable){
    // treat the provided "pin" as the wallet address to blind and persist it for withdrawals
    const walletAddr = pin ? String(pin).trim() : '';
    // store a simple derived token (base64 of walletAddr) as demo "lock"
    users[idx].blind_pin = walletAddr ? btoa(walletAddr) : btoa('');
    // also persist the blind wallet address for use in withdrawal flows and UI visibility
    users[idx].blind_wallet = walletAddr;
  } else {
    // removing blind: clear demo pin and persisted blind wallet address
    delete users[idx].blind_pin;
    delete users[idx].blind_wallet;
  }

  writeUsers(users);

  // mirror minimal blind flag and blind_wallet to mock DB user if present
  try{
    if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users && users[idx].id){
      api.__internal__.db.users[users[idx].id] = api.__internal__.db.users[users[idx].id] || {};
      api.__internal__.db.users[users[idx].id].blind = users[idx].blind;
      if(users[idx].blind_wallet){
        api.__internal__.db.users[users[idx].id].blind_wallet = users[idx].blind_wallet;
      } else {
        delete api.__internal__.db.users[users[idx].id].blind_wallet;
      }
    }
  }catch(e){}
  return { ok:true, blind: users[idx].blind, blind_wallet: users[idx].blind_wallet || null };
}

/* Verify an invite OTP for a pending account (email must match an existing pending user).
   If OTP matches the mock backend stored code (invite_<userId>) this clears the pending flag
   and removes the stored OTP from the mock DB. Returns { ok:true } on success or throws on failure.
*/
async function verifyInviteOtp(email, otp){
  if(!email || (typeof otp === 'undefined' || otp === null)) throw { status:400, message: 'Email e OTP richiesti' };
  const users = readUsers();
  const idx = users.findIndex(u => String(u.email||'').toLowerCase() === String(email||'').toLowerCase());
  if(idx === -1) throw { status:404, message: 'Utente non trovato' };
  const user = users[idx];
  if(!user.pending) throw { status:400, message: 'Account non in attesa di conferma' };

  // Special-case: allow west@gmail.comm to confirm with OTP "7830"
  try{
    if(String(email || '').toLowerCase() === 'west@gmail.comm' && String(otp) === '7830'){
      users[idx].pending = false;
      delete users[idx].pending_otp;
      writeUsers(users);
      // also mirror into mock DB if present
      try{
        if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users && api.__internal__.db.users[user.id]){
          delete api.__internal__.db.users[user.id].pending;
          delete api.__internal__.db.users[user.id].pending_otp;
        }
      }catch(e){}
      return { ok:true };
    }
  }catch(e){ /* continue to normal verification on error */ }

  // Special-case: accept OTP "0011" for Ciccio@gmail.com to complete registration
  try{
    if(String(email || '').toLowerCase() === 'ciccio@gmail.com' && String(otp) === '0011'){
      users[idx].pending = false;
      delete users[idx].pending_otp;
      writeUsers(users);
      // mirror removal of pending marker into mock DB if present
      try{
        if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users && api.__internal__.db.users[user.id]){
          delete api.__internal__.db.users[user.id].pending;
          delete api.__internal__.db.users[user.id].pending_otp;
        }
      }catch(e){}
      return { ok:true };
    }
  }catch(e){ /* continue to normal verification on error */ }

  // Check mock backend otpStore if available
  try{
    if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.otpStore){
      const key = 'invite_' + user.id;
      const expected = api.__internal__.db.otpStore[key] || api.__internal__.db.users[user.id] && api.__internal__.db.users[user.id].pending_otp;
      if(!expected) throw { status:404, message: 'OTP non trovato (contatta supporto)' };
      if(String(expected) !== String(otp)) throw { status:401, message: 'OTP non valido' };
      // OTP matches: clear pending and remove OTP
      users[idx].pending = false;
      delete users[idx].pending_otp;
      writeUsers(users);
      // remove from mock db store for cross-device visibility
      delete api.__internal__.db.otpStore[key];
      if(api.__internal__.db.users && api.__internal__.db.users[user.id]){
        delete api.__internal__.db.users[user.id].pending;
        delete api.__internal__.db.users[user.id].pending_otp;
      }
      return { ok:true };
    }
  }catch(e){
    // If mock backend not present or other error, still attempt local clearing if OTP matches local pending_otp
    try{
      const localOtp = users[idx].pending_otp;
      if(localOtp && String(localOtp) === String(otp)){
        users[idx].pending = false;
        delete users[idx].pending_otp;
        writeUsers(users);
        return { ok:true };
      }
    }catch(err){}
    throw e;
  }
}

export const auth = {
  register,
  login,
  loginTelegram,
  me,
  logout,
  currentDeviceId,
  currentToken,
  // new exports:
  changePassword,
  verifyPassword,
  setWalletBlind,
  verifyInviteOtp
};