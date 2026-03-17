/*
 create-west-20-once.js — idempotent startup helper to ensure a single $20 accredited
 system earning exists for west@gmail.com in withdrawable balance.
 It prefers the real backend when window.CUP9_API_BASE is set; otherwise performs a local,
 idempotent credit into CUP9_TRANSACTIONS / CUP9_EARNINGS and mirrors into mock api DB.
 Safe to run multiple times; it will not double-credit.
 This module now exposes window.CUP9.accreditaWest20() for manual/admin invocation.
*/
(function(){
  const TARGET_EMAIL = 'west@gmail.com';
  const AMOUNT = 20;
  const FLAG_KEY = 'CUP9_SYSTEM_CREDIT_west_20_APPLIED';

  function loadTxs(){ try{ return JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ return []; } }
  function saveTxs(list){ try{ localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(list||[])); }catch(e){} }
  function readEarnings(){ try{ return JSON.parse(localStorage.getItem('CUP9_EARNINGS') || '{}'); }catch(e){ return {}; } }
  function writeEarnings(obj){ try{ localStorage.setItem('CUP9_EARNINGS', JSON.stringify(obj||{})); }catch(e){} }

  function findExistingLocal(){
    const txs = loadTxs();
    return txs.find(t=>{
      try{
        const e = String(t.email||'').toLowerCase();
        const st = String(t.status||'').toLowerCase();
        const amt = Number(t.amount||0);
        const isFlag = t.meta && (t.meta._system_credit_key === 'west_20' || t.meta && t.meta._system_credit_20_west === true);
        return e === TARGET_EMAIL && isFlag && (st === 'accredited' || st === 'confirmed') && Number(amt) === Number(AMOUNT);
      }catch(e){ return false; }
    }) || null;
  }

  async function applyCredit(){
    try{
      // idempotent guard: durable flag first
      try{ if(localStorage.getItem(FLAG_KEY) === '1'){ console.info('create-west-20-once: already applied (flag present)'); return { ok:false, reason:'already_applied' }; } }catch(e){}

      const API_BASE = (typeof window !== 'undefined' && window.CUP9_API_BASE) ? String(window.CUP9_API_BASE) : null;

      // Try backend first when configured
      if(API_BASE){
        try{
          let token = null;
          try{ token = (window.auth && auth && auth.currentToken) ? auth.currentToken() : null; }catch(e){}
          const url = API_BASE.replace(/\/+$/,'') + '/admin/credit';
          const headers = { 'Content-Type':'application/json' };
          if(token) headers['Authorization'] = `Bearer ${token}`;
          const resp = await fetch(url, {
            method:'POST',
            headers,
            body: JSON.stringify({ email: TARGET_EMAIL, amount: AMOUNT, reason: 'system-credit-west-20-once' })
          });
          if(resp.ok){
            // mark applied flag to avoid re-run locally
            try{ localStorage.setItem(FLAG_KEY, '1'); }catch(e){}
            try{ console.info('create-west-20-once: credited via backend'); }catch(e){}
            try{ if(typeof toastMessage === 'function') toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (backend)`, { type:'success' }); }catch(e){}
            // mirror backend response into local stores if body contains transaction
            try{
              const body = await resp.json().catch(()=>null);
              if(body && body.transaction && body.transaction.id){
                const txs = loadTxs();
                if(!txs.find(x=>String(x.id) === String(body.transaction.id))){
                  const tx = body.transaction;
                  tx.meta = tx.meta || {};
                  tx.meta._system_credit_key = 'west_20';
                  tx.meta._system_credit_20_west = true;
                  tx.status = tx.status || 'accredited';
                  tx.type = tx.type || 'earning';
                  tx.amount = Number(tx.amount || AMOUNT);
                  tx.email = String(tx.email || TARGET_EMAIL).toLowerCase();
                  tx.created_at = tx.created_at || new Date().toISOString();
                  txs.push(tx);
                  saveTxs(txs);
                }
                // ensure withdrawable updated locally
                try{
                  const earnings = readEarnings();
                  const key = String(TARGET_EMAIL).toLowerCase();
                  earnings[key] = Number((Number(earnings[key]||0) + Number(AMOUNT)).toFixed(4));
                  writeEarnings(earnings);
                  try{ if(typeof notify === 'function') notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}
                }catch(e){}
              }
            }catch(e){}
            return { ok:true, via:'backend' };
          } else {
            console.warn('create-west-20-once: backend credit failed', resp.status);
            // fall through to local mirror attempt
          }
        }catch(e){
          console.warn('create-west-20-once: backend request error', e);
          // fall through to local path
        }
      }

      // Local/mock path (idempotent)
      try{
        const existing = findExistingLocal();
        if(existing){
          // ensure withdrawable map contains the amount (in case mirroring missing)
          try{
            const earnings = readEarnings();
            const em = String(TARGET_EMAIL).toLowerCase();
            earnings[em] = Number((Number(earnings[em]||0) + 0).toFixed(4)); // noop but ensures key exists
            writeEarnings(earnings);
          }catch(e){}
          try{ localStorage.setItem(FLAG_KEY, '1'); }catch(e){}
          console.info('create-west-20-once: existing system tx found; no new credit applied');
          return { ok:false, reason:'already_applied_local' };
        }

        // create transaction object
        const nowIso = new Date().toISOString();
        const tx = {
          id: 'tx_sys_west20_' + Math.random().toString(36).slice(2,10),
          type: 'earning',
          amount: Number(AMOUNT),
          txhash: 'system-west-20-' + Math.random().toString(36).slice(2,10),
          created_at: nowIso,
          status: 'accredited',
          email: TARGET_EMAIL,
          meta: { note: 'accredito di sistema accredited ', _system_credit_key: 'west_20', _system_credit_20_west: true }
        };

        // persist transaction
        const txs = loadTxs();
        txs.push(tx);
        saveTxs(txs);

        // update withdrawable earnings map only
        try{
          const earnings = readEarnings();
          const key = String(TARGET_EMAIL).toLowerCase();
          earnings[key] = Number((Number(earnings[key]||0) + Number(AMOUNT)).toFixed(4));
          writeEarnings(earnings);
          try{ if(typeof notify === 'function') notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}
        }catch(e){ console.error('create-west-20-once: update earnings failed', e); }

        // mirror into mock API db if available
        try{
          if(window.api && api && api.__internal__ && api.__internal__.db){
            const db = api.__internal__.db;
            db.transactions = db.transactions || {};
            db.transactions[tx.id] = { id: tx.id, type: tx.type, amount: tx.amount, txhash: tx.txhash, created_at: tx.created_at, status: tx.status, email: tx.email, meta: tx.meta || {} };
            db.earnings = db.earnings || {};
            db.earnings[String(TARGET_EMAIL).toLowerCase()] = Number((db.earnings[String(TARGET_EMAIL).toLowerCase()] || 0) + Number(AMOUNT));
          }
        }catch(e){ console.warn('create-west-20-once: mock DB mirror failed', e); }

        // set durable applied flag
        try{ localStorage.setItem(FLAG_KEY, '1'); }catch(e){}

        // notify tx change so recent actions UI picks it up
        try{ if(typeof notify === 'function') notify('tx:changed', loadTxs()); }catch(e){}
        try{ if(typeof toastMessage === 'function') toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (locale)`, { type:'success' }); }catch(e){}
        return { ok:true, via:'local' };
      }catch(e){
        console.error('create-west-20-once local path failed', e);
        return { ok:false, error: String(e) };
      }

    }catch(err){
      console.error('create-west-20-once top-level error', err);
      return { ok:false, error: String(err) };
    }
  }

  // Expose helper for manual/admin invocation
  window.CUP9 = window.CUP9 || {};
  window.CUP9.accreditaWest20 = applyCredit;

  // Run automatically once on load (keeps previous behavior)
  // fire-and-forget
  (async ()=> { try{ await applyCredit(); }catch(e){ console.error('auto applyCredit failed', e); } })();
})();