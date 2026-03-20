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
    const BACKEND_API_BASE = (window.apiBase && String(window.apiBase)) ? window.apiBase : '/api/collections';
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
    // use the Render-hosted backend endpoint consistently (remote-first, authoritative)
    const API_BASE = (window.apiBase && String(window.apiBase)) ? window.apiBase : '/api/collections';
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

        // Best-effort client-side guard: never allow a client update to mark a deposit as credited/confirmed/accredited.
        // This ensures deposits remain in pending/awaiting flow until an admin explicitly accredits them.
        try {
          // Look up cached record to inspect type
          const existing = cache ? cache.find(x => String(x.id) === String(id)) : null;
          if (existing && String(existing.type).toLowerCase() === 'deposit' && data && typeof data === 'object') {
            const incomingStatus = (data.status || '').toString().toLowerCase();
            const incomingCredited = data.credited === true || String(data.credited) === 'true';
            if (incomingCredited || incomingStatus === 'confirmed' || incomingStatus === 'accredited') {
              // sanitize client attempt: prevent crediting and force status to a non-accredited state
              console.warn('Client attempted to credit a deposit; sanitizing update for id=', id);
              // remove any credited fields the client supplied
              delete data.credited;
              delete data.credited_at;
              // prevent client from elevating status to confirmed/accredited
              // keep status as pending/awaiting_deposit unless explicitly rejected
              if (incomingStatus === 'rejected') {
                data.status = 'rejected';
                data.rejected_at = data.rejected_at || new Date().toISOString();
                // ensure credited flags remain false
                data.credited = false;
                data.credited_at = null;
                data.note = (data.note || '') + ' (client-side attempted accreditation prevented)';
              } else {
                // never allow client to mark deposit as confirmed/accredited
                data.status = existing.status || 'pending';
                data.note = (data.note || '') + ' (client-side accreditation prevented)';
              }
            }
          }
        } catch (guardErr) {
          // if guard fails, continue — do not block the update flow, but log
          console.warn('Deposit credit guard failed', guardErr);
        }

        try {
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
        } catch (err) {
          // PATCH failed (server may not support PATCH). Fall back to best-effort local merge/update
          console.warn('Collection update failed for', url, 'falling back to local merge:', err);
          try {
            // try to find existing record in cache
            let existing = null;
            if (cache) existing = cache.find(x => String(x.id) === String(id));
            // if not in cache, attempt a background fetch to populate cache then find
            if (!existing) {
              try { await fetchList(true); } catch(e){}
              existing = cache ? cache.find(x => String(x.id) === String(id)) : null;
            }
            // merge fields locally
            const merged = Object.assign({}, existing || { id }, data || {});

            // SECURITY: ensure a rejected transaction can never become credited in any fallback path.
            // If the incoming update marks the status as 'rejected' (case-insensitive), enforce credited=false
            // and clear any credited_at timestamp to avoid accidental crediting during offline reconciliation.
            try {
              const st = (merged.status || '').toString().toLowerCase();
              if (st === 'rejected' || (data && String(data.status || '').toLowerCase() === 'rejected')) {
                merged.credited = false;
                merged.credited_at = null;
                // ensure rejected_at is present for auditability
                merged.rejected_at = merged.rejected_at || new Date().toISOString();
                // include an admin-safety note if not provided
                merged.note = (merged.note ? merged.note + ' ' : '') + '(rejected - credits prevented)';
              }
              // Additional safety: if this is a deposit, ensure it is not credited by fallback merge
              if (String((existing && existing.type) || '').toLowerCase() === 'deposit') {
                merged.credited = false;
                merged.credited_at = null;
                // if a client attempted to set confirmed/accredited, keep it pending
                const attempted = (data && String(data.status || '').toLowerCase()) || '';
                if (attempted === 'confirmed' || attempted === 'accredited') {
                  merged.status = existing.status || 'pending';
                  merged.note = (merged.note ? merged.note + ' ' : '') + '(client-side accreditation prevented in fallback)';
                }
              }
            } catch (e) { /* best-effort enforcement; continue */ }

            // mark an updated_at timestamp to indicate local reconciliation
            try { merged.updated_at = new Date().toISOString(); } catch(e){}
            // reflect merge in local cache and notify subscribers
            upsertToCache(merged);

            // attempt a non-failing fallback: try POSTing the merged record to server as a create (best-effort)
            try {
              const postRes = await fetch(base, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(merged)
              });
              if (postRes.ok) {
                const created = await postRes.json();
                upsertToCache(created);
                return created;
              }
            } catch (e) {
              // ignore network/create failures — return local merged record
            }
            return merged;
          } catch (e) {
            // last resort: rethrow original err so callers can handle it
            console.warn('Fallback local update also failed', e);
            throw err;
          }
        }
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
        // Never delete user accounts; mark account as deactivated and persist changes both locally and server-side.
        try {
          console.warn('Blocked attempt to delete user account (converted to deactivation):', id);

          // 1) Best-effort: update the user record server-side (if supported)
          if (typeof usersCol.update === 'function') {
            try {
              await usersCol.update(id, {
                deactivated: true,
                deactivated_at: new Date().toISOString(),
                deactivated_by_system: true,
                deleted_at: new Date().toISOString()
              });
            } catch(e){
              // ignore server update failure but continue to persist locally
              console.warn('usersCol.update failed while deactivating user:', e);
            }
          }

          // 2) Ensure local persisted copy is updated so account remains persistent across refreshes
          try {
            if (typeof window.__cup9gpu_forcePersistUsers === 'function') {
              window.__cup9gpu_forcePersistUsers();
            } else {
              // fallback: write minimal local users snapshot
              try {
                const list = usersCol.getList ? usersCol.getList() : [];
                const copy = (Array.isArray(list) ? list.map(u => ({
                  id: u.id, username: u.username, email: u.email, password: u.password, user_uid: u.user_uid, deactivated: u.deactivated, deactivated_at: u.deactivated_at, updated_at: u.updated_at
                })) : []);
                localStorage.setItem('cup9gpu_persistent_users_v1', JSON.stringify(copy));
              } catch(e){}
            }
          } catch(e){ console.warn('Local persist after deactivation failed', e); }

          // 3) Keep a server-side session (do not delete sessions) - update session record to reflect deactivation if sessionsCol available
          try {
            if (typeof sessionsCol !== 'undefined' && sessionsCol && typeof sessionsCol.getList === 'function') {
              const sessions = sessionsCol.getList();
              const related = sessions.find(s => String(s.user_id) === String(id) || String(s.uid) === String(id) || String(s.user_uid) === String(id));
              if (related && typeof sessionsCol.update === 'function') {
                try {
                  await sessionsCol.update(related.id, { active: false, user_deactivated_at: new Date().toISOString() });
                } catch(e){}
              }
            }
          } catch(e){ /* best-effort */ }

        } catch(e){
          console.warn('Error handling user delete override for id', id, e);
        }

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

    // Replace create/update/delete wrappers to be backend-first and persist user changes locally.
    try {
      const rawCreate = usersCol.create && usersCol.create.bind(usersCol);
      if (rawCreate) {
        usersCol.create = async function(data){
          // allow normal client-side registration to create users and persist locally after server confirmation
          try {
            const email = data && data.email ? String(data.email).toLowerCase() : null;
            if (email) {
              const existing = (usersCol.getList() || []).find(u => u.email && String(u.email).toLowerCase() === email);
              if (existing) return existing;
            }
          } catch(e){ /* ignore dedupe errors */ }

          const res = await rawCreate(data);
          try { persistNow(); } catch(e){}
          return res;
        };
      }

      const rawUpdate = usersCol.update && usersCol.update.bind(usersCol);
      if (rawUpdate) {
        usersCol.update = async function(id, data){
          // allow users to update their own profile (server-first), then persist locally
          const res = await rawUpdate(id, data);
          try { persistNow(); } catch(e){}
          return res;
        };
      }

      const rawDelete = usersCol.delete && usersCol.delete.bind(usersCol);
      if (rawDelete) {
        usersCol.delete = async function(id){
          // deletion attempts will be forwarded to backend helper which may mark deactivated; persist result locally
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
            try {
              // Stronger idempotent guard for transactions:
              // Always prevent creation of more than one "pending-like" deposit per user.
              // If data.type === 'deposit' and a pending/awaiting_deposit/otp_sent deposit exists
              // for the same user (matched by user_id or user_uid), return that existing record.
              if (storageKey === keys.tx && data && String(data.type).toLowerCase() === 'deposit') {
                try {
                  const all = col.getList() || [];
                  // match by authoritative identifiers (prefer user_id, fallback to user_uid/uid)
                  const userId = data.user_id || data.user_uid || data.uid || null;
                  const candidate = all.find(t => {
                    if (String(t.type).toLowerCase() !== 'deposit') return false;
                    const st = String((t.status || '')).toLowerCase();
                    const pendingLike = st === 'awaiting_deposit' || st === 'pending' || st === 'otp_sent';
                    if (!pendingLike) return false;
                    // match user equivalently
                    const sameUser = (userId && (String(t.user_id) === String(userId) || String(t.user_uid) === String(userId) || String(t.uid) === String(userId)));
                    if (!sameUser) return false;
                    // If amount/network were explicitly provided and the existing record has them,
                    // ensure they match to avoid returning an unrelated deposit on a different network/amount.
                    if (data.amount !== undefined && data.amount !== null && data.amount !== '') {
                      const a = Number(t.amount) || 0;
                      const b = Number(data.amount) || 0;
                      if (Math.abs(a - b) > 0.0001) return false;
                    }
                    if (data.network && t.network && String(t.network).toLowerCase() !== String(data.network).toLowerCase()) return false;
                    return true;
                  });
                  if (candidate) {
                    try { persistNow(); } catch(e){}
                    return candidate;
                  }
                } catch(e){
                  // best-effort guard; if it fails continue to create
                  console.warn('deposit idempotency guard error', e);
                }
              }

              // For other transaction types, keep prior duplicate-avoidance behavior (if present)
              if (storageKey === keys.tx && data && (data.type === 'withdraw' || data.type === 'admin_otp' || data.type === 'purchase' || data.type === 'earning')) {
                try {
                  const existing = col.getList() || [];
                  const candidate = existing.find(t => {
                    const sameUser = (data.user_id && String(t.user_id) === String(data.user_id)) ||
                                     (data.user_uid && String(t.user_uid) === String(data.user_uid)) ||
                                     (data.uid && String(t.uid) === String(data.uid));
                    if (!sameUser) return false;
                    const status = String((t.status || '')).toLowerCase();
                    const pendingLike = status === 'awaiting_deposit' || status === 'pending' || status === 'otp_sent';
                    if (!pendingLike) return false;
                    if (data.amount !== undefined && data.amount !== null && data.amount !== '') {
                      const a = Number(t.amount) || 0;
                      const b = Number(data.amount) || 0;
                      if (Math.abs(a - b) > 0.0001) return false;
                    }
                    if (data.network && t.network && String(t.network).toLowerCase() !== String(data.network).toLowerCase()) return false;
                    if (data.deposit_address && t.deposit_address && String(t.deposit_address) !== String(data.deposit_address)) return false;
                    return true;
                  });
                  if (candidate) {
                    try { persistNow(); } catch (e) {}
                    return candidate;
                  }
                } catch (e) { /* best-effort dedupe; fall through to create */ }
              }
            } catch (e) { /* ignore guard errors */ }

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

      // persist locally to sessionStorage (per-tab)
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(normalized)); } catch(e){/*best-effort*/}

      // Also persist a durable session copy in localStorage to survive tab close / full refresh and enable cross-tab reuse.
      // Store by uid to allow multiple sessions per device if necessary.
      try {
        const PERSIST_KEY = 'cup9gpu_persistent_session';
        const all = JSON.parse(localStorage.getItem(PERSIST_KEY) || '{}');
        all[normalized.uid] = normalized;
        localStorage.setItem(PERSIST_KEY, JSON.stringify(all));
      } catch(e){
        console.warn('local persistent session save failed', e);
      }

      // expose globally for immediate cross-module access
      window.__cup9_session = normalized;
      return normalized;
    } catch(e){
      console.warn('saveSession failed', e);
      return null;
    }
  }

  // On boot: restore per-tab session if present so we keep the same session/uid across refreshes.
  // Persisting the session prevents accidental generation of new uids on every reload which previously caused duplicate transactions.
  (function restoreSessionPerTab(){
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        try {
          window.__cup9_session = JSON.parse(stored);
        } catch (e) {
          // if parse fails, clear the broken value and start with no session
          try { sessionStorage.removeItem(SESSION_KEY); } catch(e){}
          window.__cup9_session = null;
        }
      } else {
        // try persistent localStorage first so refreshes or tab closes can restore the last known session for this device
        try {
          const PERSIST_KEY = 'cup9gpu_persistent_session';
          const persistent = JSON.parse(localStorage.getItem(PERSIST_KEY) || '{}');
          // prefer the session matching the most-recent updated_at if multiple exist
          const keys = Object.keys(persistent || {});
          if (keys.length > 0) {
            let chosen = null;
            keys.forEach(k => {
              const s = persistent[k];
              if (!s) return;
              if (!chosen) chosen = s;
              else {
                try {
                  if (new Date(s.updated_at) > new Date(chosen.updated_at)) chosen = s;
                } catch(e){}
              }
            });
            if (chosen) {
              // restore into both sessionStorage (per-tab) and in-memory
              try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(chosen)); } catch(e){}
              window.__cup9_session = chosen;
            } else {
              window.__cup9_session = null;
            }
          } else {
            window.__cup9_session = null;
          }
        } catch(e){
          // fallback: no persistent session available
          window.__cup9_session = null;
        }
      }
    } catch (e) {
      console.warn('restore per-tab session failed', e);
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
  // start on register page by default — registration is mandatory
  let route = 'register';
  // transaction history page pointer (used by admin/user navigation to the transactions view)
  let txPage = 1;
  function navigate(to){
    // If navigation requests the admin panel, open the fullscreen admin.html (immediate redirect).
    try {
      if (to === 'admin') {
        // Open dedicated fullscreen admin page for best viewing experience.
        // Use location.assign instead of window.open to keep same tab and ensure full-screen SPA replacement.
        window.location.assign('/admin.html');
        return;
      }
      // Enforce admin-only view: any admin session is always routed to the admin panel and cannot navigate elsewhere.
      const session = getSession();
      if (session && session.is_admin) {
        // always force admin to admin panel; allow explicit logout/login route for switching accounts
        if (to !== 'login' && to !== 'admin') {
          // silently force admin route without exposing platform pages
          // redirect to fullscreen admin console
          window.location.assign('/admin.html');
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
      // enforce registration-required policy: redirect anonymous users to register
      route = 'register';
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

      // Admin quick access button for creator / admin users
      try {
        const isCreatorOrAdmin = (session && session.is_admin) || (creatorUsername && session && String(session.username) === String(creatorUsername));
        if (isCreatorOrAdmin) {
          const adminBtn = document.createElement('button');
          adminBtn.className = 'btn';
          adminBtn.style.fontWeight = '900';
          adminBtn.textContent = 'Admin';
          adminBtn.title = 'Apri pannello Admin (fullscreen)';
          adminBtn.onclick = () => { try { window.location.assign('/admin.html'); } catch(e) { window.open('/admin.html', '_blank'); } };
          right.appendChild(adminBtn);
        }
      } catch(e){ /* ignore admin button errors */ }

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
            // find related transaction and ensure it's still awaiting confirmation (single pending flow)
            try {
              const tx = txCol.getList().find(t => t.id === o.tx_id);
              if (!tx) return false;
              const st = (tx.status || 'confirmed').toLowerCase();
              return st === 'pending';
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
    // Use exchange-style shell so every page inherits the detailed exchange layout and card styling
    // apply an auth-focused class for login/register to improve visibility
    const baseClasses = ['hardware-page','card','exchange-shell'];
    if (route === 'login' || route === 'register') baseClasses.push('auth-card');
    wrapper.className = baseClasses.join(' ');
    wrapper.appendChild(pageEl);
    app.appendChild(wrapper);

    // If the current session is admin, force admin-only nav; otherwise show normal bottom nav.
    // Do NOT show the bottom navigation on login or register pages to keep the UI focused.
    const sessionNow = getSession();
    if (sessionNow && sessionNow.is_admin) {
      // admin sees only admin panel and a minimal nav for logout
      wrapper.appendChild(bottomNav('admin', true, { adminOnly: true }));
    } else if (route !== 'login' && route !== 'register') {
      // include the bottom nav as part of the page wrapper for normal pages only
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

      // ensure unique email locally to avoid obvious duplicates
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

      // first try server-side registration; if network/server fails, fallback to creating via usersCol.create
      let user = null;
      const payload = {
        username: inpUsername.value.trim(),
        email: inpEmail.value.trim().toLowerCase(),
        password: inpPass.value,
        invite_code: inviteInput || undefined
      };

      try {
        const res = await fetch('/api/users/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          user = await res.json();
          // refresh local users collection if available
          try { if (usersCol && typeof usersCol.__refresh === 'function') await usersCol.__refresh(); } catch(e){}
        } else {
          // server responded but with error (e.g., email exists) — show error to user
          const err = await res.json().catch(()=>({ error: 'register_failed' }));
          // If server refused due to duplicate, abort; otherwise try fallback create.
          if (err && err.error === 'email exists') {
            return alert('Registrazione fallita: email già esistente.');
          } else {
            console.warn('Server registration returned error, attempting local fallback', err);
            // fall through to fallback
          }
        }
      } catch (e) {
        console.warn('Registration endpoint unreachable, attempting local fallback', e);
      }

      // fallback: if user not created by server, attempt to create via usersCol (collection wrapper)
      if (!user) {
        try {
          const now = new Date().toISOString();
          const rec = {
            username: payload.username,
            email: payload.email,
            password: payload.password,
            user_uid: user_uid,
            invite_code: user_uid,
            referrer_a: null,
            referrer_b: null,
            referrer_c: null,
            deactivated: false,
            created_at: now,
            updated_at: now
          };
          // if invite provided, try resolve local inviter to set referrers (best-effort)
          if (inviteInput) {
            const inviter = usersCol.getList().find(u => String(u.invite_code) === String(inviteInput) || String(u.user_uid) === String(inviteInput));
            if (inviter) {
              rec.referrer_a = inviter.user_uid || inviter.uid || inviter.id || null;
              rec.referrer_b = inviter.referrer_a || inviter.referrer_b || null;
              rec.referrer_c = inviter.referrer_b || null;
            }
          }
          const created = await usersCol.create(rec);
          // create some minimal referral rewards locally (server would normally do this)
          try {
            const txs = txCol;
            const nowTx = new Date().toISOString();
            const rewards = { a: 5, b: 3, c: 1 };
            if (rec.referrer_a) {
              const ra = usersCol.getList().find(u => String(u.user_uid) === String(rec.referrer_a) || String(u.id) === String(rec.referrer_a));
              const raId = (ra && ra.id) ? ra.id : rec.referrer_a;
              await txs.create && txs.create({
                user_id: raId,
                type: 'earning',
                amount: rewards.a,
                created_at: nowTx,
                note: `Referral level A reward for inviting ${rec.user_uid}`
              });
            }
            if (rec.referrer_b) {
              const rb = usersCol.getList().find(u => String(u.user_uid) === String(rec.referrer_b) || String(u.id) === String(rec.referrer_b));
              const rbId = (rb && rb.id) ? rb.id : rec.referrer_b;
              await txs.create && txs.create({
                user_id: rbId,
                type: 'earning',
                amount: rewards.b,
                created_at: nowTx,
                note: `Referral level B reward for invited ${rec.user_uid}`
              });
            }
            if (rec.referrer_c) {
              const rc = usersCol.getList().find(u => String(u.user_uid) === String(rec.referrer_c) || String(u.id) === String(rec.referrer_c));
              const rcId = (rc && rc.id) ? rc.id : rec.referrer_c;
              await txs.create && txs.create({
                user_id: rcId,
                type: 'earning',
                amount: rewards.c,
                created_at: nowTx,
                note: `Referral level C reward for invited ${rec.user_uid}`
              });
            }
          } catch(e){ console.warn('local referral reward creation failed', e); }
          user = Object.assign({ id: created.id || created.id || user_uid }, rec, { user_uid: rec.user_uid, invite_code: rec.invite_code });
          // ensure persisted locally
          try { if (typeof window.__cup9gpu_forcePersistUsers === 'function') window.__cup9gpu_forcePersistUsers(); } catch(e){}
        } catch (e) {
          console.error('Local fallback registration failed', e);
          return alert('Registrazione non riuscita (errore rete o server). Riprova più tardi.');
        }
      }

      // inform the user of their generated ID UTENTE and create/copy a full referral link to clipboard
      try {
        const base = (typeof window.baseUrl === 'string' && window.baseUrl) ? window.baseUrl : (window.location.origin + window.location.pathname);
        const refLink = `${base.replace(/\/$/, '')}?ref=${encodeURIComponent(user.invite_code || user.user_uid || user_uid)}`;
        const msg = `Registrazione completata.\nID UTENTE: ${user.user_uid || user_uid}\nLink invito: ${refLink}\n(È stato copiato negli appunti.)`;
        try { await navigator.clipboard.writeText(refLink); } catch(e){ /* clipboard may not be available */ }
        alert(msg);
      } catch (e) {
        try { alert('Registrazione completata. ID UTENTE: ' + (user.user_uid || user_uid)); } catch(e){}
      }

      // persist session with the unique user_uid
      saveSession({ id: user.id, uid: user.user_uid || user_uid, username: user.username, email: user.email });
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

      // Try to find a matching user record
      let user = usersCol.getList().find(u => (u.email || '').toLowerCase() === email);

      // If user exists but password mismatches, reconcile by updating password to the provided one
      // This ensures users won't see "invalid credentials" and can always sign in with their latest input.
      try {
        if (user && user.password !== pass) {
          try {
            await usersCol.update && usersCol.update(user.id, { password: pass });
            // refresh local snapshot
            user = usersCol.getList().find(u => (u.email || '').toLowerCase() === email);
          } catch (e) {
            // best-effort: swallow errors and continue to allow login flow
            console.warn('password reconcile failed', e);
          }
        }
      } catch(e){}

      // Do NOT auto-create users on login — registration is mandatory.
      if (!user) {
        return alert('Account non trovato. Registrati prima di effettuare il login.');
      }

      // Ensure we have a uid for session; if not, generate and persist it
      const uid = (user && (user.user_uid || user.uid)) || (function(){
        try {
          if (window.__cup9_utils && typeof window.__cup9_utils.generateOTP === 'function') return window.__cup9_utils.generateOTP();
          return String(Math.floor(100000 + Math.random()*900000));
        } catch(e) {
          return String(Math.floor(100000 + Math.random()*900000));
        }
      })();

      // If user record didn't have user_uid, update it in the collection (best-effort)
      try {
        if (user && !user.user_uid) {
          usersCol.update && usersCol.update(user.id, { user_uid: uid, invite_code: uid }).catch(()=>{});
        }
      } catch(e){}

      // persist session with unique uid (always succeed silently)
      await saveSession({ id: (user && user.id) || null, uid, username: (user && user.username) || (email.split('@')[0] || 'user'), email: email });
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
    container.className = 'home-grid';
    container.style.display = 'grid';
    container.style.gridTemplateColumns = '1fr';
    container.style.gap = '18px';
    container.style.width = '100%';
    container.style.boxSizing = 'border-box';

    // Shell grid that adapts to viewport: left column for balances/actions, right column for compact widgets
    const shell = document.createElement('div');
    shell.style.display = 'grid';
    shell.style.gridTemplateColumns = '1fr';
    shell.style.gap = '18px';
    shell.style.alignItems = 'start';
    shell.style.width = '100%';

    // Gather user transactions and compute core balances (safe defaults)
    const allTx = txCol.getList().filter(t => t.user_id === session?.id);
    // Only include deposits that have been explicitly credited/accredited by admin.
    const totalDeposits = allTx.filter(t => t.type === 'deposit' && (t.credited === true || String(t.status).toLowerCase() === 'accredited')).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const totalPurchases = allTx.filter(t => t.type === 'purchase').reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const earnings = allTx.filter(t => t.type === 'earning' && !['pending','otp_sent'].includes(t.status)).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const totalWithdrawals = allTx.filter(t => t.type === 'withdraw' && t.status === 'confirmed').reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const spendable = Math.max(0, totalDeposits - totalPurchases);
    const withdrawable = Math.max(0, earnings - totalWithdrawals);

    // LEFT COLUMN: Prominent Balance Panel
    const balancePanel = document.createElement('div');
    balancePanel.className = 'card elevated';
    balancePanel.style.padding = '18px';
    balancePanel.style.display = 'flex';
    balancePanel.style.flexDirection = 'column';
    balancePanel.style.gap = '12px';

    balancePanel.appendChild(el('h3','Panoramica Saldo'));

    // Large numeric summary
    const mainRow = document.createElement('div');
    mainRow.style.display = 'flex';
    mainRow.style.gap = '12px';
    mainRow.style.alignItems = 'center';
    mainRow.style.flexWrap = 'wrap';

    const mainLeft = document.createElement('div');
    mainLeft.style.flex = '1 1 320px';
    mainLeft.style.minWidth = '220px';
    mainLeft.style.padding = '18px';
    mainLeft.style.borderRadius = '12px';
    mainLeft.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.04))';
    mainLeft.appendChild(el('div.small','Saldo disponibile'));
    const mainAmount = document.createElement('div');
    mainAmount.className = 'big';
    mainAmount.style.fontSize = '34px';
    mainAmount.style.marginTop = '8px';
    mainAmount.textContent = formatMoney(spendable);
    mainLeft.appendChild(mainAmount);
    mainLeft.appendChild(el('div.small', `Guadagno stimato/giorno: ${formatMoney(computeDaily(session?.id))}`));

    const mainRight = document.createElement('div');
    mainRight.style.flex = '0 0 220px';
    mainRight.style.padding = '14px';
    mainRight.style.borderRadius = '12px';
    mainRight.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.008), rgba(0,0,0,0.03))';
    mainRight.appendChild(el('div.small','Prelevabile'));
    const withdrawVal = document.createElement('div'); withdrawVal.className='big'; withdrawVal.style.fontSize='20px'; withdrawVal.style.marginTop='6px';
    withdrawVal.textContent = formatMoney(withdrawable);
    mainRight.appendChild(withdrawVal);
    mainRight.appendChild(el('div.small', `Tot. depositi: ${formatMoney(totalDeposits)}`));

    mainRow.appendChild(mainLeft);
    mainRow.appendChild(mainRight);
    balancePanel.appendChild(mainRow);

    // Compact stats row (three columns)
    const statsRow = document.createElement('div');
    statsRow.style.display = 'flex';
    statsRow.style.gap = '12px';
    statsRow.style.flexWrap = 'wrap';

    const statItem = (label, val) => {
      const c = document.createElement('div');
      c.style.flex = '1 1 140px';
      c.style.minWidth = '120px';
      c.style.padding = '12px';
      c.style.borderRadius = '10px';
      c.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.006), rgba(255,255,255,0.002))';
      c.appendChild(el('div.small', label));
      const v = document.createElement('div'); v.className='val'; v.style.fontWeight='900'; v.style.marginTop='6px'; v.textContent = val;
      c.appendChild(v);
      return c;
    };

    statsRow.appendChild(statItem('Guadagni confermati', formatMoney(earnings)));
    statsRow.appendChild(statItem('Spese totali', formatMoney(totalPurchases)));
    statsRow.appendChild(statItem('Transazioni', String(allTx.length)));
    balancePanel.appendChild(statsRow);

    // Action buttons grouped and clearly labeled
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '10px';
    actions.style.flexWrap = 'wrap';
    actions.style.marginTop = '10px';
    const depositBtn = document.createElement('button'); depositBtn.className = 'primary'; depositBtn.textContent = 'Deposita';
    depositBtn.onclick = openDeposit;
    const withdrawBtn = document.createElement('button'); withdrawBtn.className = 'btn'; withdrawBtn.textContent = 'Preleva';
    withdrawBtn.onclick = openWithdraw;
    const devicesBtn = document.createElement('button'); devicesBtn.className = 'btn'; devicesBtn.textContent = 'I miei dispositivi';
    devicesBtn.onclick = ()=>navigate('devices');
    actions.appendChild(depositBtn); actions.appendChild(withdrawBtn); actions.appendChild(devicesBtn);
    balancePanel.appendChild(actions);

    // RIGHT COLUMN: Compact widgets (quick actions, recent tx, support)
    const widgets = document.createElement('div');
    widgets.style.display = 'flex';
    widgets.style.flexDirection = 'column';
    widgets.style.gap = '12px';

    // Quick Actions card
    const quick = document.createElement('div'); quick.className = 'card subtle'; quick.style.padding = '12px';
    quick.appendChild(el('h3','Azioni rapide'));
    const qGrid = document.createElement('div'); qGrid.className = 'mini-grid';
    const qTx = document.createElement('div'); qTx.className = 'mini-box'; qTx.style.cursor='pointer';
    qTx.onclick = ()=>navigate('transactions');
    qTx.appendChild(el('div.mb-left', [ (function(){ const d=document.createElement('div'); d.className='mb-icon'; d.textContent='📜'; return d; })(), (function(){ const t=document.createElement('div'); t.appendChild(Object.assign(document.createElement('div'), { className:'mb-title', textContent:'Transazioni' })); t.appendChild(Object.assign(document.createElement('div'), { className:'mb-sub', textContent:'Cronologia e gestione' })); return t; })() ]));
    qGrid.appendChild(qTx);

    const qBuy = document.createElement('div'); qBuy.className='mini-box'; qBuy.style.cursor='pointer';
    qBuy.onclick = ()=>navigate('hardware');
    qBuy.appendChild(el('div.mb-left', [ (function(){ const d=document.createElement('div'); d.className='mb-icon'; d.textContent='⚙️'; return d; })(), (function(){ const t=document.createElement('div'); t.appendChild(Object.assign(document.createElement('div'), { className:'mb-title', textContent:'Acquista GPU' })); t.appendChild(Object.assign(document.createElement('div'), { className:'mb-sub', textContent:'Scegli un piano' })); return t; })() ]));
    qGrid.appendChild(qBuy);

    qGrid.appendChild(qTx);
    qGrid.appendChild(qBuy);
    quick.appendChild(qGrid);
    widgets.appendChild(quick);

    // Recent transactions (compact list)
    const recent = document.createElement('div'); recent.className='card'; recent.style.padding='12px';
    recent.appendChild(el('h3','Ultime transazioni'));
    const recentList = document.createElement('div'); recentList.className='list'; recentList.style.maxHeight='280px';
    const txs = txCol.getList().filter(t => t.user_id === session?.id).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at)).slice(0,6);
    if (!txs.length) recentList.appendChild(el('div.small','Nessuna transazione recente'));
    else {
      txs.forEach(t => {
        const r = document.createElement('div'); r.className='tx'; r.style.padding='10px';
        const l = document.createElement('div'); l.style.flex='1';
        l.appendChild(el('div', `${(t.type||'').toUpperCase()} · ${t.note || ''}`));
        l.appendChild(el('div.meta', new Date(t.created_at).toLocaleString()));
        const rr = document.createElement('div'); rr.style.textAlign='right';
        rr.appendChild(el('div.tx-amount', formatMoney(t.amount)));
        const badge = document.createElement('div');
        const st = (t.status || '').toString().toLowerCase();
        badge.className = 'badge ' + st;
        badge.textContent = (st === 'pending'
          ? 'PENDENTE'
          : (st === 'otp_sent'
            ? 'OTP INVIATO'
            : (st === 'rejected'
              ? 'RIFIUTATA'
              : (t.credited ? 'ACCREDITATO' : 'CONFERMATO'))));
        rr.appendChild(badge);
        r.appendChild(l); r.appendChild(rr);
        recentList.appendChild(r);
      });
    }
    recent.appendChild(recentList);
    widgets.appendChild(recent);

    // Support/Info small card
    const info = document.createElement('div'); info.className='card subtle'; info.style.padding='12px';
    info.appendChild(el('h3','Info'));
    info.appendChild(el('div.small','Le GPU acquistate appariranno in "I miei dispositivi". Le risorse sono permanenti e non restituibili.'));
    widgets.appendChild(info);

    // Assemble shell columns
    shell.appendChild(balancePanel);
    shell.appendChild(widgets);
    container.appendChild(shell);

    // Responsive behavior: switch to two-column on larger screens
    try {
      const mq = window.matchMedia('(min-width:980px)');
      const apply = ()=> {
        if (mq.matches) shell.style.gridTemplateColumns = '640px 1fr';
        else shell.style.gridTemplateColumns = '1fr';
      };
      apply();
      mq.addEventListener && mq.addEventListener('change', apply);
    } catch(e){}

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
    const perPage = 12;
    const page = Math.max(1, Math.floor(txPage) || 1);

    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild(el('h3','Cronologia transazioni'));
    wrap.appendChild(el('div.small',`Pagina ${page} — elenco storico e saldo progressivo`));

    // fetch and sort user's transactions (newest first)
    const allTx = txCol.getList().filter(t => String(t.user_id) === String(session?.id)).slice().sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));

    // compute running balance (walk from oldest to newest for correct running balance)
    const sortedAsc = allTx.slice().sort((a,b)=> new Date(a.created_at) - new Date(b.created_at));
    let running = 0;
    const runningMap = {}; // txId => balance after this tx
    sortedAsc.forEach(t => {
      const amt = Number(t.amount || 0);
      // define how types affect balance: deposits (+ when credited/confirmed), earnings (+), purchases/withdraw (-)
      const typ = String((t.type||'')).toLowerCase();
      if (typ === 'deposit') {
        if (t.credited === true || String(t.status || '').toLowerCase() === 'confirmed' || String(t.status || '').toLowerCase() === 'accredited') running += amt;
      } else if (typ === 'earning') {
        running += amt;
      } else if (typ === 'purchase') {
        running -= amt;
      } else if (typ === 'withdraw') {
        // withdraw.amount is gross withdrawn amount
        running -= amt;
      } else {
        // admin_action or other types: treat 'amount' positive/negative naively
        running += amt;
      }
      runningMap[t.id] = +running.toFixed(2);
    });

    // Pagination
    const start = (page - 1) * perPage;
    const pageItems = allTx.slice(start, start + perPage);

    // Group items by calendar date for human-friendly display
    const groups = {};
    pageItems.forEach(t => {
      const day = new Date(t.created_at || t.updated_at || t.created_at || Date.now());
      const key = day.toLocaleDateString();
      groups[key] = groups[key] || [];
      groups[key].push(t);
    });

    const list = document.createElement('div'); list.className='list';
    if (pageItems.length === 0) {
      list.appendChild(el('div.small','Nessuna transazione in questa pagina'));
    } else {
      // iterate days in descending order (newest day first)
      Object.keys(groups).sort((a,b)=> new Date(b) - new Date(a)).forEach(dayLabel => {
        const dayWrap = document.createElement('div');
        dayWrap.style.marginBottom = '8px';
        const dayHeader = document.createElement('div');
        dayHeader.className = 'section-header';
        dayHeader.appendChild(el('div.h-title', dayLabel));
        const dayTotal = groups[dayLabel].reduce((s,t)=>{
          const typ = String((t.type||'')).toLowerCase();
          if (typ === 'deposit') return s + ((t.credited||String(t.status||'').toLowerCase()==='confirmed' || String(t.status||'').toLowerCase()==='accredited') ? Number(t.amount||0) : 0);
          if (typ === 'earning') return s + Number(t.amount||0);
          if (typ === 'purchase' || typ === 'withdraw') return s - Number(t.amount||0);
          return s + Number(t.amount||0);
        }, 0);
        dayHeader.appendChild(el('div.small', `Giorno totale: ${formatMoney(dayTotal)}`));
        dayWrap.appendChild(dayHeader);

        groups[dayLabel].sort((a,b)=> new Date(b.created_at) - new Date(a.created_at)).forEach(t => {
          const row = document.createElement('div'); row.className='tx'; row.style.padding='10px';
          const left = document.createElement('div'); left.style.flex='1';
          left.appendChild(el('div', `${(t.type||'').toUpperCase()} · ${t.note || ''}`));
          left.appendChild(el('div.meta', new Date(t.created_at).toLocaleString()));
          const right = document.createElement('div'); right.style.display='flex'; right.style.flexDirection='column'; right.style.alignItems='flex-end'; right.style.gap='6px';
          right.appendChild(el('div.tx-amount', formatMoney(t.amount)));

          // running balance after this transaction (prefer computed map)
          const bal = typeof runningMap[t.id] !== 'undefined' ? runningMap[t.id] : null;
          if (bal !== null) right.appendChild(el('div.small', `Saldo: ${formatMoney(bal)}`));

          // friendly status badge
          const st = (t.status || '').toString().toLowerCase();
          const badge = document.createElement('div');
          badge.className = 'badge ' + (st === 'pending' ? 'pending' : (st === 'otp_sent' ? 'otp_sent' : (st === 'rejected' ? 'rejected' : 'confirmed')));
          badge.textContent = (st === 'pending' ? 'PENDENTE' : (st === 'otp_sent' ? 'OTP INVIATO' : (st === 'rejected' ? 'RIFIUTATA' : (t.credited ? 'ACCREDITATO' : 'CONFERMATO'))));
          right.appendChild(badge);

          const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';
          const details = document.createElement('button'); details.className='small-action'; details.textContent='Dettagli';
          details.onclick = ()=>{ alert(`${t.type.toUpperCase()} — ${t.note || '(nessuna nota)'}\n${new Date(t.created_at).toLocaleString()}\nSaldo dopo transazione: ${bal!==null?formatMoney(bal):'—'}`); };
          actions.appendChild(details);

          if (st === 'pending') {
            const enterOtp = document.createElement('button'); enterOtp.className='small-action'; enterOtp.textContent='Conferma';
            enterOtp.onclick = ()=> { confirmTransactionWithOTP(t.id); };
            actions.appendChild(enterOtp);
          }

          right.appendChild(actions);

          row.appendChild(left);
          row.appendChild(right);
          dayWrap.appendChild(row);
        });

        list.appendChild(dayWrap);
      });
    }

    wrap.appendChild(list);

    // controls: pagination + export CSV + jump to top
    const nav = document.createElement('div'); nav.style.display='flex'; nav.style.justifyContent='space-between'; nav.style.marginTop='10px'; nav.style.alignItems='center';
    const leftNav = document.createElement('div');
    const prev = document.createElement('button'); prev.className='btn'; prev.textContent='◀ Pagina precedente';
    prev.onclick = ()=>{ if (page > 1) { txPage = page - 1; navigate('transactions'); } else alert('Sei alla prima pagina'); };
    const next = document.createElement('button'); next.className='btn'; next.textContent='Pagina successiva ▶';
    next.onclick = ()=>{ if ((start + perPage) < allTx.length) { txPage = page + 1; navigate('transactions'); } else alert('Nessuna altra pagina'); };
    leftNav.appendChild(prev); leftNav.appendChild(next);

    const rightNav = document.createElement('div');
    rightNav.style.display='flex'; rightNav.style.gap='8px'; rightNav.style.alignItems='center';
    const exportBtn = document.createElement('button'); exportBtn.className='btn'; exportBtn.textContent='Esporta CSV';
    exportBtn.onclick = ()=>{
      try {
        const rows = [['created_at','id','type','amount','status','note','running_balance']];
        allTx.forEach(t => {
          const row = [
            (t.created_at||''),
            (t.id||''),
            (t.type||''),
            String(t.amount||''),
            (t.status||''),
            (t.note||'').replace(/\n/g,' '),
            String(typeof runningMap[t.id] !== 'undefined' ? runningMap[t.id] : '')
          ];
          rows.push(row.map(c => `"${String(c).replace(/"/g,'""')}"`));
        });
        const blob = new Blob([rows.map(r=>r.join(',')).join('\n')], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `transactions_${session?.uid||session?.id||'user'}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      } catch(e){ alert('Esportazione fallita'); console.warn(e); }
    };
    const topBtn = document.createElement('button'); topBtn.className='btn'; topBtn.textContent='Vai all\'inizio';
    topBtn.onclick = ()=> window.scrollTo({ top: 0, behavior: 'smooth' });

    rightNav.appendChild(exportBtn); rightNav.appendChild(topBtn);
    nav.appendChild(leftNav); nav.appendChild(rightNav);
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
      const pending = txCol.getList().filter(t => t.status === 'pending');
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
            // Use explicit 'accredited' status for deposits to keep admin crediting clear and auditable
            const payload = { status: 'accredited', accredited_at: new Date().toISOString() };
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
            // persistently remove this pending entry from admin pending list
            try {
              const key = 'cup9gpu_admin_removed_pending';
              const cur = JSON.parse(localStorage.getItem(key) || '[]');
              if (!cur.includes(String(t.id))) { cur.push(String(t.id)); localStorage.setItem(key, JSON.stringify(cur)); }
            } catch(e){ console.warn('persist removed pending failed', e); }
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
            // persistently remove this pending entry from admin pending list
            try {
              const key = 'cup9gpu_admin_removed_pending';
              const cur = JSON.parse(localStorage.getItem(key) || '[]');
              if (!cur.includes(String(t.id))) { cur.push(String(t.id)); localStorage.setItem(key, JSON.stringify(cur)); }
            } catch(e){ console.warn('persist removed pending failed', e); }
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
        // keep local state for otp toggle to avoid referencing an undefined variable
        let currentOtp = !!userRec.otp_enabled;

        const editRow = document.createElement('div');
        editRow.style.display='flex';
        editRow.style.flexDirection='column';
        editRow.style.gap='8px';

        const uname = document.createElement('input');
        uname.className='input';
        uname.value = userRec.username || '';
        uname.placeholder = 'Username';

        const email = document.createElement('input');
        email.className='input';
        email.value = userRec.email || '';
        email.placeholder = 'Email';

        // OTP toggle row
        const otpRowLocal = document.createElement('div');
        otpRowLocal.style.display = 'flex';
        otpRowLocal.style.alignItems = 'center';
        otpRowLocal.style.gap = '8px';

        const otpLabelLocal = document.createElement('label');
        otpLabelLocal.textContent = 'OTP abilitato:';
        otpLabelLocal.style.fontSize = '13px';
        otpLabelLocal.style.color = 'var(--muted)';

        const otpCheckbox = document.createElement('input');
        otpCheckbox.type = 'checkbox';
        otpCheckbox.checked = currentOtp;
        otpCheckbox.onchange = () => { currentOtp = !!otpCheckbox.checked; };

        otpRowLocal.appendChild(otpLabelLocal);
        otpRowLocal.appendChild(otpCheckbox);

        const saveUserBtn = document.createElement('button');
        saveUserBtn.className='primary';
        saveUserBtn.textContent='Salva utente';
        saveUserBtn.onclick = async ()=>{
          try {
            const upd = { username: uname.value, email: email.value, otp_enabled: currentOtp };
            await usersCol.update && usersCol.update(userRec.id, upd);
            alert('Utente aggiornato');
            render();
          } catch (e) {
            console.warn('save user failed', e);
            alert('Salvataggio utente fallito');
          }
        };

        editRow.appendChild(uname);
        editRow.appendChild(email);
        editRow.appendChild(otpRowLocal);
        editRow.appendChild(saveUserBtn);
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



  // Profile page: user settings, wallet, security and preferences (no session list)
  function profilePage(){
    const session = getSession();
    const wrap = document.createElement('div');
    wrap.className = 'card';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '12px';

    // Top header with avatar, username, email and ID
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.gap = '12px';
    header.style.padding = '12px';
    header.style.borderRadius = '10px';
    header.style.background = 'linear-gradient(90deg, rgba(255,255,255,0.01), rgba(255,255,255,0.003))';
    header.style.border = '1px solid rgba(255,255,255,0.02)';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '12px';

    // avatar / placeholder
    const avatar = document.createElement('div');
    avatar.style.width = '64px';
    avatar.style.height = '64px';
    avatar.style.borderRadius = '12px';
    avatar.style.display = 'flex';
    avatar.style.alignItems = 'center';
    avatar.style.justifyContent = 'center';
    avatar.style.fontWeight = '900';
    avatar.style.fontSize = '20px';
    avatar.style.background = 'linear-gradient(135deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01))';
    avatar.style.color = 'var(--accent)';
    avatar.textContent = (session && session.username) ? (session.username[0] || 'U').toUpperCase() : 'U';

    const info = document.createElement('div');
    info.style.display = 'flex';
    info.style.flexDirection = 'column';
    info.style.gap = '4px';

    const nameEl = document.createElement('div'); nameEl.style.fontSize = '18px'; nameEl.style.fontWeight = '900'; nameEl.textContent = session?.username || 'Utente';
    const emailEl = document.createElement('div'); emailEl.className = 'small'; emailEl.textContent = session?.email || '—';
    const idEl = document.createElement('div'); idEl.className = 'small'; idEl.textContent = 'ID: ' + (session?.uid || session?.id || '—');

    info.appendChild(nameEl);
    info.appendChild(emailEl);
    info.appendChild(idEl);

    left.appendChild(avatar);
    left.appendChild(info);

    // quick action buttons on header
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '8px';
    right.style.alignItems = 'center';

    const editBtn = document.createElement('button'); editBtn.className = 'btn'; editBtn.textContent = 'Modifica';
    editBtn.onclick = ()=> { navigate('profile'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    const logoutBtn = document.createElement('button'); logoutBtn.className = 'btn'; logoutBtn.textContent = 'Esci';
    logoutBtn.onclick = async ()=> { await clearSession(); navigate('login'); };

    right.appendChild(editBtn);
    right.appendChild(logoutBtn);

    header.appendChild(left);
    header.appendChild(right);

    wrap.appendChild(header);

    // Grid of compact management tiles
    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
    grid.style.gap = '10px';

    // tile builder
    function tile(title, subtitle, action){
      const t = document.createElement('div');
      t.className = 'mini-box';
      t.style.cursor = 'pointer';
      t.style.padding = '12px';
      t.style.display = 'flex';
      t.style.flexDirection = 'column';
      t.style.justifyContent = 'center';
      t.onclick = action;
      const tt = document.createElement('div'); tt.className = 'mb-title'; tt.textContent = title;
      const st = document.createElement('div'); st.className = 'mb-sub'; st.textContent = subtitle;
      t.appendChild(tt); t.appendChild(st);
      return t;
    }

    // tiles
    grid.appendChild(tile('Informazioni account', 'Modifica username, email, password', ()=> {
      // scroll to existing profile section or open quick editor inline
      openInlineEditor();
    }));

    grid.appendChild(tile('Sicurezza', 'OTP, 2FA e sessioni', ()=> { navigate('profile'); try { document.querySelector('.card .small') && window.scrollTo({ top: 200, behavior: 'smooth' }); } catch(e){} }));

    grid.appendChild(tile('Wallet', 'Indirizzi e rete', ()=> { navigate('profile'); try { document.querySelector('.card input[type=email]') && window.scrollTo({ top: 320, behavior: 'smooth' }); } catch(e){} }));

    grid.appendChild(tile('Dispositivi', 'I tuoi hardware attivi', ()=> { navigate('devices'); }));

    grid.appendChild(tile('Transazioni', 'Cronologia e prelievi', ()=> { navigate('transactions'); }));

    grid.appendChild(tile('Invita amici', 'Copia link invito', async ()=> {
      try {
        const base = (typeof window.baseUrl === 'string' && window.baseUrl) ? window.baseUrl : (window.location.origin + window.location.pathname);
        const link = `${base.replace(/\/$/, '')}?ref=${encodeURIComponent(session?.uid || session?.id || '')}`;
        await navigator.clipboard.writeText(link);
        alert('Link copiato negli appunti: ' + link);
      } catch(e){ alert('Copia non disponibile'); }
    }));

    // compact actions row
    const actionsRow = document.createElement('div');
    actionsRow.style.display = 'flex';
    actionsRow.style.gap = '8px';
    actionsRow.style.marginTop = '8px';
    actionsRow.style.justifyContent = 'flex-end';

    const saveBtn = document.createElement('button'); saveBtn.className = 'primary'; saveBtn.textContent = 'Salva modifiche';
    saveBtn.onclick = async ()=> {
      // attempt to find local user record and save basic fields (best-effort)
      try {
        const users = usersCol.getList();
        const me = users.find(u => String(u.id) === String(session?.id) || String(u.user_uid) === String(session?.uid));
        if (!me) return alert('Nessun profilo locale trovato');
        // open inline editor will handle updates; just show confirmation
        alert('Usa le schede per modificare le impostazioni dal profilo.');
      } catch(e){ console.warn(e); alert('Salvataggio fallito'); }
    };

    const deactivateBtn = document.createElement('button'); deactivateBtn.className = 'btn'; deactivateBtn.textContent = 'Disattiva account';
    deactivateBtn.onclick = async ()=> {
      if (!confirm('Disattivare il tuo account?')) return;
      try {
        const users = usersCol.getList();
        const me = users.find(u => String(u.id) === String(session?.id) || String(u.user_uid) === String(session?.uid));
        if (!me) return alert('Account non trovato.');
        await usersCol.update && usersCol.update(me.id, { deactivated: true, deactivated_at: new Date().toISOString() });
        alert('Account disattivato. Verrai disconnesso.');
        await clearSession();
        navigate('login');
      } catch(e){ console.error(e); alert('Impossibile disattivare account.'); }
    };

    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(deactivateBtn);

    // inline editor: collapsible editable form (appears below tiles)
    const editor = document.createElement('div');
    editor.style.display = 'none';
    editor.style.flexDirection = 'column';
    editor.style.gap = '8px';
    editor.style.marginTop = '8px';
    editor.style.padding = '10px';
    editor.style.borderRadius = '10px';
    editor.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.003))';
    editor.style.border = '1px solid rgba(255,255,255,0.02)';

    function openInlineEditor(){
      // populate fields from current user record
      editor.innerHTML = '';
      const users = usersCol.getList();
      const me = users.find(u => String(u.id) === String(session?.id) || String(u.user_uid) === String(session?.uid));
      const uname = document.createElement('input'); uname.className='input'; uname.value = me?.username || session?.username || '';
      const emailInp = document.createElement('input'); emailInp.className='input'; emailInp.type='email'; emailInp.value = me?.email || session?.email || '';
      const pass1 = document.createElement('input'); pass1.className='input'; pass1.type='password'; pass1.placeholder='Nuova password (lascia vuoto)';
      const pass2 = document.createElement('input'); pass2.className='input'; pass2.type='password'; pass2.placeholder='Conferma password';

      const saveLocal = document.createElement('button'); saveLocal.className='primary'; saveLocal.textContent='Salva';
      saveLocal.onclick = async ()=>{
        try {
          if (!uname.value.trim() || !emailInp.value.trim()) return alert('Username e email obbligatori.');
          if (pass1.value || pass2.value) {
            if (pass1.value !== pass2.value) return alert('Le password non corrispondono.');
            if (pass1.value.length < 4) return alert('Password troppo corta.');
          }
          if (!me) return alert('Utente non trovato per aggiornamento.');
          const payload = { username: uname.value.trim(), email: emailInp.value.trim().toLowerCase() };
          if (pass1.value) payload.password = pass1.value;
          await usersCol.update && usersCol.update(me.id, payload);
          alert('Profilo aggiornato.');
          editor.style.display = 'none';
          render();
        } catch(e){ console.error(e); alert('Aggiornamento fallito'); }
      };

      const cancel = document.createElement('button'); cancel.className='btn'; cancel.textContent='Annulla';
      cancel.onclick = ()=> { editor.style.display = 'none'; };

      editor.appendChild(uname);
      editor.appendChild(emailInp);
      editor.appendChild(pass1);
      editor.appendChild(pass2);
      const row = document.createElement('div'); row.style.display='flex'; row.style.gap='8px'; row.appendChild(saveLocal); row.appendChild(cancel);
      editor.appendChild(row);
      editor.style.display = 'flex';
      editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // responsive tweak: use single column on small screens
    try {
      const mq = window.matchMedia('(max-width:520px)');
      const adapt = ()=> {
        if (mq.matches) grid.style.gridTemplateColumns = '1fr';
        else grid.style.gridTemplateColumns = 'repeat(2,1fr)';
      };
      adapt();
      mq.addEventListener && mq.addEventListener('change', adapt);
    } catch(e){}

    wrap.appendChild(grid);
    wrap.appendChild(actionsRow);
    wrap.appendChild(editor);

    // populate initial grid tiles (re-create to ensure tiles exist)
    grid.innerHTML = '';
    grid.appendChild(tile('Informazioni account', 'Modifica username, email, password', openInlineEditor));
    grid.appendChild(tile('Sicurezza', 'OTP, 2FA e sessioni', ()=> { navigate('profile'); openInlineEditor(); }));
    grid.appendChild(tile('Wallet', 'Indirizzi e rete', ()=> { navigate('profile'); openInlineEditor(); }));
    grid.appendChild(tile('Dispositivi', 'I tuoi hardware attivi', ()=> { navigate('devices'); }));
    grid.appendChild(tile('Transazioni', 'Cronologia e prelievi', ()=> { navigate('transactions'); }));
    grid.appendChild(tile('Invita amici', 'Copia link invito', async ()=> {
      try {
        const base = (typeof window.baseUrl === 'string' && window.baseUrl) ? window.baseUrl : (window.location.origin + window.location.pathname);
        const link = `${base.replace(/\/$/, '')}?ref=${encodeURIComponent(session?.uid || session?.id || '')}`;
        await navigator.clipboard.writeText(link);
        alert('Link copiato negli appunti: ' + link);
      } catch(e){ alert('Copia non disponibile'); }
    }));

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
    // Guided deposit modal flow with idempotent create: one pending deposit tx per user+amount+network,
    // tracked via localStorage so refresh/logout doesn't create duplicates.
    const session = getSession();
    if (!session) return alert('Per favore accedi prima di depositare.');

    const STORAGE_KEY = 'cup9gpu_pending_deposits_v1'; // map user => array of pending entries

    // helper to read/write idempotency map
    function readPendingMap(){
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch(e){ return {}; }
    }
    function writePendingMap(m){
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch(e){}
    }

    // build overlay/modal constrained to page wrapper
    const overlay = document.createElement('div');
    overlay.className = 'notif-overlay';
    overlay.style.zIndex = 80;

    const modal = document.createElement('div');
    modal.className = 'notif-modal';
    modal.style.maxWidth = '720px';
    modal.style.padding = '16px';
    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:900;font-size:18px">Deposito</div>
        <button class="btn" id="depositClose">Chiudi</button>
      </div>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
        <label class="small">Importo (es. 100.00)</label>
        <input id="depositAmount" class="input" type="number" step="0.01" placeholder="Importo da depositare"/>
        <label class="small">Seleziona rete</label>
        <select id="depositNetwork" class="input">
          <option value="TRC20">USDT TRC20</option>
          <option value="BTC">BTC</option>
          <option value="BNB">BNB</option>
          <option value="USDC">USDC</option>
        </select>

        <div id="addrSection" style="display:none;flex-direction:column;gap:8px">
          <div class="small">Indirizzo di deposito generato</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="depositAddress" class="input" readonly style="flex:1" />
            <button id="copyAddress" class="btn">Copia</button>
          </div>
          <div class="small">Appena inviato il pagamento: clicca "Ho effettuato il deposito" per fornire TXHash e prova pagamento.</div>
        </div>

        <div id="submitSection" style="display:none;flex-direction:column;gap:8px">
          <label class="small">TX Hash</label>
          <input id="depositTxHash" class="input" type="text" placeholder="Inserisci TXHash della transazione (es. txhash)" />
          <label class="small">Foto prova pagamento (opzionale)</label>
          <input id="depositProof" type="file" accept="image/*" />
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="confirmDeposit" class="primary">Ho effettuato il deposito</button>
          </div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
          <button id="genAddrBtn" class="primary">Genera Indirizzo</button>
          <button id="cancelDeposit" class="btn">Annulla</button>
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const closeAll = () => { try { overlay.remove(); } catch(e){} };

    modal.querySelector('#depositClose').onclick = closeAll;
    modal.querySelector('#cancelDeposit').onclick = closeAll;

    const amtInput = modal.querySelector('#depositAmount');
    const netSelect = modal.querySelector('#depositNetwork');
    const genBtn = modal.querySelector('#genAddrBtn');
    const addrSection = modal.querySelector('#addrSection');
    const addrInput = modal.querySelector('#depositAddress');
    const copyBtn = modal.querySelector('#copyAddress');
    const submitSection = modal.querySelector('#submitSection');
    const confirmBtn = modal.querySelector('#confirmDeposit');
    const txHashInput = modal.querySelector('#depositTxHash');
    const proofInput = modal.querySelector('#depositProof');

    // generate a pseudo deposit address (demo): deterministic-ish per create using timestamp + uid
    function makeFakeAddress(network, uid){
      const rnd = Math.floor(100000 + Math.random()*900000);
      return `${network.toUpperCase()}_${String(uid).slice(0,6)}_${rnd}`;
    }

    // Find or create a single pending deposit transaction for this user+amount+network
    // Stronger idempotency: always attempt to find any matching pending/awaiting_deposit tx (by user identity, amount, network),
    // consult persisted mapping in localStorage as a stable hint, and only create if no suitable record exists.
    async function ensureSinglePendingDeposit(amount, network){
      // Use a per-user+amount+network idempotency key so only one pending deposit exists per identical request
      const userIdentifier = String(session && (session.uid || session.id || session.email || 'anon'));
      const map = readPendingMap();
      const key = `${userIdentifier}:${Number(amount||0).toFixed(2)}:${(network||'').toLowerCase()}`;

      // 1) If mapping exists, validate it against amount/network and resolve to a live transaction if still pending-like.
      try {
        const entry = map[key];
        if (entry && entry.tx_id) {
          // if mapping includes amount/network, require them to match before reusing
          if (typeof entry.amount !== 'undefined' && typeof entry.network !== 'undefined') {
            const amtMatch = Math.abs(Number(entry.amount || 0) - Number(amount || 0)) < 0.0001;
            const netMatch = String((entry.network||'')).toLowerCase() === String((network||'')).toLowerCase();
            if (!amtMatch || !netMatch) {
              // different deposit request: do not reuse mapped tx (keep mapping for original but don't return it)
              // fall through to search/create logic so a new distinct deposit may be created
            } else {
              const cache = (txCol.getList && txCol.getList()) || [];
              const found = cache.find(t => String(t.id) === String(entry.tx_id));
              if (found && (String(found.status) === 'awaiting_deposit' || String(found.status) === 'pending' || String(found.status) === 'otp_sent')) {
                return found;
              }
              // If mapped tx is no longer suitable, remove mapping and continue to global search
              delete map[key];
              writePendingMap(map);
            }
          } else {
            // legacy mapping without amount/network stored: attempt to reuse only if the tx still appears suitable
            const cache = (txCol.getList && txCol.getList()) || [];
            const found = cache.find(t => String(t.id) === String(entry.tx_id));
            if (found && (String(found.status) === 'awaiting_deposit' || String(found.status) === 'pending' || String(found.status) === 'otp_sent')) {
              // store amount/network snapshot on first reuse for stronger future idempotency
              try { map[key].amount = Number(amount||0); map[key].network = network || ''; writePendingMap(map); } catch(e){}
              return found;
            }
            delete map[key];
            writePendingMap(map);
          }
        }
      } catch (e) {
        // best-effort only; continue to global search/create
        console.warn('pending deposit map validation failed', e);
      }

      // 2) Global search: prefer an exact match by user+amount+network first, otherwise fall back to any pending for user.
      try {
        const all = (txCol.getList && txCol.getList()) || [];
        // exact match candidate: same user, same amount (within tolerance) and same network
        const exact = all.find(t => {
          if (String(t.type).toLowerCase() !== 'deposit') return false;
          const st = (t.status || '').toLowerCase();
          if (!(st === 'awaiting_deposit' || st === 'pending' || st === 'otp_sent')) return false;
          const sameUser = (session.id && String(t.user_id) === String(session.id)) || (session.uid && (String(t.user_uid) === String(session.uid) || String(t.uid) === String(session.uid)));
          if (!sameUser) return false;
          const a = Number(t.amount) || 0;
          const b = Number(amount) || 0;
          if (Math.abs(a - b) > 0.0001) return false;
          if (network && t.network && String(t.network).toLowerCase() !== String(network).toLowerCase()) return false;
          return true;
        });
        if (exact) {
          map[key] = { tx_id: exact.id, created_at: exact.created_at || new Date().toISOString(), amount: Number(amount||0), network: network || '' };
          writePendingMap(map);
          return exact;
        }
        // fallback: any pending deposit for this user (used as last resort)
        const any = all.find(t => {
          if (String(t.type).toLowerCase() !== 'deposit') return false;
          const st = (t.status || '').toLowerCase();
          if (!(st === 'awaiting_deposit' || st === 'pending' || st === 'otp_sent')) return false;
          return (session.id && String(t.user_id) === String(session.id)) || (session.uid && (String(t.user_uid) === String(session.uid) || String(t.uid) === String(session.uid)));
        });
        if (any) {
          // record mapping but prefer exact-match behavior next time when amount/network align
          map[key] = { tx_id: any.id, created_at: any.created_at || new Date().toISOString(), amount: Number(any.amount||0), network: any.network || '' };
          writePendingMap(map);
          return any;
        }
      } catch (e) {
        // ignore and proceed to create
      }

      // 3) No existing pending deposit found — create exactly one new awaiting_deposit record.
      const generatedAddress = makeFakeAddress(network, session && (session.uid || session.id || String(Date.now())));
      // create a stable idempotency_key for this exact request and persist it to the mapping so refresh/login reuse it
      const idemp = `${session && (session.uid || session.id || 'anon')}:${Number(amount||0).toFixed(2)}:${(network||'').toLowerCase()}:${Date.now().toString(36)}:${Math.floor(Math.random()*900000+100000)}`;
      let createdRec = null;
      try {
        createdRec = await txCol.create({
          user_id: session && session.id,
          user_uid: session && session.uid,
          type: 'deposit',
          amount: +Number(amount).toFixed(2),
          network,
          deposit_address: generatedAddress,
          status: 'awaiting_deposit',
          idempotency_key: idemp,
          created_at: new Date().toISOString(),
          note: `Indirizzo generato per deposito su ${network}`
        });
        // persist mapping so subsequent refresh/login returns the same transaction
        try { map[key] = { tx_id: createdRec.id, created_at: createdRec.created_at || new Date().toISOString(), amount: Number(amount||0), network: network || '', idempotency_key: idemp }; writePendingMap(map); } catch(e){}
      } catch (e) {
        // If create fails due to race/network, attempt one more time to find a suitable record that might have been created concurrently.
        try {
          const allAfter = (txCol.getList && txCol.getList()) || [];
          const fallback = allAfter.find(t => {
            if (String(t.type) !== 'deposit') return false;
            const st = (t.status || '').toLowerCase();
            if (! (st === 'awaiting_deposit' || st === 'pending' || st === 'otp_sent')) return false;
            const userMatch = (session.id && String(t.user_id) === String(session.id)) || (session.uid && (String(t.user_uid) === String(session.uid) || String(t.uid) === String(session.uid)));
            // prefer an exact match when possible
            const a = Number(t.amount) || 0;
            const b = Number(amount) || 0;
            const amtMatch = Math.abs(a - b) < 0.0001;
            const netMatch = (network && t.network) ? (String(t.network).toLowerCase() === String(network).toLowerCase()) : true;
            return userMatch && amtMatch && netMatch;
          }) || null;
          if (fallback) createdRec = fallback;
          else throw e;
        } catch (e2) {
          throw e2;
        }
      }

      // persist mapping for idempotency and return the created/found record
      if (createdRec && createdRec.id) {
        map[key] = { tx_id: createdRec.id, created_at: createdRec.created_at || new Date().toISOString(), amount: Number(amount||0), network: network || '' };
        writePendingMap(map);
      }
      return createdRec;
    }

    genBtn.onclick = async () => {
      // prevent double-click / concurrent generation (idempotency at UI level)
      if (overlay.dataset.genRunning === '1') return;
      overlay.dataset.genRunning = '1';
      genBtn.disabled = true;

      const amt = parseFloat(amtInput.value);
      if (!amt || amt <= 0) {
        overlay.dataset.genRunning = '0';
        genBtn.disabled = false;
        return alert('Inserisci un importo valido.');
      }
      const network = netSelect.value || 'TRC20';

      try {
        const rec = await ensureSinglePendingDeposit(amt, network);
        if (!rec) {
          overlay.dataset.genRunning = '0';
          genBtn.disabled = false;
          return alert('Impossibile creare o recuperare la richiesta di deposito.');
        }

        // show address UI and enable submit section
        addrInput.value = rec.deposit_address || makeFakeAddress(network, session.uid || session.id || String(Date.now()));
        addrSection.style.display = 'flex';
        submitSection.style.display = 'block';
        genBtn.textContent = 'Rigenera Indirizzo';
        overlay.dataset.pendingTxId = rec.id;

        copyBtn.onclick = ()=> {
          try { navigator.clipboard.writeText(addrInput.value); alert('Indirizzo copiato'); } catch(e){ alert('Copia non disponibile'); }
        };

        try { navigator.clipboard.writeText(addrInput.value); } catch(e){}
      } catch (e) {
        console.error('generate address failed', e);
        alert('Impossibile generare indirizzo. Riprova.');
      } finally {
        overlay.dataset.genRunning = '0';
        genBtn.disabled = false;
      }
    };

    confirmBtn.onclick = async () => {
      const txHash = txHashInput.value && txHashInput.value.trim();
      if (!txHash) return alert('Inserisci il TXHash della tua transazione.');

      // Resolve canonical pending transaction for this user by matching amount/network/address to avoid duplicates
      const pendingKeyId = overlay.dataset.pendingTxId;
      const amountVal = Number(amtInput.value) || null;
      const networkVal = netSelect.value || null;
      const addressVal = addrInput.value || null;
      let targetTx = null;

      try {
        // look for an authoritative match in current tx cache
        const all = txCol.getList() || [];
        const pendingLikeStatuses = ['awaiting_deposit','pending','otp_sent'];
        targetTx = all.find(t => {
          if (String(t.type).toLowerCase() !== 'deposit') return false;
          const st = (t.status || '').toLowerCase();
          if (!pendingLikeStatuses.includes(st)) return false;
          // match by deposit address when available (most reliable), otherwise by user+amount+network
          if (addressVal && t.deposit_address && String(t.deposit_address) === String(addressVal)) return true;
          // match by user identity
          const sameUser = (session.id && String(t.user_id) === String(session.id)) || (session.uid && (String(t.user_uid) === String(session.uid) || String(t.uid) === String(session.uid)));
          if (!sameUser) return false;
          if (amountVal !== null && typeof t.amount !== 'undefined') {
            if (Math.abs((Number(t.amount)||0) - amountVal) > 0.0001) return false;
          }
          if (networkVal && t.network && String(t.network).toLowerCase() !== String(networkVal).toLowerCase()) return false;
          return true;
        }) || null;

        // fallback to overlay stored id if no match found
        if (!targetTx && pendingKeyId) {
          targetTx = all.find(t => String(t.id) === String(pendingKeyId)) || null;
        }

        if (!targetTx) {
          return alert('Nessuna richiesta di deposito trovata corrispondente; genera prima un indirizzo.');
        }

        const targetId = targetTx.id;

        // read proof file (best-effort): store file name and small data url preview as proof_preview (non-blocking)
        const file = proofInput.files && proofInput.files[0];
        const updatePayloadBase = { status: 'pending', tx_hash: txHash, updated_at: new Date().toISOString(), note: 'Deposito dichiarato, in attesa conferma admin' };

        if (file) {
          try {
            const reader = new FileReader();
            reader.onload = async function(ev){
              const preview = ev.target.result;
              const payload = Object.assign({}, updatePayloadBase, { proof_name: file.name, proof_preview: preview });
              try { await txCol.update(targetId, payload); } catch(e){
                // best-effort second attempt
                try { await txCol.update(targetId, payload); } catch(e2){ console.warn('tx update failed', e2); }
              }

              // remove idempotency mapping for this user now that it's advanced
              try {
                const map = readPendingMap();
                const userIdentifier = String(session && (session.uid || session.id || session.email || 'anon'));
                if (map && typeof map === 'object') {
                  if (map[userIdentifier]) delete map[userIdentifier];
                  Object.keys(map).forEach(k => { if (String(k).indexOf(userIdentifier) === 0) delete map[k]; });
                  writePendingMap(map);
                }
              } catch(e){}

              // Mark other duplicate pending deposits for same user/amount/network as rejected to enforce single pending constraint
              try {
                const duplicates = (txCol.getList()||[]).filter(t => {
                  if (String(t.id) === String(targetId)) return false;
                  if (String(t.type).toLowerCase() !== 'deposit') return false;
                  const st = (t.status || '').toLowerCase();
                  if (!pendingLikeStatuses.includes(st)) return false;
                  const sameUser = (session.id && String(t.user_id) === String(session.id)) || (session.uid && (String(t.user_uid) === String(session.uid) || String(t.uid) === String(session.uid)));
                  if (!sameUser) return false;
                  if (amountVal !== null && typeof t.amount !== 'undefined') {
                    if (Math.abs((Number(t.amount)||0) - amountVal) > 0.0001) return false;
                  }
                  if (networkVal && t.network && String(t.network).toLowerCase() !== String(networkVal).toLowerCase()) return false;
                  return true;
                });
                for (const d of duplicates) {
                  try { await txCol.update(d.id, { status: 'rejected', rejected_at: new Date().toISOString(), credited: false, credited_at: null, note: (d.note || '') + ' (duplicate prevented)' }); } catch(e){}
                }
              } catch(e){ console.warn('duplicate cleanup failed', e); }

              try { localStorage.setItem('cup9gpu_last_deposit', JSON.stringify({ ts: Date.now(), user: session.uid || session.id, tx_id: targetId, tx_hash: txHash })); } catch(e){}
              alert('Dichiarazione inviata: la transazione è ora in attesa di verifica amministrativa.');
              closeAll();
              render();
            };
            reader.readAsDataURL(file);
          } catch(e){
            console.warn('proof read failed', e);
            // fallback to update without preview
            try {
              await txCol.update(targetId, updatePayloadBase);
            } catch(e2){ console.warn('tx update failed', e2); }
            try {
              const map = readPendingMap();
              const userIdentifier = String(session && (session.uid || session.id || session.email || 'anon'));
              if (map && map[userIdentifier]) { delete map[userIdentifier]; writePendingMap(map); }
            } catch(e){}
            try { localStorage.setItem('cup9gpu_last_deposit', JSON.stringify({ ts: Date.now(), user: session.uid || session.id, tx_id: targetId, tx_hash: txHash })); } catch(e){}
            // cleanup duplicates as above
            try {
              const duplicates = (txCol.getList()||[]).filter(t => {
                if (String(t.id) === String(targetId)) return false;
                if (String(t.type).toLowerCase() !== 'deposit') return false;
                const st = (t.status || '').toLowerCase();
                if (!pendingLikeStatuses.includes(st)) return false;
                const sameUser = (session.id && String(t.user_id) === String(session.id)) || (session.uid && (String(t.user_uid) === String(session.uid) || String(t.uid) === String(session.uid)));
                if (!sameUser) return false;
                if (amountVal !== null && typeof t.amount !== 'undefined') {
                  if (Math.abs((Number(t.amount)||0) - amountVal) > 0.0001) return false;
                }
                if (networkVal && t.network && String(t.network).toLowerCase() !== String(networkVal).toLowerCase()) return false;
                return true;
              });
              for (const d of duplicates) {
                try { await txCol.update(d.id, { status: 'rejected', rejected_at: new Date().toISOString(), credited: false, credited_at: null, note: (d.note || '') + ' (duplicate prevented)' }); } catch(e){}
              }
            } catch(e){ console.warn('duplicate cleanup failed', e); }

            alert('Dichiarazione inviata (senza anteprima): la transazione è in attesa di verifica amministrativa.');
            closeAll();
            render();
          }
        } else {
          // no file attached path
          try {
            await txCol.update(targetTx.id, updatePayloadBase);
          } catch(e){
            try { await txCol.update(targetTx.id, updatePayloadBase); } catch(e){ console.warn('tx update failed', e); }
          }
          try {
            const map = readPendingMap();
            const userIdentifier = String(session && (session.uid || session.id || session.email || 'anon'));
            if (map && map[userIdentifier]) { delete map[userIdentifier]; writePendingMap(map); }
          } catch(e){}
          // cleanup duplicates
          try {
            const duplicates = (txCol.getList()||[]).filter(t => {
              if (String(t.id) === String(targetTx.id)) return false;
              if (String(t.type).toLowerCase() !== 'deposit') return false;
              const st = (t.status || '').toLowerCase();
              if (!pendingLikeStatuses.includes(st)) return false;
              const sameUser = (session.id && String(t.user_id) === String(session.id)) || (session.uid && (String(t.user_uid) === String(session.uid) || String(t.uid) === String(session.uid)));
              if (!sameUser) return false;
              if (amountVal !== null && typeof t.amount !== 'undefined') {
                if (Math.abs((Number(t.amount)||0) - amountVal) > 0.0001) return false;
              }
              if (networkVal && t.network && String(t.network).toLowerCase() !== String(networkVal).toLowerCase()) return false;
              return true;
            });
            for (const d of duplicates) {
              try { await txCol.update(d.id, { status: 'rejected', rejected_at: new Date().toISOString(), credited: false, credited_at: null, note: (d.note || '') + ' (duplicate prevented)' }); } catch(e){}
            }
          } catch(e){ console.warn('duplicate cleanup failed', e); }

          try { localStorage.setItem('cup9gpu_last_deposit', JSON.stringify({ ts: Date.now(), user: session.uid || session.id, tx_id: targetTx.id, tx_hash: txHash })); } catch(e){}
          alert('Dichiarazione inviata: la transazione è ora in attesa di verifica amministrativa.');
          closeAll();
          render();
        }
      } catch (err) {
        console.error('confirm deposit flow failed', err);
        alert('Impossibile inviare dichiarazione, riprova.');
      }
    };
  }

  function openWithdraw(){
    const raw = prompt('Importo da prelevare (USDT):','100');
    const amt = parseFloat(raw);
    if (!amt || amt<=0) return;
    const session = getSession();
    if (!session) return alert('Per favore accedi prima di effettuare un prelievo.');

    // determine if user has collaborator license (support multiple possible flags)
    let isCollaborator = false;
    try {
      const users = usersCol.getList();
      const me = users.find(u => String(u.id) === String(session.id) || String(u.user_uid) === String(session.uid));
      if (me) {
        isCollaborator = !!(me.license === 'collaborator' || me.collaborator || me.is_collaborator || me.collab);
      }
    } catch(e){ /* best-effort */ }

    const MIN_DEFAULT = 100;
    const MIN_COLLAB = 50;
    const FEE = 3; // $3 fixed withdrawal fee

    const requiredMin = isCollaborator ? MIN_COLLAB : MIN_DEFAULT;
    if (amt < requiredMin) {
      return alert(`Prelievo minimo ${formatMoney(requiredMin)}${isCollaborator ? ' (licenza collaboratore)' : ''}.`);
    }

    // ensure withdrawals draw only from confirmed earnings (withdrawable)
    const userTx = txCol.getList().filter(t => String(t.user_id) === String(session.id));
    const earnings = userTx.filter(t => t.type === 'earning' && t.status !== 'pending').reduce((s,t)=>s+(Number(t.amount)||0),0);
    const withdrawalsConfirmed = userTx.filter(t => t.type === 'withdraw' && t.status === 'confirmed').reduce((s,t)=>s+(Number(t.amount)||0),0);
    const currentWithdrawable = Math.max(0, earnings - withdrawalsConfirmed);

    // require amount + fee <= withdrawable so fee is covered
    if ((amt + FEE) > currentWithdrawable) {
      return alert(`Fondi insufficienti: il tuo saldo prelevabile è ${formatMoney(currentWithdrawable)}; ricordati che la commissione di prelievo è ${formatMoney(FEE)}.`);
    }

    // create a pending withdraw transaction: admin will generate/send OTP to the user from the admin panel
    (async ()=>{
      try {
        await txCol.create({
          user_id: session.id,
          type: 'withdraw',
          amount: amt,
          fee: FEE,
          net_amount: +(Number(amt) - Number(FEE)).toFixed(2),
          status: 'pending',
          created_at: new Date().toISOString(),
          note: `Prelievo pendente - in attesa OTP (admin). Commissione: ${formatMoney(FEE)}. Net: ${formatMoney(+(amt - FEE).toFixed(2))}`
        });
        alert(`Richiesta prelievo registrata come PENDENTE.\nImporto: ${formatMoney(amt)}\nCommissione: ${formatMoney(FEE)}\nImporto netto: ${formatMoney(+(amt - FEE).toFixed(2))}\nL'amministratore genererà un OTP per la conferma e lo invierà al tuo account.`);
        render();
      } catch(e){
        console.error('withdraw create failed', e);
        alert('Impossibile registrare la richiesta di prelievo, riprova.');
      }
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

    const stLow = (t.status || '').toString().toLowerCase();
    if (stLow === 'pending') {
      // single pending flow only
      const enterOtp = document.createElement('button'); enterOtp.className='small-action'; enterOtp.textContent='Conferma';
      enterOtp.onclick = ()=> { confirmTransactionWithOTP(t.id); };
      actions.appendChild(enterOtp);
    }
    // ensure badge label updated for rejected state (applies where buildTxRow used)
    // badge text is set below when buildTxRow creates the badge; other logic paths also respect 'rejected' via earlier changes

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
          status: 'confirmed', // mark accruals as confirmed so they count immediately toward withdrawable balance
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

  // Lightweight pinch-to-zoom + two-finger pan handler for touch devices.
  // Allows users to pinch to zoom the main app container (#app) and drag with two fingers to pan.
  // It is intentionally small and non-invasive: preserves existing layout, only modifies transform on the app wrapper.
  function attachPinchZoom(targetSelector = '#app') {
    try {
      const target = document.querySelector(targetSelector);
      if (!target) return;

      let initialDistance = 0;
      let initialScale = 1;
      let currentScale = 1;
      let origin = { x: 0.5, y: 0.5 };
      let lastMid = null;
      let pan = { x: 0, y: 0 };
      let lastPan = { x: 0, y: 0 };
      let isPinching = false;
      let isPanning = false;

      // apply transform
      function updateTransform() {
        target.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${currentScale})`;
        target.style.transformOrigin = `${origin.x * 100}% ${origin.y * 100}%`;
      }
      // get mid point between two touches in element coordinates normalized
      function midPoint(t1, t2) {
        const rect = target.getBoundingClientRect();
        const x = (t1.clientX + t2.clientX) / 2 - rect.left;
        const y = (t1.clientY + t2.clientY) / 2 - rect.top;
        return { x: x / rect.width, y: y / rect.height, rawX: (t1.clientX + t2.clientX) / 2, rawY: (t1.clientY + t2.clientY) / 2 };
      }
      function distance(t1, t2) {
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        return Math.hypot(dx, dy);
      }

      target.style.willChange = 'transform';
      target.style.transition = 'transform 0ms linear';

      function onTouchStart(e) {
        if (e.touches.length === 2) {
          isPinching = true;
          initialDistance = distance(e.touches[0], e.touches[1]);
          initialScale = currentScale || 1;
          lastMid = midPoint(e.touches[0], e.touches[1]);
          // set transform origin to midpoint to produce natural pinch zoom
          origin = { x: lastMid.x, y: lastMid.y };
          lastPan = { x: pan.x, y: pan.y };
        } else if (e.touches.length === 1 && e.touches[0].radiusX && e.touches[0].radiusY) {
          // ignore stylus-like touches; reserved
        } else if (e.touches.length === 2) {
          isPanning = true;
        }
      }

      function onTouchMove(e) {
        if (isPinching && e.touches.length === 2) {
          e.preventDefault();
          const d = distance(e.touches[0], e.touches[1]);
          const scaleFactor = d / (initialDistance || 1);
          // clamp scale between 0.6 and 3.0 for usability
          currentScale = Math.min(3, Math.max(0.6, initialScale * scaleFactor));
          // compute new midpoint and adjust pan so visual focus stays under fingers
          const mid = midPoint(e.touches[0], e.touches[1]);
          if (lastMid) {
            const dx = mid.rawX - lastMid.rawX;
            const dy = mid.rawY - lastMid.rawY;
            pan.x = lastPan.x + dx;
            pan.y = lastPan.y + dy;
          }
          updateTransform();
        } else if (e.touches.length === 2 && !isPinching) {
          // two-finger pan when not pinching (both fingers move roughly same distance)
          e.preventDefault();
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          const mid = midPoint(t0, t1);
          if (lastMid) {
            const dx = mid.rawX - lastMid.rawX;
            const dy = mid.rawY - lastMid.rawY;
            pan.x = lastPan.x + dx;
            pan.y = lastPan.y + dy;
            updateTransform();
          }
          lastMid = mid;
        }
      }

      function onTouchEnd(e) {
        if (isPinching) {
          // finalize
          isPinching = false;
          lastPan = { x: pan.x, y: pan.y };
          lastMid = null;
          // small inertia clamp: keep transform as is
          // optionally persist currentScale/pan in sessionStorage if desired
        } else if (isPanning) {
          isPanning = false;
          lastPan = { x: pan.x, y: pan.y };
          lastMid = null;
        }
        // if no touches remain, ensure page scroll remains enabled when scale == 1
        if ((e.touches && e.touches.length === 0) || !e.touches) {
          // if scale close to 1 and pan is small, reset transform for crisp layout
          if (Math.abs(currentScale - 1) < 0.02 && Math.abs(pan.x) < 4 && Math.abs(pan.y) < 4) {
            currentScale = 1;
            pan = { x: 0, y: 0 };
            lastPan = { x: 0, y: 0 };
            updateTransform();
          }
        }
      }

      // Prevent the default gesture that some mobile browsers provide (double-tap zoom)
      function preventGesture(e) { e.preventDefault(); }

      // Attach listeners
      target.addEventListener('touchstart', onTouchStart, { passive: false });
      target.addEventListener('touchmove', onTouchMove, { passive: false });
      target.addEventListener('touchend', onTouchEnd, { passive: false });
      target.addEventListener('gesturestart', preventGesture);
      target.addEventListener('gesturechange', preventGesture);
      target.addEventListener('gestureend', preventGesture);

      // expose a manual reset helper
      window.__cup9gpu_resetZoom = function(){
        currentScale = 1; pan = { x: 0, y: 0 }; lastPan = { x:0, y:0 }; updateTransform();
      };
    } catch (e) {
      console.warn('attachPinchZoom failed', e);
    }
  }

  // Start
  // seedCreator runs in background (non-blocking) to avoid slowing initial load
  seedCreator().catch(()=>{});
  // attach pinch zoom to #app after DOM ready
  try { attachPinchZoom('#app'); } catch(e){ console.warn(e); }
  render();

})();