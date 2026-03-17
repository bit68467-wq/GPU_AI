// Minimal, mobile-first single-file app using the provided Websim persistence layer (window.websim).
// Features: Registration, Login, Dashboard (Home), basic deposit/withdraw transactions, GPU card, OTP generator, bottom nav.
// Session stored in localStorage under 'cup9gpu_session'.
// The app uses only vanilla JS for portability.

(async function(){
  // small helpers
  const qs = s => document.querySelector(s);
  const qsa = s => Array.from(document.querySelectorAll(s));
  const app = qs('#app');

  // Ensure websim exists (environment provides it). Prefer a live backend connection (Render) and only fall back to a local mock if the backend is unreachable.
  // The app will keep attempting to reconnect to the Render backend periodically so the "real backend" is kept connected when available.
  (function initWebsimConnectivity(){
    // Remote-first adapter: always prefer the Render backend and keep reconnecting frequently.
    // Do not create a full in-page local-mock fallback; instead keep a remote-proxy that tries requests and fails gracefully.
    const BACKEND_API_BASE = 'https://cup9gpuai-61pa.onrender.com/api/collections';
    const POLL_MS = 120000;
    const CACHE_TTL_MS = 300000;

    async function tryPing(){
      try {
        const res = await fetch(BACKEND_API_BASE, { method: 'GET', cache: 'no-store' });
        return res.ok;
      } catch(e){
        return false;
      }
    }

    // build a robust remote adapter that tolerates temporary network failures but always points to the Render API
    function buildRemoteAdapter(){
      return {
        __isRemote: true,
        async getCurrentUser(){ return null; },
        async getCreatedBy(){ return { username: 'creator' }; },
        upload: async ()=> { throw new Error('upload not available'); },
        collection(name){
          const base = BACKEND_API_BASE + '/' + encodeURIComponent(name);
          let cache = null;
          let cacheTs = 0;
          let subs = [];
          let polling = null;
          let inFlight = null;

          async function fetchList(force){
            const now = Date.now();
            if (!force && cache && (now - cacheTs) < CACHE_TTL_MS) return cache.slice();
            if (inFlight) return inFlight;
            inFlight = (async ()=>{
              try {
                const res = await fetch(base, { method: 'GET', cache: 'no-store' });
                if (!res.ok) throw new Error('fetch failed: ' + res.status);
                const data = await res.json();
                cache = Array.isArray(data) ? data.slice() : [];
                cacheTs = Date.now();
                subs.forEach(s => { try { s(cache.slice()); } catch(e){} });
                return cache.slice();
              } catch(e){
                // keep stale cache if available
                return cache ? cache.slice() : [];
              } finally {
                inFlight = null;
              }
            })();
            return inFlight;
          }

          function startPolling(){
            if (polling) return;
            polling = setInterval(()=>{ fetchList().catch(()=>{}); }, POLL_MS);
          }
          function stopPollingIfIdle(){
            if (!polling) return;
            if (subs.length === 0) {
              clearInterval(polling);
              polling = null;
            }
          }
          function upsertCache(rec){
            try {
              if (!cache) cache = [];
              const idx = cache.findIndex(x => String(x.id) === String(rec.id));
              if (idx >= 0) cache[idx] = rec;
              else cache.unshift(rec);
              cacheTs = Date.now();
              subs.forEach(s => { try { s(cache.slice()); } catch(e){} });
            } catch(e){}
          }
          function removeFromCache(id){
            try {
              if (!cache) return;
              cache = cache.filter(x => String(x.id) !== String(id));
              cacheTs = Date.now();
              subs.forEach(s => { try { s(cache.slice()); } catch(e){} });
            } catch(e){}
          }

          return {
            async create(data){
              const res = await fetch(base, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data||{}) });
              if (!res.ok) {
                const txt = await res.text().catch(()=>res.statusText||'create failed');
                throw new Error('create failed: ' + txt);
              }
              const created = await res.json();
              upsertCache(created);
              return created;
            },
            getList(){
              const now = Date.now();
              if (cache && (now - cacheTs) < CACHE_TTL_MS) return cache.slice();
              fetchList().catch(()=>{});
              return cache ? cache.slice() : [];
            },
            filter(obj){
              return {
                getList: () => {
                  const list = (cache && cache.slice()) || [];
                  if (!obj || Object.keys(obj).length === 0) return list;
                  return list.filter(r => Object.keys(obj).every(k => r[k] === obj[k]));
                },
                subscribe: (fn) => {
                  fetchList().catch(()=>{});
                  const wrapper = (list) => {
                    try {
                      const filtered = (list || []).filter(r => Object.keys(obj).every(k => r[k] === obj[k]));
                      fn(filtered.slice());
                    } catch(e){}
                  };
                  subs.push(wrapper);
                  startPolling();
                  if (cache) wrapper(cache);
                  return () => { subs = subs.filter(s=>s!==wrapper); stopPollingIfIdle(); };
                }
              };
            },
            subscribe(fn){
              try { if (cache) { try { fn(cache.slice()); } catch(e){} } } catch(e){}
              fetchList().catch(()=>{});
              const wrapper = (list) => { try { fn(list.slice()); } catch(e){} };
              subs.push(wrapper);
              startPolling();
              return () => { subs = subs.filter(s=>s!==wrapper); stopPollingIfIdle(); };
            },
            async update(id, data){
              const url = base + '/' + encodeURIComponent(id);
              const res = await fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data||{}) });
              if (!res.ok) {
                const txt = await res.text().catch(()=>res.statusText||'update failed');
                throw new Error('update failed: ' + txt);
              }
              const updated = await res.json();
              upsertCache(updated);
              return updated;
            },
            async delete(id){
              const url = base + '/' + encodeURIComponent(id);
              const res = await fetch(url, { method:'DELETE' });
              if (!res.ok) {
                const txt = await res.text().catch(()=>res.statusText||'delete failed');
                throw new Error('delete failed: ' + txt);
              }
              removeFromCache(id);
              return { ok: true };
            },
            async __refresh(){ return await fetchList(true); }
          };
        }
      };
    }

    // Attach remote adapter right away (calls will attempt network requests and either succeed or throw for callers to handle)
    window.websim = buildRemoteAdapter();
    console.log('Websim remote adapter attached (remote-first).');

    // aggressive reconnect loop to keep remote backend available; when backend becomes reachable the adapter uses it implicitly
    // Robust reconnect strategy with exponential backoff and immediate triggers on network/visibility changes
    (function startReconnectLoop(){
      let backoffMs = 500; // start very aggressive for faster initial reconnects
      const MAX_BACKOFF = 30000; // cap at 30s for faster reconnect recovery
      let running = false;

      async function attemptOnce(){
        try {
          const ok = await tryPing();
          if (ok) {
            // successful ping -> reset backoff and refresh caches for known collections to populate local snapshots
            backoffMs = 1000;
            try {
              ['user_v1','transaction_v1','device_v1','otp_v1','session_v1','meta_v1'].forEach(async col => {
                try { await window.websim.collection(col).__refresh(); } catch(e){/*best-effort*/} 
              });
            } catch(e){}
          } else {
            // failed ping -> increase backoff
            backoffMs = Math.min(MAX_BACKOFF, Math.max(1000, backoffMs * 2));
          }
        } catch (e) {
          backoffMs = Math.min(MAX_BACKOFF, Math.max(1000, backoffMs * 2));
        }
      }

      async function loop(){
        if (running) return;
        running = true;
        while (true) {
          await attemptOnce().catch(()=>{});
          // wait backoffMs but break early if navigator reports online change (handled by event listeners below)
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }

      // start background loop
      loop().catch(()=>{ running = false; });

      // immediate retry when browser regains network connectivity
      try {
        window.addEventListener('online', async () => {
          try {
            await attemptOnce();
            // also trigger immediate cache refresh when online
            try {
              ['user_v1','transaction_v1','device_v1','otp_v1','session_v1','meta_v1'].forEach(async col => {
                try { await window.websim.collection(col).__refresh(); } catch(e){/*best-effort*/} 
              });
            } catch(e){}
          } catch(e){}
        });
      } catch(e){}

      // also attempt immediate reconnect when the tab becomes visible again
      try {
        document.addEventListener('visibilitychange', async () => {
          if (document.visibilityState === 'visible') {
            try {
              await attemptOnce();
              try {
                ['user_v1','transaction_v1','device_v1','otp_v1','session_v1','meta_v1'].forEach(async col => {
                  try { await window.websim.collection(col).__refresh(); } catch(e){/*best-effort*/} 
                });
              } catch(e){}
            } catch(e){}
          }
        });
      } catch(e){}
    })();
  })();

  // collections we'll use: cached, coalesced REST-backed wrapper using the backend API.
  // Goals: lazy-load, in-memory TTL, coalesce concurrent fetches, reduce polling frequency,
  // update cache locally on create/update/delete so UI can render quickly without repeated network calls.
  function getCollection(name){
    const API_BASE = 'https://cup9gpuai-61pa.onrender.com/api/collections';
    const base = API_BASE + '/' + encodeURIComponent(name);

    // in-memory cache and metadata per collection instance
    let cache = null;
    let cacheTs = 0; // timestamp when cache was last refreshed
    let subs = [];
    let polling = null;
    // reduce network requests: poll less frequently and treat cache as fresh longer
    // more aggressive polling/caching to speed synchronization with Render backend
    const POLL_MS = 10000; // poll every 10s
    const CACHE_TTL_MS = 60000; // treat cache as fresh for 60s
    let inFlightFetch = null; // coalesce concurrent fetches

    // fetch list from server, coalescing concurrent fetches
    async function fetchList(force){
      const now = Date.now();
      if (!force && cache && (now - cacheTs) < CACHE_TTL_MS) {
        return cache.slice();
      }
      if (inFlightFetch) return inFlightFetch;
      inFlightFetch = (async () => {
        try {
          const res = await fetch(base, { credentials: 'omit' });
          if (!res.ok) throw new Error('fetch failed: ' + res.status);
          const data = await res.json();
          cache = Array.isArray(data) ? data.slice() : [];
          cacheTs = Date.now();
          // notify subscribers with a shallow copy for safety
          subs.forEach(s => { try { s(cache.slice()); } catch(e){} });
          return cache.slice();
        } catch (e) {
          // on error, keep existing cache if any
          return cache ? cache.slice() : [];
        } finally {
          inFlightFetch = null;
        }
      })();
      return inFlightFetch;
    }

    function startPolling(){
      if (polling) return;
      polling = setInterval(() => { fetchList().catch(()=>{}); }, POLL_MS);
    }
    function stopPollingIfIdle(){
      if (!polling) return;
      if (subs.length === 0) {
        clearInterval(polling);
        polling = null;
      }
    }

    // helpers to update local cache deterministically to avoid extra GETs
    function upsertToCache(rec){
      try {
        if (!cache) cache = [];
        const idx = cache.findIndex(x => String(x.id) === String(rec.id));
        if (idx >= 0) cache[idx] = rec;
        else cache.unshift(rec);
        cacheTs = Date.now();
        subs.forEach(s => { try { s(cache.slice()); } catch(e){} });
      } catch(e){}
    }
    function removeFromCache(id){
      try {
        if (!cache) return;
        cache = cache.filter(x => String(x.id) !== String(id));
        cacheTs = Date.now();
        subs.forEach(s => { try { s(cache.slice()); } catch(e){} });
      } catch(e){}
    }

    return {
      async create(data){
        const payload = data || {};
        // optimistic create: try server, but update local cache immediately on success
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          // avoid swallowing errors so callers can handle offline or failures
          const text = await res.text().catch(()=>res.statusText || 'create failed');
          throw new Error('create failed: ' + text);
        }
        const created = await res.json();
        upsertToCache(created);
        return created;
      },
      getList(){
        // return cached copy if fresh; otherwise trigger background refresh and return last known cache immediately
        const now = Date.now();
        if (cache && (now - cacheTs) < CACHE_TTL_MS) return cache.slice();
        // asynchronous refresh but don't block synchronous UI render
        fetchList().catch(()=>{});
        return cache ? cache.slice() : [];
      },
      filter(obj){
        return {
          getList: () => {
            const list = (cache && cache.slice()) || [];
            if (!obj || Object.keys(obj).length === 0) return list;
            return list.filter(r => Object.keys(obj).every(k => r[k] === obj[k]));
          },
          subscribe: (fn) => {
            // ensure a fresh fetch for subscribers, but coalesced
            fetchList().catch(()=>{});
            const wrapper = (list) => {
              try {
                const filtered = (list || []).filter(r => Object.keys(obj).every(k => r[k] === obj[k]));
                fn(filtered.slice());
              } catch(e){}
            };
            subs.push(wrapper);
            startPolling();
            // immediate invoke with current filtered value if available
            if (cache) wrapper(cache);
            return () => {
              subs = subs.filter(s => s !== wrapper);
              stopPollingIfIdle();
            };
          }
        };
      },
      subscribe(fn){
        // deliver cached snapshot immediately if available, and ensure a background fetch
        try {
          if (cache) {
            try { fn(cache.slice()); } catch(e){}
          }
        } catch(e){}
        // trigger a fresh fetch to reconcile state
        fetchList().catch(()=>{});
        const wrapper = (list) => { try { fn(list.slice()); } catch(e){} };
        subs.push(wrapper);
        startPolling();
        return () => {
          subs = subs.filter(s => s !== wrapper);
          stopPollingIfIdle();
        };
      },
      async update(id, data){
        const url = base + '/' + encodeURIComponent(id);
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data || {})
        });
        if (!res.ok) {
          const text = await res.text().catch(()=>res.statusText || 'update failed');
          throw new Error('update failed: ' + text);
        }
        const updated = await res.json();
        // update local cache to reflect server state without extra GET
        upsertToCache(updated);
        return updated;
      },
      async delete(id){
        const url = base + '/' + encodeURIComponent(id);
        const res = await fetch(url, { method: 'DELETE' });
        if (!res.ok) {
          const text = await res.text().catch(()=>res.statusText || 'delete failed');
          throw new Error('delete failed: ' + text);
        }
        // reflect deletion in local cache
        removeFromCache(id);
        return { ok: true };
      },
      // expose internal helper to force refresh when callers really need fresh data
      async __refresh(){
        return await fetchList(true);
      }
    };
  }

  const usersCol = getCollection('user_v1'); // versioned in case of schema change
  const txCol = getCollection('transaction_v1');
  const deviceCol = getCollection('device_v1');
  const otpCol = getCollection('otp_v1');
  // server-like persistent sessions stored in a collection so sessions survive across browsers/devices using the same backend
  const sessionsCol = getCollection('session_v1');

  // Enforce non-deletable user accounts: override any delete method for usersCol to be a safe no-op
  try {
    if (usersCol) {
      const rawDelete = usersCol.delete && usersCol.delete.bind(usersCol);
      usersCol.delete = async function(id){
        // Never delete user accounts; log the attempt and return a consistent failure object
        try {
          console.warn('Blocked attempt to delete user account:', id);
          // Attempt to mark as deactivated instead of deleting (best-effort)
          if (typeof usersCol.update === 'function') {
            try {
              await usersCol.update(id, { deleted_at: new Date().toISOString(), deactivated: true, deactivated_by_system: true });
            } catch(e){}
          }
        } catch(e){}
        // Return an object mirroring the backend delete failure response so callers can handle gracefully
        return { ok: false, error: 'deletion_blocked', message: 'User deletion is blocked for safety; account was deactivated instead.' };
      };
    }
  } catch (e) {
    console.warn('usersCol delete override failed', e);
  }

  // expose core collections to global scope so hardware.js and other modules can access them reliably
  window.usersCol = usersCol;
  window.txCol = txCol;
  window.deviceCol = deviceCol;
  window.otpCol = otpCol;
  window.sessionsCol = sessionsCol;

  // detect project creator username for admin access (best-effort)
  let creatorUsername = null;
  (async ()=>{
    try {
      if (window.websim && typeof window.websim.getCreatedBy === 'function') {
        const creator = await window.websim.getCreatedBy();
        creatorUsername = (creator && creator.username) || creatorUsername;
      }
    } catch(e){ /* ignore */ }
    // fallback: if meta contains creator key, use that
    try {
      const meta = getCollection('meta_v1');
      const about = meta.getList().find(m=>m.key==='created_by');
      if (about && about.value && !creatorUsername) creatorUsername = about.value;
    } catch(e){}
    // last fallback: use 'creator'
    if (!creatorUsername) creatorUsername = 'creator';
  })();

  // Ensure user records are always persisted to localStorage as a durable backup
  // This wrapper favors backend-first persistence: it checks for duplicates, awaits backend create/update/delete,
  // and only writes to localStorage after a confirmed server response to avoid duplicate records.
  (function ensureUserPersistence() {
    const STORAGE_KEY = 'cup9gpu_persistent_users_v1';

    // on init: if server has no users but localStorage does, try to push local users to server (best-effort, deduped)
    try {
      const serverList = usersCol.getList() || [];
      const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if ((!serverList || serverList.length === 0) && persisted && persisted.length) {
        // push persisted users to server if not present (dedupe by email)
        persisted.slice().reverse().forEach(async u => {
          try {
            const exists = (usersCol.getList() || []).find(x => x.email && u.email && String(x.email).toLowerCase() === String(u.email).toLowerCase());
            if (!exists) {
              // use create which will persist to backend via collection implementation
              await usersCol.create && usersCol.create(u);
            }
          } catch(e){ /* best-effort */ }
        });
      } else if (serverList && serverList.length) {
        // if server has data, overwrite local persisted copy to keep localStorage in sync
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serverList.map(u => ({
          id: u.id, username: u.username, email: u.email, password: u.password, user_uid: u.user_uid, created_at: u.created_at, updated_at: u.updated_at
        })))); } catch(e){}
      }
    } catch(e){ console.warn('load persisted users failed', e); }

    // wrapper helpers to persist current user list after stable backend-confirmed mutations
    function persistNow() {
      try {
        const list = usersCol.getList() || [];
        // store minimal safe copy
        const copy = list.map(u => ({
          id: u.id,
          username: u.username,
          email: u.email,
          password: u.password,
          user_uid: u.user_uid,
          created_at: u.created_at,
          updated_at: u.updated_at
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
      } catch(e){ console.warn('persist users failed', e); }
    }

    // Replace create/update/delete wrappers to be backend-first, dedupe on email, await results, then persist.
    try {
      const rawCreate = usersCol.create && usersCol.create.bind(usersCol);
      if (rawCreate) {
        usersCol.create = async function(data){
          // dedupe by email (check current server cache first)
          try {
            const email = data && data.email ? String(data.email).toLowerCase() : null;
            if (email) {
              const existing = (usersCol.getList() || []).find(u => u.email && String(u.email).toLowerCase() === email);
              if (existing) {
                // return existing to caller to avoid duplicate account creation
                return existing;
              }
            }
          } catch(e){ /* ignore dedupe errors and continue to create */ }

          // perform create and await backend confirmation (collection implementation handles POST)
          const res = await rawCreate(data);
          // If create returned a server-side id, reconcile local cache immediately
          try { persistNow(); } catch(e){}
          return res;
        };
      }

      const rawUpdate = usersCol.update && usersCol.update.bind(usersCol);
      if (rawUpdate) {
        usersCol.update = async function(id, data){
          // perform update via collection (await server-side PATCH)
          const res = await rawUpdate(id, data);
          try { persistNow(); } catch(e){}
          return res;
        };
      }

      const rawDelete = usersCol.delete && usersCol.delete.bind(usersCol);
      if (rawDelete) {
        usersCol.delete = async function(id){
          // Respect protected-deletion behavior implemented at collection/server level; await result
          const res = await rawDelete(id);
          try { persistNow(); } catch(e){}
          return res;
        };
      }

      // persist once at init to capture current state
      persistNow();
    } catch(e){
      console.warn('user persistence wrapper failed', e);
    }

    // subscribe to server-side users collection changes (if supported) so localStorage is always synchronized
    try {
      if (typeof usersCol.subscribe === 'function') {
        const unsub = usersCol.subscribe(() => {
          try { persistNow(); } catch(e){}
        });
        window.__cup9gpu_unsubs = window.__cup9gpu_unsubs || [];
        window.__cup9gpu_unsubs.push(unsub);
      }
    } catch (e) {
      console.warn('usersCol.subscribe failed', e);
    }

    // expose a helper to force-save users
    window.__cup9gpu_forcePersistUsers = persistNow;
  })();

  // Persist transactions, devices, sessions and OTPs to localStorage to ensure full durability across refreshes/browsers.
  (function ensureDataPersistence() {
    const keys = {
      tx: 'cup9gpu_persistent_transactions_v1',
      devices: 'cup9gpu_persistent_devices_v1',
      sessions: 'cup9gpu_persistent_sessions_v1',
      otp: 'cup9gpu_persistent_otp_v1'
    };

    // load persisted data into collections if empty
    try {
      const loadIfEmpty = (col, key) => {
        const persisted = JSON.parse(localStorage.getItem(key) || '[]');
        const existing = col.getList();
        if (persisted && persisted.length && (!existing || existing.length === 0)) {
          // add in reverse so original order approximates stored order
          persisted.slice().reverse().forEach(r => {
            const dup = col.getList().find(x => x.id === r.id);
            if (!dup) {
              try { col.create && col.create(r); } catch(e){ /* best-effort */ }
            }
          });
        }
      };

      loadIfEmpty(txCol, keys.tx);
      loadIfEmpty(deviceCol, keys.devices);
      loadIfEmpty(sessionsCol, keys.sessions);
      loadIfEmpty(otpCol, keys.otp);
    } catch (e) {
      console.warn('load persisted collections failed', e);
    }

    // wrapper generator to persist after mutations
    const wrapCol = (col, storageKey) => {
      if (!col) return;

      // compute and publish OTP counts map (user_id => unusedCount)
      function publishOtpCounts() {
        try {
          if (!otpCol || typeof otpCol.getList !== 'function') return;
          const list = otpCol.getList() || [];
          const map = {};
          list.forEach(o => {
            if (!o || !o.user_id) return;
            if (o.used) return;
            map[o.user_id] = (map[o.user_id] || 0) + 1;
          });
          // store global counts map in localStorage for cross-tab visibility
          try { localStorage.setItem('cup9gpu_otp_counts', JSON.stringify(map)); } catch(e){}
          // dispatch a custom event with counts for in-page listeners
          try { window.dispatchEvent(new CustomEvent('otp_counts_updated', { detail: map })); } catch(e){}
        } catch (e) { console.warn('publishOtpCounts failed', e); }
      }

      const persistNow = () => {
        try {
          const list = col.getList() || [];
          // Save a minimal safe copy
          const copy = list.map(r => {
            const out = {};
            for (const k in r) {
              if (typeof r[k] !== 'function') out[k] = r[k];
            }
            return out;
          });
          localStorage.setItem(storageKey, JSON.stringify(copy));
        } catch (e) { console.warn('persist failed', e); }
        // whenever any wrapped collection persists, refresh OTP counts (safe no-op for non-otp cols)
        try { publishOtpCounts(); } catch(e){}
      };

      try {
        const rawCreate = col.create && col.create.bind(col);
        if (rawCreate) {
          col.create = async function(data){
            const res = await rawCreate(data);
            try { persistNow(); } catch(e){}
            return res;
          };
        }
        const rawUpdate = col.update && col.update.bind(col);
        if (rawUpdate) {
          col.update = async function(id, data){
            const res = await rawUpdate(id, data);
            try { persistNow(); } catch(e){}
            return res;
          };
        }
        const rawDelete = col.delete && col.delete.bind(col);
        if (rawDelete) {
          col.delete = async function(id){
            const res = await rawDelete(id);
            try { persistNow(); } catch(e){}
            return res;
          };
        }
        // initial persist of current state and publish counts
        persistNow();
      } catch(e){
        console.warn('wrapCol failed', e);
      }
    };

    wrapCol(txCol, keys.tx);
    wrapCol(deviceCol, keys.devices);
    wrapCol(sessionsCol, keys.sessions);
    wrapCol(otpCol, keys.otp);

    // expose helper for debugging
    window.__cup9gpu_forcePersist = function(){ 
      try {
        localStorage.setItem(keys.tx, JSON.stringify(txCol.getList()||[]));
        localStorage.setItem(keys.devices, JSON.stringify(deviceCol.getList()||[]));
        localStorage.setItem(keys.sessions, JSON.stringify(sessionsCol.getList()||[]));
        localStorage.setItem(keys.otp, JSON.stringify(otpCol.getList()||[]));
      } catch(e){ console.warn(e); }
    };
  })();

  // Session helpers - purely localStorage-based session handling (no WebSIM credentials/use).
  // Use per-tab session storage key to avoid sharing sessions between tabs/users.
  // sessionStorage is scoped to each tab/window so different tabs can hold different sessions.
  const SESSION_KEY = 'cup9gpu_session_' + (sessionStorage.getItem('cup9gpu_tab_id') || (function(){
    try {
      const id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('tab_' + Date.now().toString(36) + Math.random().toString(36).slice(2));
      sessionStorage.setItem('cup9gpu_tab_id', id);
      return id;
    } catch (e) {
      const id = 'tab_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
      try { sessionStorage.setItem('cup9gpu_tab_id', id); } catch(e){}
      return id;
    }
  })());

  // saveSession stores a normalized session object locally only.
  async function saveSession(user){
    try {
      // Normalize session input and ensure we always have a persistent uid.
      // If caller provided only an id or lacked uid, attempt to resolve the authoritative user record.
      let resolvedUid = user?.uid || user?.user_uid || null;
      let resolvedUsername = user?.username || user?.name || user?.email || 'user';
      let resolvedEmail = user?.email || null;
      let resolvedIsAdmin = !!user?.is_admin;
      let resolvedId = user?.id || null;

      // If we have an id but no uid, try to fetch the user record from usersCol to obtain user_uid.
      try {
        if ((!resolvedUid || resolvedUid === null) && resolvedId && usersCol && typeof usersCol.getList === 'function') {
          const rec = usersCol.getList().find(u => u.id === resolvedId);
          if (rec) {
            resolvedUid = resolvedUid || rec.user_uid || rec.uid || null;
            resolvedUsername = resolvedUsername || rec.username || rec.name || rec.email || resolvedUsername;
            resolvedEmail = resolvedEmail || rec.email || null;
            resolvedIsAdmin = resolvedIsAdmin || !!rec.is_admin;
          }
        }
      } catch (e) {
        // best-effort: ignore lookup failure
      }

      // If still missing a uid, generate one (and attempt to persist it to the user record)
      if (!resolvedUid) {
        try { resolvedUid = crypto.randomUUID(); } catch(e){ resolvedUid = 'uid_' + (Date.now().toString(36) + Math.random().toString(36).slice(2)); }
        try {
          if (resolvedId && usersCol && typeof usersCol.update === 'function') {
            // persist user_uid back to user record for cross-device session recovery
            usersCol.update(resolvedId, { user_uid: resolvedUid }).catch(()=>{});
          }
        } catch(e){}
      }

      const normalized = {
        id: resolvedId,
        uid: resolvedUid,
        username: resolvedUsername,
        email: resolvedEmail,
        is_admin: resolvedIsAdmin,
        updated_at: new Date().toISOString()
      };

      // create or update a server-side session record so the session exists persistently across browsers/devices
      try {
        // try to find an existing session for this user uid; tolerate different field names (uid / user_uid)
        const existing = sessionsCol.getList().find(s => (s.uid && s.uid === normalized.uid) || (s.user_uid && s.user_uid === normalized.uid));
        if (existing && existing.id) {
          await sessionsCol.update && sessionsCol.update(existing.id, {
            user_id: normalized.id,
            uid: normalized.uid,
            username: normalized.username,
            email: normalized.email,
            updated_at: normalized.updated_at
          });
          normalized.session_id = existing.id;
        } else {
          const rec = await sessionsCol.create({
            user_id: normalized.id,
            uid: normalized.uid,
            username: normalized.username,
            email: normalized.email,
            created_at: new Date().toISOString(),
            updated_at: normalized.updated_at
          });
          normalized.session_id = rec.id;
        }
      } catch (e) {
        // if sessionsCol isn't persistent in this environment, continue with local-only save
        console.warn('server-side session save failed', e);
      }

      // persist locally to sessionStorage (per-tab) and also expose globally for immediate cross-module access
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(normalized)); } catch(e){/*best-effort*/}
      window.__cup9_session = normalized;
      return normalized;
    } catch(e){
      console.warn('saveSession failed', e);
      return null;
    }
  }

  // On boot: intentionally clear any local session on refresh so users must re-authenticate.
  // We do NOT delete or modify persistent user data (transactions, devices, otp, sessions collection), only the local view.
  // On boot: ensure no shared local session is used; clear this tab's sessionStorage entry so user must log in in each tab.
  (function restoreSessionPerTab(){
    try {
      try { sessionStorage.removeItem(SESSION_KEY); } catch(e){}
      window.__cup9_session = null;
    } catch (e) {
      console.warn('clear per-tab session on boot failed', e);
      window.__cup9_session = null;
    }
  })();

  // clearSession removes only local session cache. It no longer deletes server-side session records
  // to ensure account and session history remain persistent on logout/refresh.
  async function clearSession(){
    try {
      // Do NOT delete server-side session records here. Keep sessions persistent so accounts and
      // their history remain available across devices and after logout/refresh.
      try { sessionStorage.removeItem(SESSION_KEY); } catch(e){}
      // clear global in-memory session for this tab only
      try { window.__cup9_session = null; } catch(e){}
    } catch(e){ console.warn('clearSession failed', e); }
  }

  // synchronous session accessor: return only the in-memory session.
  // Important: do NOT auto-restore from localStorage or server on page load — the user must log in explicitly.
  function getSession(){
    try {
      // Prefer in-memory session, otherwise read this tab's sessionStorage copy (no shared localStorage)
      if (window.__cup9_session) return window.__cup9_session;
      try {
        const s = sessionStorage.getItem(SESSION_KEY);
        if (!s) return null;
        const parsed = JSON.parse(s);
        window.__cup9_session = parsed;
        return parsed;
      } catch(e){
        return window.__cup9_session || null;
      }
    } catch(e){
      return null;
    }
  }

  // Navigation state
  // detect referral code in URL (query or hash) and auto-open registration when present (prefill invite input)
  function extractRefFromString(s){
    try {
      if (!s) return null;
      // if it's a full URL, try to parse its query/hash
      try {
        const u = new URL(s, window.location.origin);
        const p = new URLSearchParams(u.search);
        return p.get('ref') || p.get('invite') || null;
      } catch(e){
        // not a full URL: attempt to treat it as raw query or a direct code
      }
      // if string contains '?ref=' or 'ref=' fragment, extract
      const m = s.match(/[?&]ref=([^&#]+)/i) || s.match(/[?&]invite=([^&#]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);
      // if it's a hash like #ref=CODE or #/register?ref=CODE
      const h = s.split('#').slice(1).join('#');
      if (h) {
        const mh = h.match(/ref=([^&]+)/i) || h.match(/invite=([^&]+)/i);
        if (mh && mh[1]) return decodeURIComponent(mh[1]);
      }
      // fallback: treat entire string as a possible code (alphanumeric)
      const clean = String(s).trim();
      if (clean.length > 0 && clean.length <= 128) return clean;
      return null;
    } catch(e){ return null; }
  }

  const urlSearch = (typeof window !== 'undefined' && window.location) ? (window.location.search || '') : '';
  const urlHash = (typeof window !== 'undefined' && window.location) ? (window.location.hash || '') : '';
  const urlParams = urlSearch ? new URLSearchParams(urlSearch) : null;
  let urlRef = null;
  if (urlParams) urlRef = urlParams.get('ref') || urlParams.get('invite') || null;
  if (!urlRef && urlHash) {
    // allow referral code specified in hash (e.g. /#/?ref=CODE or #ref=CODE)
    urlRef = extractRefFromString(urlHash);
  }
  // also handle cases where the entire search is a plain code (e.g. ?CODE) or the user pasted a full URL into a link (rare)
  if (!urlRef && urlSearch) {
    const raw = urlSearch.replace(/^\?/, '');
    urlRef = extractRefFromString(raw);
  }

  // normalize (ensure it's a plain code, not an entire URL)
  if (urlRef) {
    // if it's a full url-like string, try to extract the param again
    try {
      if (urlRef.indexOf('http') === 0) {
        const parsed = extractRefFromString(urlRef);
        if (parsed) urlRef = parsed;
      }
    } catch(e){}
    urlRef = String(urlRef).trim();
    if (urlRef === '') urlRef = null;
  }

  // expose for other modules/pages that may need it
  window.__cup9_ref = urlRef;
  // start on register page if a referral code exists and no explicit session/navigation occurred
  let route = urlRef ? 'register' : 'home';
  // transaction history page pointer (used by admin/user navigation to the transactions view)
  let txPage = 1;
  function navigate(to){
    // Enforce admin-only view: any admin session is always routed to the admin panel and cannot navigate elsewhere.
    try {
      const session = getSession();
      if (session && session.is_admin) {
        // always force admin to admin panel; allow explicit logout/login route for switching accounts
        if (to !== 'login' && to !== 'admin') {
          // silently force admin route without exposing platform pages
          route = 'admin';
          render();
          return;
        }
      }
    } catch(e){
      // ignore and continue
    }
    route = to;
    render();
  }

  // Simple router: render pages
  async function render(){
    const session = getSession();
    // For admin sessions always force admin route to prevent access to regular platform views.
    try {
      if (session && session.is_admin) {
        route = 'admin';
      }
    } catch(e){ /* ignore */ }

    // clear any leftover collection subscriptions from previous renders to avoid duplicate updates
    try {
      if (!window.__cup9gpu_unsubs) window.__cup9gpu_unsubs = [];
      while (window.__cup9gpu_unsubs.length) {
        const u = window.__cup9gpu_unsubs.shift();
        try { if (typeof u === 'function') u(); } catch(e){}
      }
    } catch(e){ /* ignore */ }
    app.innerHTML = '';
    // auto-accrue earnings once per day for the session — run only once per session to avoid doing this on every re-render
    try {
      if (session && !session.is_admin) {
        // only run accruals for non-admin sessions
        window.__cup9gpu_accrued = window.__cup9gpu_accrued || {};
        const sid = session.id || session.uid || 'anon';
        if (!window.__cup9gpu_accrued[sid]) {
          // run accruals asynchronously so initial render isn't blocked
          try { setTimeout(()=>{ accrueEarnings(session).catch(e => console.warn('accrueEarnings failed', e)); }, 0); } catch(e){ console.warn('accrue scheduling failed', e); }
          // mark as scheduled immediately to avoid re-scheduling during initial navigation bursts
          window.__cup9gpu_accrued[sid] = Date.now();
        }
      }
    } catch(e){}
    if (!session && route !== 'login' && route !== 'register') {
      route = 'login';
    }

    // Header with notification bell (shows only valid/unused OTPs for current user)
    if (route !== 'login' && route !== 'register') {
      const header = document.createElement('div');
      header.className = 'header';

      const brand = document.createElement('div');
      brand.className = 'brand';
      const logo = document.createElement('div'); logo.className='logo'; logo.textContent='C9';
      const titWrap = document.createElement('div');
      titWrap.appendChild(el('div.h-title','CUP9GPU'));
      titWrap.appendChild(el('div.h-sub','Hosting · Leas. GPU'));
      brand.appendChild(logo);
      brand.appendChild(titWrap);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '10px';

      // notification bell
      const bellWrap = document.createElement('div'); bellWrap.style.display='flex'; bellWrap.style.alignItems='center';
      const bell = document.createElement('button'); bell.className = 'notif-btn notif-badge';
      bell.title = 'Notifiche';
      bell.innerHTML = '🔔';
      // count unused OTPs and keep it updated via subscription to the otp collection
      const updateBellCount = (fromMap)=>{
        try {
          // prefer event-supplied counts (fromMap), fallback to otpCol direct list, then localStorage
          let count = 0;
          if (fromMap && typeof fromMap === 'object') {
            count = Number(fromMap[session?.id] || 0);
          } else {
            const list = (otpCol && typeof otpCol.getList === 'function') ? otpCol.getList() : [];
            count = (list || []).filter(o => o.user_id === session?.id && !o.used).length;
            if (typeof count !== 'number' || isNaN(count)) {
              try {
                const stored = JSON.parse(localStorage.getItem('cup9gpu_otp_counts') || '{}');
                count = Number((stored && stored[session?.id]) || 0);
              } catch(e){}
            }
          }
          // always show a numeric badge including zero
          bell.setAttribute('data-count', String(count));
          bell.style.color = count>0 ? 'var(--accent)' : 'var(--text-secondary)';
        } catch(e){}
      };
      updateBellCount();

      // subscribe to otp collection changes so the badge reflects the real number of notifications
      try {
        if (otpCol && typeof otpCol.subscribe === 'function') {
          const unsub = otpCol.subscribe(() => {
            // subscription may fire for all OTPs; recalc relevant count for this session
            updateBellCount();
          });
          // track unsubscribe functions globally and clear them at next render
          window.__cup9gpu_unsubs = window.__cup9gpu_unsubs || [];
          window.__cup9gpu_unsubs.push(unsub);
        }
      } catch(e){ console.warn('otp subscribe failed', e); }

      // listen for global published counts (from same tab) and storage events (from other tabs) for real-time updates
      try {
        const handler = (ev) => {
          if (ev && ev.detail) updateBellCount(ev.detail);
          else {
            // storage event: re-read counts map
            try {
              const stored = JSON.parse(localStorage.getItem('cup9gpu_otp_counts') || '{}');
              updateBellCount(stored);
            } catch(e){}
          }
        };
        window.addEventListener('otp_counts_updated', handler);
        window.addEventListener('storage', handler);
        // ensure we unsubscribe on re-render
        window.__cup9gpu_unsubs = window.__cup9gpu_unsubs || [];
        window.__cup9gpu_unsubs.push(()=>{ window.removeEventListener('otp_counts_updated', handler); window.removeEventListener('storage', handler); });
      } catch(e){}

      bell.onclick = ()=> {
        // open modal listing only valid (unused) OTPs for this user
        const overlay = document.createElement('div'); overlay.className='notif-overlay';
        const modal = document.createElement('div'); modal.className='notif-modal';
        const hdr = document.createElement('div'); hdr.className='nm-header';
        hdr.appendChild(el('div.h-title','Notifiche (OTP)'));
        const close = document.createElement('button'); close.className='btn'; close.textContent='Chiudi';
        close.onclick = ()=> { document.body.removeChild(overlay); updateBellCount(); };
        hdr.appendChild(close);
        modal.appendChild(hdr);

        const listWrap = document.createElement('div'); listWrap.className='notif-list';
        // show only unused OTPs that are still relevant: linked to a transaction that is pending or has status 'otp_sent'
        const otps = (otpCol.getList() || [])
          .filter(o => o.user_id === session?.id && !o.used)
          .filter(o => {
            // find related transaction and ensure it's still awaiting OTP confirmation
            try {
              const tx = txCol.getList().find(t => t.id === o.tx_id);
              if (!tx) return false;
              const st = (tx.status || 'confirmed').toLowerCase();
              return st === 'otp_sent' || st === 'pending';
            } catch (e) {
              return false;
            }
          })
          .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        if (!otps.length) {
          listWrap.appendChild(el('div.small','Nessun OTP valido'));
        } else {
          otps.forEach(o=>{
            const item = document.createElement('div'); item.className='notif-item';
            const left = document.createElement('div');
            left.appendChild(el('div.notif-code', o.code || '—'));
            left.appendChild(el('div.notif-meta', new Date(o.created_at).toLocaleString()));
            const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px'; actions.style.alignItems='center';
            const copy = document.createElement('button'); copy.className='btn'; copy.textContent='Copia';
            copy.onclick = ()=> {
              try { navigator.clipboard.writeText(String(o.code)); alert('OTP copiato'); } catch(e){ alert('Copia non supportata'); }
            };
            const info = document.createElement('div'); info.className='small'; info.style.color='var(--muted)'; info.textContent = o.tx_id ? 'Collegato a transazione' : '';
            actions.appendChild(copy);
            item.appendChild(left);
            item.appendChild(actions);
            item.appendChild(info);
            listWrap.appendChild(item);
          });
        }

        modal.appendChild(listWrap);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
      };

      // welcome / avatar
      const welcome = el('div', el('div.small','Benvenuto, ' + (session?.username || 'Guest')));
      right.appendChild(bell);
      right.appendChild(welcome);

      header.appendChild(brand);
      header.appendChild(right);
      app.appendChild(header);
    }

    // Pages (all main pages use the hardware-page layout wrapper for consistent appearance)
    // Render the selected page, wrapping every page in the hardware-page layout for consistent fullscreen appearance
    let pageEl = null;
    if (route === 'login') pageEl = loginPage();
    else if (route === 'register') pageEl = registerPage();
    else if (route === 'admin') pageEl = adminPage();
    else if (route === 'home') pageEl = await homePage();
    else if (route === 'hardware') pageEl = hardwarePage();
    else if (route === 'devices') pageEl = await myDevicesPage();
    else if (route === 'licenses') pageEl = licensesPage();
    else if (route === 'profile') pageEl = profilePage();
    else if (route === 'transactions') pageEl = await transactionsPage();
    else { navigate('home'); return; }

    // wrap with hardware-page container for unified layout across all pages
    const wrapper = document.createElement('div');
    wrapper.className = 'hardware-page';
    wrapper.appendChild(pageEl);
    app.appendChild(wrapper);

    // If the current session is admin, force admin-only nav; otherwise show normal bottom nav.
    const sessionNow = getSession();
    if (sessionNow && sessionNow.is_admin) {
      // admin sees only admin panel and a minimal nav for logout
      wrapper.appendChild(bottomNav('admin', true, { adminOnly: true }));
    } else {
      // always include the bottom nav as part of the page wrapper so it is the final lower section of each page
      wrapper.appendChild(bottomNav(route, true));
    }
  }

  // small DOM helper
  function el(tag, content){
    const d = document.createElement('div');
    d.className = tag;
    if (typeof content === 'string') d.textContent = content;
    else if (Array.isArray(content)){
      content.forEach(c=>{
        if (typeof c === 'string') d.appendChild(document.createTextNode(c));
        else d.appendChild(c);
      });
    } else if (content instanceof HTMLElement) d.appendChild(content);
    return d;
  }

  // Forms
  function registerPage(){
    const wrap = document.createElement('div');
    wrap.className = 'card';
    const title = document.createElement('h3'); title.textContent = 'Crea account';
    wrap.appendChild(title);

    const form = document.createElement('div'); form.className='form';
    const lblUsername = labeled('username','Username');
    const inpUsername = input('text','username');
    lblUsername.appendChild(inpUsername);

    const lblEmail = labeled('email','Email');
    const inpEmail = input('email','email');
    lblEmail.appendChild(inpEmail);

    const lblInvite = labeled('invite','Codice invito (opzionale)');
    const inpInvite = input('text','invite');
    // if the page was opened via a referral link, prefill the invite input
    try { if (window.__cup9_ref) inpInvite.value = window.__cup9_ref; } catch(e){}
    lblInvite.appendChild(inpInvite);

    const lblPass = labeled('password','Password');
    const inpPass = input('password','password');
    lblPass.appendChild(inpPass);

    const lblPass2 = labeled('confirm','Conferma password');
    const inpPass2 = input('password','confirm');
    lblPass2.appendChild(inpPass2);

    const chkRow = document.createElement('label'); chkRow.className='checkbox-row';
    const chk = document.createElement('input'); chk.type='checkbox'; chk.id='tos';
    chkRow.appendChild(chk);
    const tos = document.createElement('span'); tos.textContent='Accetto termini di servizio'; tos.style.fontSize='13px'; chkRow.appendChild(tos);

    const btn = document.createElement('button'); btn.className='primary'; btn.textContent='Registrati';
    btn.onclick = async ()=>{
      if (!inpUsername.value.trim()||!inpEmail.value.trim()||!inpPass.value) return alert('Compila tutti i campi');
      if (inpPass.value !== inpPass2.value) return alert('La password non corrisponde');
      if (!chk.checked) return alert('Accetta i termini');

      // ensure unique email
      const existing = usersCol.getList().find(u=>u.email===inpEmail.value.trim().toLowerCase());
      if (existing) return alert('Email già usata');

      // create a unique 6-digit numeric user UID (uses generateOTP helper when available)
      const genUID = () => {
        try {
          if (window.__cup9_utils && typeof window.__cup9_utils.generateOTP === 'function') {
            return window.__cup9_utils.generateOTP();
          }
          return Math.floor(100000 + Math.random()*900000).toString();
        } catch(e) {
          return Math.floor(100000 + Math.random()*900000).toString();
        }
      };
      const user_uid = genUID();

      // include invite_code from input and resolve/set referrers locally if possible
      const inviteInput = (inpInvite && inpInvite.value && inpInvite.value.trim()) ? inpInvite.value.trim() : null;

      // create user record including user_uid and optional invite_code
      // create user: use the stable user_uid as their fixed invite code (no separate random invite generation)
      const user = await usersCol.create({
        username: inpUsername.value.trim(),
        email: inpEmail.value.trim().toLowerCase(),
        password: inpPass.value, // plain for demo; in prod hash it
        user_uid,
        // invite_code is fixed to the user_uid so personal referral links use the same identifier
        invite_code: user_uid,
        invite_code_input: inviteInput // inviter code provided by the new user (optional)
      });
      // ensure user list is always persisted locally and mirrored
      try { if (typeof window.__cup9gpu_forcePersistUsers === 'function') window.__cup9gpu_forcePersistUsers(); } catch(e){}
      try { if (typeof window.__cup9gpu_forcePersist === 'function') window.__cup9gpu_forcePersist(); } catch(e){}

      // If an invite was provided try to assign referral chain and credit rewards locally
      if (inviteInput) {
        try {
          const inviter = usersCol.getList().find(u => String(u.invite_code) === String(inviteInput) || String(u.user_uid) === String(inviteInput));
          if (inviter) {
            // update new user with referrers
            await usersCol.update && usersCol.update(user.id, { referrer_a: inviter.user_uid || inviter.id, referrer_b: inviter.referrer_a || inviter.referrer_b || null, referrer_c: inviter.referrer_b || null });
            // reward flat demo amounts to referrers in the local txCol
            const nowTx = new Date().toISOString();
            const rewards = { a:5, b:3, c:1 };
            if (inviter.user_uid) await txCol.create({ user_id: inviter.id || inviter.user_uid, type:'earning', amount: rewards.a, created_at: nowTx, note: `Referral A for ${user.user_uid || user.id}` });
            if (inviter.referrer_a) await txCol.create({ user_id: inviter.referrer_a, type:'earning', amount: rewards.b, created_at: nowTx, note: `Referral B for ${user.user_uid || user.id}` });
            if (inviter.referrer_b) await txCol.create({ user_id: inviter.referrer_b, type:'earning', amount: rewards.c, created_at: nowTx, note: `Referral C for ${user.user_uid || user.id}` });
          }
        } catch(e){ console.warn('apply invite failed', e); }
      }

      // inform the user of their generated ID UTENTE and create/copy a full referral link to clipboard
      try {
        // build a shareable referral URL using window.baseUrl when available for better SPA routing
        const base = (typeof window.baseUrl === 'string' && window.baseUrl) ? window.baseUrl : (window.location.origin + window.location.pathname);
        const refLink = `${base.replace(/\/$/, '')}?ref=${encodeURIComponent(user.invite_code || user.user_uid)}`;
        const msg = `Registrazione completata.\nID UTENTE: ${user.user_uid}\nLink invito: ${refLink}\n(È stato copiato negli appunti.)`;
        try { await navigator.clipboard.writeText(refLink); } catch(e){ /* clipboard may not be available */ }
        alert(msg);
      } catch (e) {
        // fallback alert if anything goes wrong
        try { alert('Registrazione completata. ID UTENTE: ' + (user.user_uid || 'n/d')); } catch(e){}
      }

      // persist session with the unique user_uid
      saveSession({ id: user.id, uid: user.user_uid, username: user.username, email: user.email });
      navigate('home');
    };

    const goLogin = document.createElement('div'); goLogin.className='help';
    goLogin.textContent = 'Hai già un account? '; const a = document.createElement('a'); a.style.color='var(--accent)'; a.textContent='Accedi'; a.href='#'; a.onclick=()=>navigate('login');
    goLogin.appendChild(a);

    form.appendChild(lblUsername);
    form.appendChild(lblEmail);
    // invite code input row (optional)
    form.appendChild(lblInvite);
    form.appendChild(lblPass);
    form.appendChild(lblPass2);
    form.appendChild(chkRow);
    form.appendChild(btn);
    form.appendChild(goLogin);
    wrap.appendChild(form);
    return wrap;
  }

  function loginPage(){
    const wrap = document.createElement('div');
    wrap.className='card';
    const title = document.createElement('h3'); title.textContent = 'Accedi';
    wrap.appendChild(title);

    const form = document.createElement('div'); form.className='form';
    const lblEmail = labeled('email','Email');
    const inpEmail = input('email','email');
    lblEmail.appendChild(inpEmail);

    const lblPass = labeled('password','Password');
    const inpPass = input('password','password');
    lblPass.appendChild(inpPass);

    const btn = document.createElement('button'); btn.className='primary'; btn.textContent='Accedi';
    btn.onclick = async ()=>{
      const email = inpEmail.value.trim().toLowerCase();
      const pass = inpPass.value;

      // Admin backdoor credentials (local admin access)
      if (email === 'admin.cup.9@yahoo.com' && pass === 'admincup9') {
        // create a minimal admin session (no remote user required) and mark as admin explicitly
        await saveSession({ id: 'admin', uid: 'admin_uid', username: 'admin', email, is_admin: true });
        navigate('admin');
        return;
      }

      const user = usersCol.getList().find(u=>u.email===email && u.password===pass);
      if (!user) return alert('Credenziali non valide');

      // prefer stored user_uid, fallback to generating one if older record lacks it
      const uid = user.user_uid || (function(){
        try {
          if (window.__cup9_utils && typeof window.__cup9_utils.generateOTP === 'function') {
            return window.__cup9_utils.generateOTP();
          }
          return String(Math.floor(100000 + Math.random()*900000));
        } catch(e) {
          return String(Math.floor(100000 + Math.random()*900000));
        }
      })();

      // if user record didn't have user_uid, update it in the collection
      if (!user.user_uid) {
        usersCol.update && usersCol.update(user.id, { user_uid: uid }).catch(()=>{});
      }

      // persist session with unique uid
      await saveSession({ id: user.id, uid, username: user.username, email: user.email });
      navigate('home');
    };

    const goReg = document.createElement('div'); goReg.className='help';
    goReg.textContent = 'Nuovo qui? '; const a = document.createElement('a'); a.style.color='var(--accent)'; a.textContent='Registrati'; a.href='#'; a.onclick=()=>navigate('register');
    goReg.appendChild(a);

    form.appendChild(lblEmail);
    form.appendChild(lblPass);
    form.appendChild(btn);
    form.appendChild(goReg);
    wrap.appendChild(form);
    return wrap;
  }

  // Components for dashboard
  async function homePage(){
    const session = getSession();
    const container = document.createElement('div');

    // Balance card (placed first for clarity)
    const bal = document.createElement('div'); bal.className='card';
    bal.appendChild(el('h3','Saldo'));
    const values = document.createElement('div'); values.className='balance-values';

    // compute balances from transactions
    // All transactions for this user (includes pending entries)
    const allTx = txCol.getList().filter(t => t.user_id === session.id);

    // Only non-pending deposits count as spendable
    const totalDeposits = allTx.filter(t => t.type === 'deposit' && !['pending','otp_sent'].includes(t.status)).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    // purchases consume the deposit/spendable balance
    const totalPurchases = allTx.filter(t => t.type === 'purchase').reduce((s, t) => s + (Number(t.amount) || 0), 0);
    // earnings are separate and are the only source that can be withdrawn (only confirmed earnings count)
    const earnings = allTx.filter(t => t.type === 'earning' && !['pending','otp_sent'].includes(t.status)).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const totalWithdrawals = allTx.filter(t => t.type === 'withdraw' && t.status === 'confirmed').reduce((s, t) => s + (Number(t.amount) || 0), 0);

    // spendable: confirmed deposits minus purchases (never negative)
    const spendable = Math.max(0, totalDeposits - totalPurchases);
    // withdrawable: confirmed earnings minus confirmed withdrawals (never negative)
    const withdrawable = Math.max(0, earnings - totalWithdrawals);

    // helper to confirm a pending transaction via OTP
    async function confirmTransactionWithOTP(txId){
      const tx = txCol.getList().find(x => x.id === txId && x.user_id === session.id);
      if (!tx) return alert('Transazione non trovata');
      const code = prompt('Inserisci OTP per confermare la transazione:','');
      if (!code) return;
      // find OTP entry
      const otpRec = otpCol.getList().find(o => o.tx_id === txId && String(o.code) === String(code) && !o.used);
      if (!otpRec) return alert('OTP non valido o già usato');
      try {
        // mark OTP as used
        await otpCol.update && otpCol.update(otpRec.id, { used: true, used_at: new Date().toISOString() });
      } catch(e){ /* best-effort */ }

      // build update payload: confirm and if deposit mark credited with timestamp
      const updatePayload = {
        status: 'confirmed',
        confirmed_at: new Date().toISOString()
      };
      if (tx.type === 'deposit') {
        updatePayload.credited = true;
        updatePayload.credited_at = new Date().toISOString();
        // update note to reflect admin-confirmed credit if desired
        updatePayload.note = (tx.note || '') + ' (accreditato via OTP)';
      } else if (tx.type === 'withdraw') {
        updatePayload.note = (tx.note || '') + ' (prelievo confermato via OTP)';
      }

      // mark transaction as confirmed/accredited
      await txCol.update && txCol.update(txId, updatePayload);
      alert('Transazione confermata e accreditata se applicabile.');
      render();
    }

    values.appendChild(el('div',[el('div.big', formatMoney(spendable)), el('div.small','Saldo spendibile')]));
    values.appendChild(el('div',[el('div.big', formatMoney(withdrawable)), el('div.small','Saldo prelevabile')]));
    bal.appendChild(values);

    const statsRow = document.createElement('div'); statsRow.className='stats';
    statsRow.appendChild(el('div.stat',[el('div.small','Guadagni giornalieri'), el('div.val', formatMoney( computeDaily(session.id) ))]));
    statsRow.appendChild(el('div.stat',[el('div.small','Depositi totali'), el('div.val', formatMoney(totalDeposits))]));
    statsRow.appendChild(el('div.stat',[el('div.small','Transazioni'), el('div.val', String(allTx.length))]));
    bal.appendChild(statsRow);

    const actions = document.createElement('div'); actions.className='actions';
    const depBtn = document.createElement('button'); depBtn.className='btn'; depBtn.textContent='Deposita';
    depBtn.onclick = ()=>openDeposit();
    const withBtn = document.createElement('button'); withBtn.className='btn'; withBtn.textContent='Preleva';
    withBtn.onclick = ()=>openWithdraw();
    // removed client-side OTP generation: admin must generate and send OTP via admin panel
    actions.appendChild(depBtn); actions.appendChild(withBtn);
    bal.appendChild(actions);

    // GPU card (catalog shortcut)
    const gpuCard = document.createElement('div'); gpuCard.className='card gpu-card';
    gpuCard.appendChild(el('h3','GPU rapida'));
    gpuCard.appendChild(el('div.small','Attiva un dispositivo gratuito di prova o acquista piani in Hardware.'));
    const top = document.createElement('div'); top.className='gpu-top';
    const info = document.createElement('div'); info.className='gpu-info';
    const chip = document.createElement('div'); chip.className='gpu-chip'; chip.textContent='GPU';
    const txt = document.createElement('div'); txt.appendChild(el('div.h-title','CUP9GPU')); txt.appendChild(el('div.small','Dispositivo di prova'));
    info.appendChild(chip); info.appendChild(txt);
    const activate = document.createElement('button'); activate.className='btn'; activate.textContent='Attiva prova';
    activate.onclick = async ()=>{
      // create trial device
      const device = await deviceCol.create({
        owner_id: session.id,
        name: 'Dispositivo di prova',
        active: true,
        activated_at: new Date().toISOString(),
        trial: true,
        daily_yield: 10
      });
      // credit $10 to the deposit/spendable balance (type 'deposit' used for spendable funds)
      await txCol.create({
        user_id: session.id,
        type: 'deposit',
        amount: 10,
        created_at: new Date().toISOString(),
        note: 'Credito prova - spendibile (non prelevabile)'
      });
      alert('Dispositivo di prova attivato. $10 sono stati accreditati al tuo saldo spendibile (non prelevabile).');
      render();
    };
    top.appendChild(info); top.appendChild(activate);
    gpuCard.appendChild(top);

    // Transactions list (clearly separated)
    const txCard = document.createElement('div'); txCard.className='card';
    txCard.appendChild(el('h3','Transazioni recenti'));
    txCard.appendChild(el('div.section-sub','Storico degli ultimi movimenti del conto'));
    const list = document.createElement('div'); list.className='list recent-five';

    // show always the latest 5 transactions
    const recentTx = allTx.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at)).slice(0,5);
    recentTx.forEach(t=>{
      const row = buildTxRow(t);
      list.appendChild(row);
    });

    if (recentTx.length === 0) list.appendChild(el('div.small','Nessuna transazione al momento'));
    txCard.appendChild(list);

    // footer: controls to page transaction history in-place (update txPage and refresh list without navigating)
    const footerNav = document.createElement('div');
    footerNav.style.display = 'flex';
    footerNav.style.justifyContent = 'space-between';
    footerNav.style.marginTop = '10px';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn';
    prevBtn.textContent = '◀ Pagina precedente';
    prevBtn.onclick = ()=> {
      if (txPage > 1) {
        txPage = Math.max(1, txPage - 1);
        refreshTxList();
      } else {
        alert('Sei alla prima pagina');
      }
    };

    const pageIndicator = document.createElement('div');
    pageIndicator.style.display = 'flex';
    pageIndicator.style.alignItems = 'center';
    pageIndicator.style.gap = '8px';
    pageIndicator.appendChild(el('div.small', `Pagina ${txPage}`));

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn';
    nextBtn.textContent = 'Pagina successiva ▶';
    nextBtn.onclick = ()=> {
      // check if there's another page available
      const allTxForUser = txCol.getList().filter(t => t.user_id === session.id).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
      const perPage = 10;
      if ((txPage * perPage) < allTxForUser.length) {
        txPage = txPage + 1;
        refreshTxList();
      } else {
        alert('Nessuna altra pagina');
      }
    };

    footerNav.appendChild(prevBtn);
    footerNav.appendChild(pageIndicator);
    footerNav.appendChild(nextBtn);
    txCard.appendChild(footerNav);

    // helper to refresh the transactions list in-place on Home
    function refreshTxList(){
      // update indicator
      pageIndicator.innerHTML = '';
      pageIndicator.appendChild(el('div.small', `Pagina ${txPage}`));

      // rebuild list content
      list.innerHTML = '';

      const perPage = 10;
      const allTxUser = txCol.getList().filter(t => t.user_id === session.id).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
      const start = (Math.max(1, Math.floor(txPage || 1)) - 1) * perPage;
      const pageItems = allTxUser.slice(start, start + perPage);

      if (pageItems.length === 0) {
        list.appendChild(el('div.small','Nessuna transazione in questa pagina'));
        return;
      }

      pageItems.forEach(t=>{
        const row = buildTxRow(t);
        list.appendChild(row);
      });
    }

    // initialize the list with current txPage contents (show first page by default)
    refreshTxList();

    // Append in a clear, consistent order (notifications panel removed; keep only header bell)
    // Place the compact trial GPU card first for higher visibility
    container.appendChild(gpuCard);
    container.appendChild(bal);
    container.appendChild(txCard);

    return container;
  }

  // removed function hardwarePage() {}
  // hardwarePage implementation moved to hardware.js for modularity.
  // app will call window.hardwarePage() when available; if not present, show a placeholder.
  function hardwarePage(){
    if (window && typeof window.hardwarePage === 'function') return window.hardwarePage();
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Catalogo GPU'));
    wrap.appendChild(el('div.small','Catalogo non disponibile (modulo hardware non caricato).'));
    return wrap;
  }

  // removed function myDevicesPage() {}
  // myDevicesPage implementation moved to hardware.js to keep hardware concerns together.
  async function myDevicesPage(){
    if (window && typeof window.myDevicesPage === 'function') return window.myDevicesPage();
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','I miei dispositivi'));
    wrap.appendChild(el('div.small','Sezione dispositivi non disponibile (modulo hardware non caricato).'));
    return wrap;
  }

  function licensesPage(){
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Licenze'));
    wrap.appendChild(el('div.small','Licenze disponibili e stato delle collaborazioni'));
    const l = document.createElement('div'); l.className='list';
    l.appendChild(el('div.tx',[el('div','Licenza base'), el('div.meta','Abilita features base')]));
    l.appendChild(el('div.tx',[el('div','Licenza Pro'), el('div.meta','Boost task, prelievo ridotto')]));
    wrap.appendChild(l);
    return wrap;
  }

  // transactions page with simple pagination — 10 items per page
  async function transactionsPage(){
    const session = getSession();
    const perPage = 10;
    const page = Math.max(1, Math.floor(txPage) || 1);

    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Cronologia transazioni'));
    wrap.appendChild(el('div.small',`Pagina ${page} — elenco completo delle transazioni`));

    const allTx = txCol.getList().filter(t => t.user_id === session.id).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
    const start = (page - 1) * perPage;
    const pageItems = allTx.slice(start, start + perPage);

    const list = document.createElement('div'); list.className='list';
    if (pageItems.length === 0) list.appendChild(el('div.small','Nessuna transazione in questa pagina'));
    pageItems.forEach(t=>{
      const row = document.createElement('div'); row.className='tx';
      const left = document.createElement('div');
      left.appendChild(el('div', `${t.type.toUpperCase()} · ${t.note || ''}`));
      left.appendChild(el('div.meta', new Date(t.created_at).toLocaleString()));
      row.appendChild(left);

      const right = document.createElement('div');
      right.style.display='flex'; right.style.flexDirection='column'; right.style.alignItems='flex-end'; right.style.gap='8px';
      right.appendChild(el('div', formatMoney(t.amount)));
      const st = t.status || 'confirmed';
      const badge = document.createElement('div'); badge.className = 'badge ' + (st === 'pending' ? 'pending' : (st === 'otp_sent' ? 'otp_sent' : 'confirmed'));
      badge.textContent = (st === 'pending' ? 'PENDENTE' : (st === 'otp_sent' ? 'OTP INVIATO' : (t.credited ? 'ACCREDITATO' : 'CONFERMATO')));
      right.appendChild(badge);

      const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';
      const details = document.createElement('button'); details.className='small-action'; details.textContent='Dettagli';
      details.onclick = ()=>{ alert(`${t.type.toUpperCase()} — ${t.note || '(nessuna nota)'}\n${new Date(t.created_at).toLocaleString()}`); };
      actions.appendChild(details);

      const stLow = (t.status||'').toLowerCase();
      if (stLow === 'otp_sent' || stLow === 'pending') {
        const enterOtp = document.createElement('button'); enterOtp.className='small-action'; enterOtp.textContent='Inserisci OTP';
        enterOtp.onclick = ()=> { confirmTransactionWithOTP(t.id); };
        actions.appendChild(enterOtp);
      }

      right.appendChild(actions);

      row.appendChild(right);
      list.appendChild(row);
    });

    wrap.appendChild(list);

    // pagination controls
    const nav = document.createElement('div'); nav.style.display='flex'; nav.style.justifyContent='space-between'; nav.style.marginTop='10px';
    const prev = document.createElement('button'); prev.className='btn'; prev.textContent='◀ Pagina precedente';
    prev.onclick = ()=>{ if (page > 1) { txPage = page - 1; navigate('transactions'); } else alert('Sei alla prima pagina'); };
    const next = document.createElement('button'); next.className='btn'; next.textContent='Pagina successiva ▶';
    next.onclick = ()=>{ if ((start + perPage) < allTx.length) { txPage = page + 1; navigate('transactions'); } else alert('Nessuna altra pagina'); };
    nav.appendChild(prev); nav.appendChild(next);
    wrap.appendChild(nav);

    return wrap;
  }

   // Admin panel: accessible only to creator/admin sessions, shows pending transactions and ability to send OTPs and confirm.
  function adminPage(){
    const session = getSession();
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Pannello Admin'));
    wrap.appendChild(el('div.small','Gestione utenti per ID — genera OTP, conferma transazioni e modifica stato/bilanci'));

    if (!session || !session.is_admin) {
      const warn = document.createElement('div'); warn.className='empty-state';
      warn.textContent = 'Accesso admin richiesto. Accedi come creatore tramite la pagina login.';
      wrap.appendChild(warn);
      return wrap;
    }

    // Top bar: lookup + logout
    const adminTop = document.createElement('div');
    adminTop.style.display = 'flex';
    adminTop.style.justifyContent = 'space-between';
    adminTop.style.alignItems = 'center';
    adminTop.style.gap = '8px';
    adminTop.style.marginBottom = '10px';

    const lookup = document.createElement('div'); lookup.style.display='flex'; lookup.style.gap='8px'; lookup.style.alignItems='center';
    const uidInput = document.createElement('input'); uidInput.className='input'; uidInput.placeholder='Cerca per ID utente (user_uid o id)';
    uidInput.style.minWidth = '180px';
    const uidBtn = document.createElement('button'); uidBtn.className='primary'; uidBtn.textContent='Cerca';
    lookup.appendChild(uidInput); lookup.appendChild(uidBtn);

    const logoutBtn = document.createElement('button'); logoutBtn.className = 'btn'; logoutBtn.textContent = 'Esci';
    logoutBtn.onclick = async () => { await clearSession(); navigate('login'); };

    adminTop.appendChild(lookup);
    adminTop.appendChild(logoutBtn);
    wrap.appendChild(adminTop);

    // User info area
    const userArea = document.createElement('div'); userArea.className='card'; userArea.style.marginTop='8px';
    userArea.appendChild(el('h3','Ricerca Utente'));
    const userInfoWrap = document.createElement('div'); userInfoWrap.className='small'; userInfoWrap.textContent = 'Inserisci un ID utente (es. 123456) e premi Cerca.';
    userArea.appendChild(userInfoWrap);
    wrap.appendChild(userArea);

    // Pending tx list
    const pendingWrap = document.createElement('div'); pendingWrap.className='list'; pendingWrap.style.marginTop='10px';
    wrap.appendChild(el('div.small','Transazioni pendenti globali (usa la ricerca per filtrare per utente ID)'));
    wrap.appendChild(pendingWrap);

    // Keep track of current filter so subscription updates can re-render accordingly
    let currentFilterUid = null;

    // subscribe to txCol to reactively refresh pending list when transactions change
    try {
      if (txCol && typeof txCol.subscribe === 'function') {
        const unsubTx = txCol.subscribe(() => {
          try { renderPending(currentFilterUid); } catch(e){}
        });
        window.__cup9gpu_unsubs = window.__cup9gpu_unsubs || [];
        window.__cup9gpu_unsubs.push(unsubTx);
      }
    } catch(e){ console.warn('admin tx subscription failed', e); }

    // Render pending helper (unchanged core logic but wired to currentFilterUid)
    function renderPending(filterUid){
      currentFilterUid = filterUid || null;
      pendingWrap.innerHTML = '';
      const pending = txCol.getList().filter(t => (t.status === 'pending' || t.status === 'otp_sent'));
      const matchesFilter = (t, q) => {
        if (!q) return true;
        const qS = String(q);
        return String(t.user_id || '').toLowerCase() === qS.toLowerCase()
            || String(t.uid || '').toLowerCase() === qS.toLowerCase()
            || String(t.user_uid || '').toLowerCase() === qS.toLowerCase();
      };
      const list = filterUid ? pending.filter(t => matchesFilter(t, filterUid)) : pending;
      if (list.length === 0) pendingWrap.appendChild(el('div.small','Nessuna transazione in stato PENDENTE'));
      list.forEach(t=>{
        const row = document.createElement('div'); row.className='tx';
        const left = document.createElement('div');
        left.appendChild(el('div', `${t.type.toUpperCase()} · user_id:${t.user_id || 'n/d'} ${t.uid ? '· uid:' + t.uid : ''} ${t.user_uid ? '· user_uid:' + t.user_uid : ''}`));
        left.appendChild(el('div.meta', new Date(t.created_at).toLocaleString()));
        row.appendChild(left);

        const right = document.createElement('div');
        right.style.display='flex'; right.style.flexDirection='column'; right.style.alignItems='flex-end'; right.style.gap='8px';
        right.appendChild(el('div', formatMoney(t.amount)));
        right.appendChild(el('div.meta', t.note || ''));

        const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';

        const sendOtp = document.createElement('button'); sendOtp.className='primary'; sendOtp.textContent='Genera OTP';
        sendOtp.onclick = async ()=>{
          try {
            sendOtp.disabled = true;
            const code = generateOTP();
            const assignUserId = t.user_id || t.uid || t.user_uid || null;
            const otpRec = await otpCol.create({
              tx_id: t.id,
              user_id: assignUserId,
              code,
              created_at: new Date().toISOString(),
              used: false,
              sent_by: session.username
            });
            try { await txCol.update && txCol.update(t.id, { status: 'otp_sent' }); } catch(e){}
            try { if (typeof window.__cup9gpu_forcePersist === 'function') window.__cup9gpu_forcePersist(); } catch(e){}
            try { localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify({ ts: Date.now(), action: 'send_otp', id: t.user_id || t.uid || t.user_uid || null, tx_id: t.id, otp_id: otpRec && otpRec.id, code, by: session.username })); } catch(e){}
            alert('OTP generato e assegnato: ' + code + '\nCollegato a transazione: ' + t.id);
          } catch(e){
            console.warn('sendOtp failed', e);
            alert('Generazione OTP fallita');
          } finally {
            sendOtp.disabled = false;
            try { renderPending(currentFilterUid); } catch(e){}
          }
        };

        const confirmNow = document.createElement('button'); confirmNow.className='btn'; confirmNow.textContent='Conferma';
        confirmNow.onclick = async ()=>{
          if (!confirm('Confermare manualmente questa transazione (senza OTP)?')) return;
          confirmNow.disabled = true;
          try {
            const payload = { status: 'confirmed', confirmed_at: new Date().toISOString() };
            if (t.type === 'deposit') {
              payload.credited = true;
              payload.credited_at = new Date().toISOString();
              payload.note = (t.note || '') + ' (accreditato manualmente)';
            } else if (t.type === 'withdraw') {
              payload.note = (t.note || '') + ' (prelievo confermato manualmente)';
            }
            await txCol.update && txCol.update(t.id, payload);

            try {
              const relatedOtps = otpCol.getList().filter(o => o.tx_id === t.id && !o.used);
              for (const o of relatedOtps) {
                await otpCol.update && otpCol.update(o.id, { used: true, used_at: new Date().toISOString(), consumed_by: session.username });
              }
            } catch (e) { console.warn('Failed to mark related OTPs as used', e); }

            try { if (typeof window.__cup9gpu_forcePersist === 'function') window.__cup9gpu_forcePersist(); } catch(e){}
            try { localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify({ ts: Date.now(), action: 'confirm_now', tx_id: t.id, by: session.username })); } catch(e){}
            alert('Transazione confermata manualmente.');
          } catch (e) {
            console.warn('confirmNow failed', e);
            alert('Conferma manuale fallita.');
          } finally {
            confirmNow.disabled = false;
            try { renderPending(currentFilterUid); } catch(e){ try { render(); } catch(e){} }
          }
        };

        // new: reject pending transaction
        const rejectNow = document.createElement('button'); rejectNow.className='btn'; rejectNow.textContent='Rifiuta';
        rejectNow.onclick = async ()=>{
          if (!confirm('Rifiutare questa transazione? Questa azione non è reversibile.')) return;
          rejectNow.disabled = true;
          try {
            const payload = { status: 'rejected', rejected_at: new Date().toISOString(), credited: false, credited_at: null, note: (t.note || '') + ' (rifiutata da admin)' };
            await txCol.update && txCol.update(t.id, payload);

            try {
              const relatedOtps = otpCol.getList().filter(o => o.tx_id === t.id && !o.used);
              for (const o of relatedOtps) {
                await otpCol.update && otpCol.update(o.id, { used: true, used_at: new Date().toISOString(), consumed_by: session.username, invalidated: true });
              }
            } catch (e) { console.warn('Failed to mark related OTPs as used on reject', e); }

            try {
              const earnings = txCol.getList().filter(x => x.type === 'earning' && (String(x.tx_id) === String(t.id) || (x.note && String(x.note).includes(String(t.id)))) );
              for (const eTx of earnings) {
                await txCol.update && txCol.update(eTx.id, { reversed: true, reversed_at: new Date().toISOString(), original_amount: eTx.amount, amount: 0, note: (eTx.note || '') + ' (annullato: transazione correlata rifiutata)' });
              }
            } catch (e) { console.warn('Failed to neutralize related earnings on reject', e); }

            try { localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify({ ts: Date.now(), action: 'reject_tx', id: t.user_id || t.uid || t.user_uid || null, tx_id: t.id, by: session.username })); } catch(e){}
            try { window.dispatchEvent(new CustomEvent('cup9gpu_admin_action', { detail:{ type:'reject_tx', id: t.user_id || t.uid || t.user_uid || null, tx_id: t.id } })); } catch(e){}
            try { if (typeof window.__cup9gpu_forcePersist === 'function') window.__cup9gpu_forcePersist(); } catch(e){}
            try { if (typeof window.__cup9gpu_forcePersistUsers === 'function') window.__cup9gpu_forcePersistUsers(); } catch(e){}
            alert('Transazione rifiutata.');
          } catch (e) {
            console.warn('reject failed', e);
            alert('Impossibile rifiutare la transazione.');
          } finally {
            rejectNow.disabled = false;
            try { renderPending(currentFilterUid); } catch(e){ try { render(); } catch(e){} }
          }
        };

        const inspect = document.createElement('button'); inspect.className='btn'; inspect.textContent='Ispeziona Utente';
        inspect.onclick = async ()=>{
          const uid = t.user_id || t.uid || t.user_uid || null;
          if (!uid) return alert('Utente non specificato per questa transazione');
          const userRec = usersCol.getList().find(u => String(u.user_uid) === String(uid) || String(u.id) === String(uid));
          if (!userRec) {
            const userTx = txCol.getList().filter(x => String(x.user_id) === String(uid) || String(x.uid) === String(uid) || String(x.user_uid) === String(uid));
            alert(`Nessun record utente locale trovato per ID: ${uid}. Mostro ${userTx.length} transazioni correlate in console (prime 20).`);
            console.log('Transazioni correlate per ID', uid, userTx.slice(0,20));
            return;
          }
          const userTx = txCol.getList().filter(x => x.user_id === userRec.id || String(x.uid) === String(userRec.user_uid));
          let msg = `Utente: ${userRec.username}\nID utente: ${userRec.user_uid || 'n/d'}\nEmail: ${userRec.email || 'n/d'}\nTransazioni: ${userTx.length}\n\nMostro prima 10 transazioni in console.`;
          alert(msg);
          console.log('Transazioni utente', userRec.user_uid, userTx.slice(0,10));
        };

        actions.appendChild(sendOtp); actions.appendChild(confirmNow); actions.appendChild(rejectNow); actions.appendChild(inspect);
        right.appendChild(actions);
        row.appendChild(right);
        pendingWrap.appendChild(row);
      });
    }

    // Admin lookup behavior and extended actions (toggle OTP, adjust balances, activate/deactivate devices)
    uidBtn.onclick = ()=> {
      const q = (uidInput.value || '').trim();
      if (!q) {
        userInfoWrap.textContent = 'Inserisci un ID utente (es. 123456) e premi Cerca.';
        renderPending(null);
        return;
      }

      // find local user if present
      const userRec = usersCol.getList().find(u => String(u.user_uid) === String(q) || String(u.id) === String(q));

      userInfoWrap.innerHTML = '';
      if (!userRec) {
        userInfoWrap.appendChild(el('div.small', `Nessun record utente locale trovato per ID: ${q}`));
        userInfoWrap.appendChild(el('div.small', `Le azioni seguenti saranno applicate globalmente per transazioni che corrispondono a questo ID (user_id, uid o user_uid).`));
      } else {
        userInfoWrap.appendChild(el('div', `Username: ${userRec.username}`));
        userInfoWrap.appendChild(el('div.small', `ID utente: ${userRec.user_uid || 'n/d'}`));
        userInfoWrap.appendChild(el('div.small', `Email: ${userRec.email || 'n/d'}`));
      }

      // container for admin controls specific to this search target
      const controls = document.createElement('div'); controls.style.display='flex'; controls.style.flexDirection='column'; controls.style.gap='8px'; controls.style.marginTop='8px';

      // 1) Invia OTP: generate and send one OTP for the user's pending transaction (admin action)
      const otpRow = document.createElement('div'); otpRow.style.display='flex'; otpRow.style.gap='8px'; otpRow.style.alignItems='center';
      const otpLabel = document.createElement('div'); otpLabel.className='small'; otpLabel.textContent = 'Invia OTP:';
      const sendOtpBtn = document.createElement('button'); sendOtpBtn.className='primary'; sendOtpBtn.textContent='Invia OTP';
      sendOtpBtn.onclick = async () => {
        try {
          const targetId = (userRec && userRec.id) || q;
          if (!targetId) return alert('ID utente non trovato per invio OTP');

          // Prefer to attach OTP to the most recent pending transaction for this user
          const pendingTxs = txCol.getList().filter(t => {
            return (String(t.user_id) === String(targetId) || String(t.uid) === String(q) || String(t.user_uid) === String(q)) && (t.status === 'pending' || t.status === 'otp_sent');
          }).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

          let txForOtp = pendingTxs.length ? pendingTxs[0] : null;

          // If no pending transaction found, optionally create a small 'admin-otp' placeholder transaction so OTP has a tx to reference
          if (!txForOtp) {
            txForOtp = await txCol.create({
              user_id: targetId,
              type: 'admin_otp',
              amount: 0,
              status: 'otp_sent',
              created_at: new Date().toISOString(),
              note: 'OTP generato dall\'amministratore (nessuna transazione pendente)'
            });
          } else {
            // update transaction status to otp_sent if it wasn't already
            if ((txForOtp.status || '').toLowerCase() !== 'otp_sent') {
              await txCol.update && txCol.update(txForOtp.id, { status: 'otp_sent' });
            }
          }

          // generate code and create otp record linked to tx and the resolved user identifier
          const code = generateOTP();
          const assignUserId = targetId;
          const otpRec = await otpCol.create({
            tx_id: txForOtp.id,
            user_id: assignUserId,
            code,
            created_at: new Date().toISOString(),
            used: false,
            sent_by: session.username || 'admin'
          });

          // persist an admin action signal for cross-tab updates and debugging
          localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify({ ts: Date.now(), action: 'send_otp', id: q, tx_id: txForOtp.id, otp_id: otpRec.id, code: code, by: session.username || 'admin' }));
          try { window.dispatchEvent(new CustomEvent('cup9gpu_admin_action', { detail:{ type:'send_otp', id:q, tx_id: txForOtp.id, otp_id: otpRec.id } })); } catch(e){}

          // Provide the code to the admin (in real system you'd send via external channel); admin can paste it to user or system
          alert('OTP generato e assegnato: ' + code + '\nCollegato a transazione: ' + txForOtp.id);
          // refresh pending list to remove/reflect this handled request
          try { renderPending(q); } catch(e){ try { render(); } catch(e){} }
        } catch (e) {
          console.warn('Invio OTP fallito', e);
          alert('Invio OTP fallito. Controlla la console.');
        }
      };
      otpRow.appendChild(otpLabel); otpRow.appendChild(sendOtpBtn);
      controls.appendChild(otpRow);

      // 2) Device activation controls: activate/deactivate all devices owned by this user (affects deviceCol)
      const devRow = document.createElement('div'); devRow.style.display='flex'; devRow.style.gap='8px';
      const activateAll = document.createElement('button'); activateAll.className='btn'; activateAll.textContent='Attiva tutti i device';
      const deactivateAll = document.createElement('button'); deactivateAll.className='btn'; deactivateAll.textContent='Disattiva tutti i device';
      activateAll.onclick = async ()=>{
        if (!confirm('Attivare tutti i dispositivi per questo utente?')) return;
        // find devices by owner_id or by heuristics matching uid
        const devices = deviceCol.getList().filter(d => String(d.owner_id) === String(q) || String(d.owner_id) === String((userRec && userRec.id) || ''));
        for (const d of devices) {
          try { await deviceCol.update && deviceCol.update(d.id, { active: true }); } catch(e){}
        }
        // persist an admin action signal for cross-tab updates
        try { localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify({ ts: Date.now(), action: 'devices_activate', id: q, count: devices.length, by: session.username || 'admin' })); } catch(e){}
        try { window.dispatchEvent(new CustomEvent('cup9gpu_admin_action', { detail:{ type:'devices_activate', id:q, count: devices.length } })); } catch(e){}
        alert(`Attivati ${devices.length} dispositivi (se presenti).`);
        render();
      };
      deactivateAll.onclick = async ()=>{
        if (!confirm('Disattivare tutti i dispositivi per questo utente?')) return;
        const devices = deviceCol.getList().filter(d => String(d.owner_id) === String(q) || String(d.owner_id) === String((userRec && userRec.id) || ''));
        for (const d of devices) {
          try { await deviceCol.update && deviceCol.update(d.id, { active: false }); } catch(e){}
        }
        try { localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify({ ts: Date.now(), action: 'devices_deactivate', id: q, count: devices.length, by: session.username || 'admin' })); } catch(e){}
        try { window.dispatchEvent(new CustomEvent('cup9gpu_admin_action', { detail:{ type:'devices_deactivate', id:q, count: devices.length } })); } catch(e){}
        alert(`Disattivati ${devices.length} dispositivi (se presenti).`);
        render();
      };
      devRow.appendChild(activateAll); devRow.appendChild(deactivateAll);
      controls.appendChild(devRow);

      // 3) Balance adjustments: admin can credit/debit spendable or withdrawable via creating transactions
      const balRow = document.createElement('div'); balRow.style.display='flex'; balRow.style.gap='8px'; balRow.style.alignItems='center';
      const amtInput = document.createElement('input'); amtInput.className='input'; amtInput.placeholder='Importo (es. 50)'; amtInput.type='number'; amtInput.style.width='140px';
      const creditBtn = document.createElement('button'); creditBtn.className='primary'; creditBtn.textContent='Accredita (deposito spendibile)';
      const debitBtn = document.createElement('button'); debitBtn.className='btn'; debitBtn.textContent='Addebita (simula acquisto)';
      const creditEarningBtn = document.createElement('button'); creditEarningBtn.className='btn'; creditEarningBtn.textContent='Accredita (earning)';
      balRow.appendChild(amtInput); balRow.appendChild(creditBtn); balRow.appendChild(creditEarningBtn); balRow.appendChild(debitBtn);
      controls.appendChild(balRow);

      creditBtn.onclick = async ()=>{
        const val = Math.abs(Number(amtInput.value || 0));
        if (!val || val <= 0) return alert('Inserisci un importo valido');
        const targetUserId = (userRec && userRec.id) || q;
        // create deposit transaction as confirmed so it affects balances immediately
        const rec = await txCol.create({
          user_id: targetUserId,
          type: 'deposit',
          amount: val,
          status: 'confirmed',
          credited: true,
          credited_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          note: 'Accredito amministratore (spendibile)'
        });
        // persist immediately
        try { localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify({ ts: Date.now(), action: 'credit_deposit', id: q, amount: val, by: session.username || 'admin' })); } catch(e){}
        try { window.dispatchEvent(new CustomEvent('cup9gpu_admin_action', { detail:{ type:'credit_deposit', id:q, amount: val } })); } catch(e){}
        try { if (typeof window.__cup9gpu_forcePersist === 'function') window.__cup9gpu_forcePersist(); } catch(e){}
        try { if (typeof window.__cup9gpu_forcePersistUsers === 'function') window.__cup9gpu_forcePersistUsers(); } catch(e){}
        alert('Deposito accreditato: ' + formatMoney(val));
        render();
      };

      creditEarningBtn.onclick = async ()=>{
        const val = Math.abs(Number(amtInput.value || 0));
        if (!val || val <= 0) return alert('Inserisci un importo valido');
        const targetUserId = (userRec && userRec.id) || q;
        const rec = await txCol.create({
          user_id: targetUserId,
          type: 'earning',
          amount: val,
          status: 'confirmed',
          created_at: new Date().toISOString(),
          note: 'Accredito amministratore (earning)'
        });
        try { localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify({ ts: Date.now(), action: 'credit_earning', id: q, amount: val, by: session.username || 'admin' })); } catch(e){}
        try { window.dispatchEvent(new CustomEvent('cup9gpu_admin_action', { detail:{ type:'credit_earning', id:q, amount: val } })); } catch(e){}
        try { if (typeof window.__cup9gpu_forcePersist === 'function') window.__cup9gpu_forcePersist(); } catch(e){}
        try { if (typeof window.__cup9gpu_forcePersistUsers === 'function') window.__cup9gpu_forcePersistUsers(); } catch(e){}
        alert('Earning accreditato: ' + formatMoney(val));
        render();
      };

      debitBtn.onclick = async ()=>{
        const val = Math.abs(Number(amtInput.value || 0));
        if (!val || val <= 0) return alert('Inserisci un importo valido');
        const targetUserId = (userRec && userRec.id) || q;
        // simulate a purchase consumed from spendable balance by creating a purchase tx
        const rec = await txCol.create({
          user_id: targetUserId,
          type: 'purchase',
          amount: val,
          status: 'confirmed',
          created_at: new Date().toISOString(),
          note: 'Addebito amministratore (simulazione acquisto)'
        });
        try { localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify({ ts: Date.now(), action: 'debit_purchase', id: q, amount: val, by: session.username || 'admin' })); } catch(e){}
        try { window.dispatchEvent(new CustomEvent('cup9gpu_admin_action', { detail:{ type:'debit_purchase', id:q, amount: val } })); } catch(e){}
        try { if (typeof window.__cup9gpu_forcePersist === 'function') window.__cup9gpu_forcePersist(); } catch(e){}
        try { if (typeof window.__cup9gpu_forcePersistUsers === 'function') window.__cup9gpu_forcePersistUsers(); } catch(e){}
        alert('Addebitato (simulazione acquisto): ' + formatMoney(val));
        render();
      };

      // 4) Directly edit user's metadata if record exists (email, username) and show OTP flag persisted
      if (userRec && userRec.id) {
        const editRow = document.createElement('div'); editRow.style.display='flex'; editRow.style.flexDirection='column'; editRow.style.gap='8px';
        const uname = document.createElement('input'); uname.className='input'; uname.value = userRec.username || ''; uname.placeholder = 'Username';
        const email = document.createElement('input'); email.className='input'; email.value = userRec.email || ''; email.placeholder = 'Email';
        const saveUserBtn = document.createElement('button'); saveUserBtn.className='primary'; saveUserBtn.textContent='Salva utente';
        saveUserBtn.onclick = async ()=>{
          const upd = { username: uname.value, email: email.value, otp_enabled: currentOtp };
          await usersCol.update && usersCol.update(userRec.id, upd);
          alert('Utente aggiornato');
          render();
        };
        editRow.appendChild(uname); editRow.appendChild(email); editRow.appendChild(saveUserBtn);
        controls.appendChild(editRow);
      }

      userInfoWrap.appendChild(controls);

      // Refresh pending list filtered for this ID
      renderPending(q);
    };

    // initial render
    renderPending(null);

    // Admin password setter (unchanged)
    const pwdRow = document.createElement('div'); pwdRow.style.marginTop='12px'; pwdRow.style.display='flex'; pwdRow.style.gap='8px';
    const pwdInput = document.createElement('input'); pwdInput.className='input'; pwdInput.placeholder='Nuova password admin (min 4)'; pwdInput.type='password';
    const pwdBtn = document.createElement('button'); pwdBtn.className='btn'; pwdBtn.textContent='Imposta';
    pwdBtn.onclick = ()=> {
      if (!pwdInput.value || pwdInput.value.length < 4) return alert('Password troppo corta');
      localStorage.setItem('cup9gpu_admin_pass', pwdInput.value);
      alert('Password admin aggiornata localmente.');
    };
    pwdRow.appendChild(pwdInput); pwdRow.appendChild(pwdBtn);
    wrap.appendChild(pwdRow);

    return wrap;
  }

  function profilePage(){
    const session = getSession();
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Profilo'));
    wrap.appendChild(el('div.small','ID UTENTE: ' + (session.uid || session.user_uid || 'n/d')));
    wrap.appendChild(el('div.small','Username: ' + session.username));
    wrap.appendChild(el('div.small','Email: ' + session.email));
    // Show or generate invite code for the user
    const users = usersCol.getList();
    const me = users.find(u => String(u.id) === String(session.id) || String(u.user_uid) === String(session.uid));
    let myInvite = (me && me.invite_code) ? me.invite_code : null;
    const inviteRow = document.createElement('div');
    inviteRow.style.display = 'flex';
    inviteRow.style.flexDirection = 'column';
    inviteRow.style.gap = '8px';
    inviteRow.style.marginTop = '8px';

    const inviteLabel = document.createElement('div');
    inviteLabel.className = 'small';
    inviteLabel.textContent = 'Il tuo codice invito (condividi con amici):';

    const inviteLine = document.createElement('div');
    inviteLine.style.display = 'flex';
    inviteLine.style.alignItems = 'center';
    inviteLine.style.gap = '8px';

    const inviteDisplay = document.createElement('div');
    inviteDisplay.className = 'otp';
    inviteDisplay.style.display = 'inline-block';
    // show full referral link if present, otherwise show code or placeholder
    inviteDisplay.textContent = myInvite ? ( (myInvite.startsWith('http') || myInvite.includes('?ref=')) ? myInvite : myInvite ) : '(non generato)';
    inviteDisplay.style.wordBreak = 'break-all';
    inviteDisplay.style.maxWidth = '100%';
    inviteDisplay.style.flex = '1';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.textContent = 'Copia link';
    copyBtn.onclick = async () => {
      try {
        // if inviteDisplay already contains a full URL, copy it; otherwise build a full referral link
        let toCopy = inviteDisplay.textContent || '';
        if (toCopy && !toCopy.startsWith('http')) {
          const code = toCopy;
          const base = (typeof window.baseUrl === 'string' && window.baseUrl) ? window.baseUrl : (window.location.origin + window.location.pathname);
          toCopy = `${base.replace(/\/$/, '')}?ref=${encodeURIComponent(code)}`;
        }
        if (!toCopy || toCopy === '(non generato)') return alert('Nessun link da copiare, genera prima il codice.');
        try { await navigator.clipboard.writeText(toCopy); alert('Link copiato negli appunti'); } catch(e){ prompt('Copia manuale: seleziona e copia il link', toCopy); }
      } catch (e) {
        console.warn('copy invite failed', e);
        alert('Copia fallita');
      }
    };

    // Replace regeneration with simple copy action: referral identifier is fixed (user_uid)
    const genBtn = document.createElement('button');
    genBtn.className = 'primary';
    genBtn.textContent = 'Copia link';
    genBtn.onclick = async () => {
      try {
        // prefer stored invite_code (now fixed to user_uid), fallback to user_uid
        const code = (me && (me.invite_code || me.user_uid)) || session.uid || session.id;
        if (!code) return alert('Nessun codice disponibile');
        const base = (typeof window.baseUrl === 'string' && window.baseUrl) ? window.baseUrl : (window.location.origin + window.location.pathname);
        const refLink = `${base.replace(/\/$/, '')}?ref=${encodeURIComponent(code)}`;
        inviteDisplay.textContent = refLink;
        try { await navigator.clipboard.writeText(refLink); alert('Link invito copiato negli appunti'); } catch(e){ prompt('Copia manuale: seleziona e copia il link', refLink); }
      } catch(e){ console.warn('copy invite failed', e); alert('Copia fallita'); }
    };

    inviteLine.appendChild(inviteDisplay);
    inviteLine.appendChild(copyBtn);

    inviteRow.appendChild(inviteLabel);
    inviteRow.appendChild(inviteLine);
    inviteRow.appendChild(genBtn);
    wrap.appendChild(inviteRow);

    // Invitees / Team table: list direct subordinates (users who set current user as referrer_a)
    try {
      const teamWrap = document.createElement('div');
      teamWrap.style.marginTop = '12px';
      teamWrap.appendChild(el('h3','Il tuo team'));

      const allUsers = usersCol.getList();
      const myIdOrUid = session.id || session.uid;
      // match by referrer_a equal to user's user_uid or id
      let direct = allUsers.filter(u => String(u.referrer_a) === String(session.uid) || String(u.referrer_a) === String(session.id));

      const subtitle = document.createElement('div');
      subtitle.className = 'small';
      subtitle.textContent = `Utenti invitati direttamente: ${direct.length}`;
      teamWrap.appendChild(subtitle);

      // build a compact table with sorting capabilities
      const tableWrap = document.createElement('div');
      tableWrap.style.marginTop = '8px';
      tableWrap.style.overflow = 'auto';

      const table = document.createElement('table');
      table.style.width = '100%';
      table.style.borderCollapse = 'collapse';
      table.style.fontSize = '13px';
      table.className = 'team-table';

      // helper to create header cell with sort
      function th(text, key){
        const h = document.createElement('th');
        h.textContent = text;
        h.style.padding = '8px';
        h.style.textAlign = 'left';
        h.style.cursor = 'pointer';
        h.style.background = 'transparent';
        h.style.fontWeight = '800';
        h.dataset.key = key;
        h.dataset.order = 'desc';
        h.onclick = () => {
          const k = h.dataset.key;
          const order = h.dataset.order === 'asc' ? 'desc' : 'asc';
          // reset other headers
          Array.from(table.querySelectorAll('th')).forEach(thEl => { if (thEl !== h) thEl.dataset.order = 'desc'; });
          h.dataset.order = order;
          renderRows(k, order);
        };
        return h;
      }

      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      headRow.appendChild(th('Username','username'));
      headRow.appendChild(th('Email','email'));
      headRow.appendChild(th('Livello','level'));
      headRow.appendChild(th('Registrato','created_at'));
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      teamWrap.appendChild(tableWrap);

      // map direct users to normalized rows (ensure level text)
      function normalize(u){
        return {
          username: u.username || '(n/d)',
          email: u.email || '(n/d)',
          level: 'Diretto',
          created_at: u.created_at || ''
        };
      }
      direct = direct.map(normalize);

      function renderRows(sortKey, order){
        tbody.innerHTML = '';
        const items = direct.slice();
        if (sortKey) {
          items.sort((a,b)=>{
            const va = (a[sortKey] || '').toString().toLowerCase();
            const vb = (b[sortKey] || '').toString().toLowerCase();
            if (va < vb) return order === 'asc' ? -1 : 1;
            if (va > vb) return order === 'asc' ? 1 : -1;
            return 0;
          });
        } else {
          // default: created_at desc
          items.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
        }
        items.forEach(it=>{
          const r = document.createElement('tr');
          r.style.borderTop = '1px solid rgba(0,0,0,0.04)';
          const c1 = document.createElement('td'); c1.style.padding='8px'; c1.textContent = it.username;
          const c2 = document.createElement('td'); c2.style.padding='8px'; c2.textContent = it.email;
          const c3 = document.createElement('td'); c3.style.padding='8px'; c3.textContent = it.level;
          const c4 = document.createElement('td'); c4.style.padding='8px'; c4.textContent = it.created_at ? new Date(it.created_at).toLocaleDateString() : '-';
          r.appendChild(c1); r.appendChild(c2); r.appendChild(c3); r.appendChild(c4);
          tbody.appendChild(r);
        });
      }

      // initial render (sorted by created_at desc)
      renderRows('created_at','desc');

      // action: open full team page
      const openBtn = document.createElement('button'); openBtn.className='primary'; openBtn.textContent='Apri pagina Team';
      openBtn.style.marginTop = '10px';
      openBtn.onclick = ()=> { navigate('team'); };

      teamWrap.appendChild(openBtn);
      wrap.appendChild(teamWrap);
    } catch (e) {
      console.warn('render team failed', e);
    }

    const btnLogout = document.createElement('button'); btnLogout.className='btn'; btnLogout.textContent='Esci';
    btnLogout.onclick = ()=>{ clearSession(); navigate('login'); };
    wrap.appendChild(btnLogout);
    return wrap;
  }

  // Full dedicated team page (navigable)
  function teamPage(){
    const session = getSession();
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Team - Invitati diretti'));
    const users = usersCol.getList();
    const direct = users.filter(u => String(u.referrer_a) === String(session.uid) || String(u.referrer_a) === String(session.id));
    const table = document.createElement('table');
    table.style.width='100%';
    table.style.borderCollapse='collapse';
    table.style.fontSize='13px';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Username','Email','Livello','Registrato'].forEach(h=>{
      const th = document.createElement('th'); th.textContent = h; th.style.padding='8px'; th.style.textAlign='left'; th.style.fontWeight='800';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');

    // sort by created_at desc by default
    direct.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
    direct.forEach(u=>{
      const r = document.createElement('tr');
      r.style.borderTop = '1px solid rgba(0,0,0,0.04)';
      const c1 = document.createElement('td'); c1.style.padding='8px'; c1.textContent = u.username || '(n/d)';
      const c2 = document.createElement('td'); c2.style.padding='8px'; c2.textContent = u.email || '(n/d)';
      const c3 = document.createElement('td'); c3.style.padding='8px'; c3.textContent = 'Diretto';
      const c4 = document.createElement('td'); c4.style.padding='8px'; c4.textContent = u.created_at ? new Date(u.created_at).toLocaleDateString() : '-';
      r.appendChild(c1); r.appendChild(c2); r.appendChild(c3); r.appendChild(c4);
      tbody.appendChild(r);
    });

    if (direct.length === 0){
      const empty = document.createElement('div'); empty.className='small'; empty.textContent = 'Non hai ancora invitati diretti.'; wrap.appendChild(empty);
    } else {
      table.appendChild(tbody);
      wrap.appendChild(table);
    }

    const back = document.createElement('div'); back.style.display='flex'; back.style.justifyContent='flex-end'; back.style.marginTop='10px';
    const backBtn = document.createElement('button'); backBtn.className='btn'; backBtn.textContent='Indietro'; backBtn.onclick = ()=>{ navigate('profile'); };
    back.appendChild(backBtn);
    wrap.appendChild(back);
    return wrap;
  }

  // bottom navigation builder — returns an integrated nav that can be embedded into the page wrapper
  // pass inPage=true to make it the in-page (non-fixed) nav; for backwards compatibility, fixed mode still supported.
  function bottomNav(active, inPage, opts){
    const nav = document.createElement('div');
    nav.className = 'bottom-nav' + ((inPage === false) ? ' fixed' : '');
    opts = opts || {};
    // If adminOnly flag set, show a minimal admin nav (admin panel + logout)
    if (opts.adminOnly) {
      const adminItem = document.createElement('div'); adminItem.className = 'nav-item' + (active==='admin' ? ' active' : '');
      adminItem.onclick = ()=>{ navigate('admin'); };
      adminItem.innerHTML = `<div style="font-size:18px">🛠️</div><div style="font-size:12px;margin-top:2px">Admin</div>`;
      nav.appendChild(adminItem);

      const logoutItem = document.createElement('div'); logoutItem.className = 'nav-item';
      logoutItem.onclick = async ()=>{ await clearSession(); navigate('login'); };
      logoutItem.innerHTML = `<div style="font-size:18px">🔓</div><div style="font-size:12px;margin-top:2px">Esci</div>`;
      nav.appendChild(logoutItem);
      return nav;
    }

    const items = [
      {k:'home',label:'Home',icon:'🏠'},
      {k:'hardware',label:'Hardware',icon:'⚙️'},
      {k:'devices',label:'My Devices',icon:'💽'},
      {k:'licenses',label:'Licenze',icon:'🔑'},
      {k:'profile',label:'Profilo',icon:'👤'}
    ];
    items.forEach(it=>{
      const a = document.createElement('div'); a.className='nav-item' + (it.k===active ? ' active':'' );
      a.onclick = ()=>{ navigate(it.k); };
      a.innerHTML = `<div style="font-size:18px">${it.icon}</div><div style="font-size:12px;margin-top:2px">${it.label}</div>`;
      nav.appendChild(a);
    });
    return nav;
  }

  // Deposit / withdraw modals (simple prompts)
  function openDeposit(){
    const amt = parseFloat(prompt('Importo da depositare (USDT):','50'));
    if (!amt || amt<=0) return;
    const method = prompt('Rete (BNB | BTC | TRON | ERC20):','ERC20');
    const session = getSession();
    // create a pending deposit transaction: admin will generate/send OTP to the user from the admin panel
    (async ()=>{
      await txCol.create({
        user_id: session.id,
        type: 'deposit',
        amount: amt,
        method,
        status: 'pending',
        created_at: new Date().toISOString(),
        note: 'Deposito pendente - in attesa OTP (admin)'
      });
      alert('Deposito registrato come PENDENTE. L\'amministratore genererà un OTP per la conferma e lo invierà al tuo account.');
      render();
    })();
  }

  function openWithdraw(){
    const amt = parseFloat(prompt('Importo da prelevare (USDT):','100'));
    if (!amt || amt<=0) return;
    const session = getSession();
    // simple rules enforcement (as described)
    if (amt < 100) {
      alert('Prelievo minimo 100$ (50$ con licenza).');
      return;
    }
    // ensure withdrawals draw only from confirmed earnings (withdrawable)
    const userTx = txCol.getList().filter(t => t.user_id === session.id);
    const earnings = userTx.filter(t => t.type === 'earning' && t.status !== 'pending').reduce((s,t)=>s+(Number(t.amount)||0),0);
    const withdrawals = userTx.filter(t => t.type === 'withdraw' && t.status === 'confirmed').reduce((s,t)=>s+(Number(t.amount)||0),0);
    const currentWithdrawable = Math.max(0, earnings - withdrawals);
    if (amt > currentWithdrawable) {
      return alert('Fondi insufficienti sul saldo prelevabile (solo i guadagni confermati sono prelevabili).');
    }
    // create a pending withdraw transaction: admin will generate/send OTP to the user from the admin panel
    (async ()=>{
      await txCol.create({
        user_id: session.id,
        type: 'withdraw',
        amount: amt,
        status: 'pending',
        created_at: new Date().toISOString(),
        note: 'Prelievo pendente - in attesa OTP (admin)'
      });
      alert('Richiesta prelievo registrata come PENDENTE. L\'amministratore genererà un OTP per la conferma e lo invierà al tuo account.');
      render();
    })();
  }

  // Utilities
  function labeled(id, text){ const l = document.createElement('label'); l.textContent = text; return l; }
  function input(type,name){ const i = document.createElement('input'); i.type=type; i.name=name; i.className='input'; i.autocomplete='off'; return i; }
  function formatMoney(n){
    const num = typeof n === 'number' ? n : (Number(n) || 0);
    // pretty format with thousands separators and two decimals
    return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // build a transaction row DOM element (reusable) and include an "Inserisci OTP" button when appropriate
  function buildTxRow(t){
    const row = document.createElement('div'); row.className='tx';
    const left = document.createElement('div'); left.className = 'tx-left';
    const typeBadge = document.createElement('div'); typeBadge.className = 'tx-type'; typeBadge.textContent = (t.type||'').toUpperCase();
    const time = document.createElement('div'); time.className = 'tx-time'; time.textContent = new Date(t.created_at).toLocaleString();
    left.appendChild(typeBadge); left.appendChild(time);

    const center = document.createElement('div'); center.className = 'tx-center';
    const note = document.createElement('div'); note.className = 'tx-note'; note.textContent = t.note || '';
    center.appendChild(note);

    const right = document.createElement('div'); right.className = 'tx-right';
    right.appendChild(el('div.tx-amount', formatMoney(t.amount)));
    const badge = document.createElement('div');
    const st = t.status || 'confirmed';
    badge.className = 'badge ' + (st === 'pending' ? 'pending' : (st === 'otp_sent' ? 'otp_sent' : 'confirmed'));
    badge.textContent = (st === 'pending' ? 'PENDENTE' : (st === 'otp_sent' ? 'OTP INVIATO' : (t.credited ? 'ACCREDITATO' : 'CONFERMATO')));
    right.appendChild(badge);

    const actions = document.createElement('div'); actions.className = 'tx-actions';
    const details = document.createElement('button'); details.className='small-action'; details.textContent='Dettagli';
    details.onclick = ()=>{ alert(`${(t.type||'').toUpperCase()} — ${t.note || '(nessuna nota)'}\n${new Date(t.created_at).toLocaleString()}`); };
    actions.appendChild(details);

    const stLow = (t.status||'').toLowerCase();
    if (stLow === 'otp_sent' || stLow === 'pending') {
      const enterOtp = document.createElement('button'); enterOtp.className='small-action'; enterOtp.textContent='Inserisci OTP';
      enterOtp.onclick = ()=> { confirmTransactionWithOTP(t.id); };
      actions.appendChild(enterOtp);
    }

    right.appendChild(actions);

    row.appendChild(left);
    row.appendChild(center);
    row.appendChild(right);
    return row;
  }

  function computeDaily(user_id){
    // Sum daily yield of active devices
    const devs = deviceCol.getList().filter(d=>d.owner_id===user_id && d.active);
    return devs.reduce((s,d)=>s + (d.daily_yield||0), 0);
  }

  // Allow users to input an OTP code for a given transaction id.
  // This global helper is used by multiple page views so the user can always enter an OTP sent by admin.
  async function confirmTransactionWithOTP(txId){
    try {
      const session = getSession();
      if (!session) return alert('Sessione non trovata. Effettua il login.');
      const tx = txCol.getList().find(x => x.id === txId && x.user_id === session.id);
      if (!tx) return alert('Transazione non trovata o non appartiene all\'utente.');
      const code = prompt('Inserisci OTP per confermare la transazione:','');
      if (!code) return;
      // find OTP entry
      const otpRec = otpCol.getList().find(o => o.tx_id === txId && String(o.code) === String(code) && !o.used && o.user_id === session.id);
      if (!otpRec) return alert('OTP non valido o già usato');
      try {
        await otpCol.update && otpCol.update(otpRec.id, { used: true, used_at: new Date().toISOString() });
      } catch(e){ /* best-effort */ }
      const updatePayload = {
        status: 'confirmed',
        confirmed_at: new Date().toISOString()
      };
      if (tx.type === 'deposit') {
        updatePayload.credited = true;
        updatePayload.credited_at = new Date().toISOString();
        updatePayload.note = (tx.note || '') + ' (accreditato via OTP)';
      } else if (tx.type === 'withdraw') {
        updatePayload.note = (tx.note || '') + ' (prelievo confermato via OTP)';
      }
      await txCol.update && txCol.update(txId, updatePayload);
      alert('Transazione confermata.');
      render();
    } catch (e) {
      console.warn('confirmTransactionWithOTP failed', e);
      alert('Conferma OTP fallita.');
    }
  }

  function generateOTP(){
    return Math.floor(100000 + Math.random()*900000).toString();
  }

  // accrues daily earnings for devices owned by the session user.
  // This runs on render and credits one accrual per day per active device (based on last_accrual).
  async function accrueEarnings(session){
    if (!session) return;
    const today = new Date();
    const devs = deviceCol.getList().filter(d=>d.owner_id===session.id && d.active);
    for (const d of devs){
      try {
        // parse last_accrual or fallback to created_at
        const last = d.last_accrual ? new Date(d.last_accrual) : (d.created_at ? new Date(d.created_at) : null);
        // if never accrued or last accrual is before today (different day), credit one accrual per missing day up to a cap (30)
        const lastTime = last ? new Date(last.getFullYear(), last.getMonth(), last.getDate()) : null;
        const todayTime = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const daysMissing = lastTime ? Math.floor((todayTime - lastTime) / (1000*60*60*24)) : 1;
        if (!daysMissing || daysMissing <= 0) continue;
        const cap = Math.min(daysMissing, 30);
        const perDay = Number(d.daily_yield) || 0;
        if (perDay <= 0) {
          // update last_accrual to today to avoid repeated loops
          await deviceCol.update && deviceCol.update(d.id, { last_accrual: today.toISOString() });
          continue;
        }
        // create a single aggregated earning transaction for the missing days
        const total = +(perDay * cap).toFixed(2);
        await txCol.create({
          user_id: session.id,
          type: 'earning',
          amount: total,
          created_at: new Date().toISOString(),
          note: `Accredito ${cap} giorno(i) - ${d.name}`
        });
        // update device last_accrual to today
        await deviceCol.update && deviceCol.update(d.id, { last_accrual: today.toISOString() });
      } catch(e){
        console.warn('accrue error', e);
      }
    }
  }

  // initial seed: show platform funding note as a small card (no external credential calls)
  async function seedCreator() {
    const metaCol = getCollection('meta_v1');
    const recs = metaCol.getList();
    if (!recs.find(r=>r.key==='about')) {
      await metaCol.create({
        key:'about',
        text: 'CUP LTD ha destinato 1 milione di dollari come capitale iniziale per infrastruttura e crescita.',
        created_at: new Date().toISOString()
      });
    }
  }

  // expose session and navigation helpers globally so sessions created on the backend are usable from other browsers/tabs
  window.getSession = getSession;
  window.saveSession = saveSession;
  window.clearSession = clearSession;
  window.navigate = navigate;
  window.render = render;
  // also expose format/generate helpers for external modules
  window.formatMoney = formatMoney;
  window.generateOTP = generateOTP;

  // Broadcast admin actions: persist to localStorage for cross-tab visibility and attempt to record to backend collections.
  // Other modules already dispatch 'cup9gpu_admin_action' events; this listener will ensure server-side persistence
  // and a centralized localStorage last-action entry so all tabs can react consistently.
  window.addEventListener('cup9gpu_admin_action', async (ev) => {
    try {
      const detail = (ev && ev.detail) ? ev.detail : {};
      // write a last-admin-action snapshot (used by other tabs to detect and refresh)
      try { localStorage.setItem('cup9gpu_last_admin_action', JSON.stringify(Object.assign({ ts: Date.now() }, detail))); } catch(e){}

      // best-effort: create a server-side transaction-like record to persist the admin action
      try {
        if (txCol && typeof txCol.create === 'function') {
          await txCol.create({
            user_id: detail.id || detail.user_id || null,
            type: 'admin_action',
            amount: detail.amount || 0,
            status: 'confirmed',
            created_at: new Date().toISOString(),
            note: JSON.stringify(detail)
          });
        }
      } catch (e) {
        // ignore backend create failures (offline/local mode)
        console.warn('admin_action persistence failed', e);
      }

      // also dispatch a lightweight window event so in-page listeners can respond immediately
      try { window.dispatchEvent(new CustomEvent('cup9gpu_admin_action_local', { detail })); } catch(e){}
    } catch (e) {
      console.warn('admin action handler failed', e);
    }
  });

  // When an admin action is persisted, refresh OTP counts and the UI so the target user immediately sees OTPs in Notifications.
  window.addEventListener('cup9gpu_admin_action_local', async (ev) => {
    try {
      // Recompute OTP counts by reading otpCol (persistent backend or local mirror)
      const list = (otpCol && typeof otpCol.getList === 'function') ? otpCol.getList() : [];
      const map = {};
      (list || []).forEach(o => {
        if (!o || !o.user_id) return;
        if (o.used) return;
        map[o.user_id] = (map[o.user_id] || 0) + 1;
      });
      // persist counts for cross-tab visibility and fire the existing event listeners used by the bell
      try { localStorage.setItem('cup9gpu_otp_counts', JSON.stringify(map)); } catch(e){}
      try { window.dispatchEvent(new CustomEvent('otp_counts_updated', { detail: map })); } catch(e){}
      // trigger a re-render so current UI updates (e.g., bell badge and notification modal content)
      try { render && render(); } catch(e){}
    } catch (e) {
      console.warn('admin_action_local handler failed', e);
    }
  });

  // Start
  // seedCreator runs in background (non-blocking) to avoid slowing initial load
  seedCreator().catch(()=>{});
  render();

})();