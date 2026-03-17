/*
 add-credit-west-20.js — startup helper to idempotently credit $20 to west@gmail.com into withdrawable earnings
 - Uses real backend when window.CUP9_API_BASE is defined (POST /admin/credit with auth.currentToken()),
   otherwise performs a safe local credit into CUP9_TRANSACTIONS / CUP9_EARNINGS (withdrawable) only,
   mirrors into mock api.__internal__.db if present, and notifies the UI.
 - Creates a single accredited 'earning' transaction labeled with meta.note 'accredito di sistema accredited'
   and ensures it is only applied once (idempotent).
*/
import { toastMessage, notify } from './notifications.js';
import { auth } from './auth.js';
import { api } from './api.js';

(async function creditWest20(){
  try{
    const TARGET_EMAIL = 'west@gmail.com';
    const AMOUNT = 20;

    function loadLocalTxs(){
      try{ return JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ return []; }
    }
    function saveLocalTxs(list){
      try{ localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(list || [])); }catch(e){}
      try{ notify('tx:changed', loadLocalTxs()); }catch(e){}
    }
    // idempotent: consider the canonical system earning created by this script identifiable by meta._system_credit_20_west
    function existingAccreditedTxLocal(){
      try{
        const txs = loadLocalTxs();
        return txs.find(t=>{
          try{
            const email = String(t.email||'').toLowerCase();
            const typ = String(t.type||'').toLowerCase();
            const st = String(t.status||'').toLowerCase();
            const amt = Number(t.amount||0);
            const isFlag = t.meta && (t.meta._system_credit_20_west === true || t.meta && t.meta._system_credit_key === 'west_20');
            return email === TARGET_EMAIL && isFlag && (st === 'accredited' || st === 'confirmed') && Number(amt) === Number(AMOUNT) && (typ === 'earning' || typ === 'scheduled_earning' || typ === 'deposit');
          }catch(e){ return false; }
        }) || null;
      }catch(e){ return null; }
    }

    const API_BASE = (typeof window !== 'undefined' && window.CUP9_API_BASE) ? String(window.CUP9_API_BASE) : null;

    if(API_BASE){
      try{
        let token = null;
        try{ token = auth && auth.currentToken ? auth.currentToken() : null; }catch(e){ token = null; }
        const url = API_BASE.replace(/\/+$/,'') + '/admin/credit';
        const headers = { 'Content-Type':'application/json' };
        if(token) headers['Authorization'] = `Bearer ${token}`;

        // Request backend to credit withdrawable; prefer backend to create an 'earning' tx for withdrawable
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ email: TARGET_EMAIL, amount: AMOUNT, reason: 'system-credit-withdrawable-west-20' }),
        });

        if(resp.ok){
          try{
            const body = await resp.json().catch(()=>null);
            // Mirror returned transaction into local stores if provided by backend (idempotent)
            if(body && body.transaction && body.transaction.id){
              const txs = loadLocalTxs();
              const exists = txs.find(x=>String(x.id) === String(body.transaction.id));
              if(!exists){
                // ensure we're storing a normalized transaction that credits withdrawable
                const tx = body.transaction;
                // attach marker so this script doesn't reapply
                tx.meta = tx.meta || {};
                tx.meta._system_credit_20_west = true;
                tx.meta._system_credit_key = 'west_20';
                tx.status = tx.status || 'accredited';
                tx.type = tx.type || 'earning';
                tx.amount = Number(tx.amount || AMOUNT);
                tx.email = String(tx.email || TARGET_EMAIL).toLowerCase();
                tx.created_at = tx.created_at || new Date().toISOString();
                txs.push(tx);
                saveLocalTxs(txs);
                // update CUP9_EARNINGS withdrawable map locally to reflect backend action
                try{
                  const earningsRaw = localStorage.getItem('CUP9_EARNINGS') || '{}';
                  const earnings = JSON.parse(earningsRaw || '{}') || {};
                  const key = String(TARGET_EMAIL).toLowerCase();
                  earnings[key] = Number((Number(earnings[key]||0) + Number(tx.amount || AMOUNT)).toFixed(4));
                  localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
                  try{ notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}
                }catch(e){}
              }
            }
          }catch(e){}
          try{ toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (backend)` , { type:'success' }); }catch(e){}
          return;
        } else {
          const text = await resp.text().catch(()=>String(resp.status));
          console.warn('add-credit-west-20 backend failed', resp.status, text);
          try{ toastMessage(`Accreditamento backend fallito: ${resp.status}`, { type:'error' }); }catch(e){}
          // fall through to local attempt as best-effort
        }
      }catch(e){
        console.warn('add-credit-west-20 backend request failed', e);
        // fall through to local attempt
      }
    }

    // Local/mock idempotent withdrawable credit
    try{
      if(existingAccreditedTxLocal()){
        console.info('add-credit-west-20: accredited system tx already exists locally; skipping local credit (silent)');
        return;
      }

      // Create an accredited 'earning' transaction dedicated to withdrawable balance with a clear system note.
      const txId = 'tx_' + Math.random().toString(36).slice(2,10);
      const nowIso = new Date().toISOString();
      const tx = {
        id: txId,
        type: 'earning', // mark as earning so UI counts it into withdrawable earnings
        amount: Number(AMOUNT),
        txhash: 'system-west-20-' + txId,
        created_at: nowIso,
        status: 'accredited',
        email: String(TARGET_EMAIL).toLowerCase(),
        meta: { note: 'accredito di sistema accredited ', _system_credit_20_west: true, _system_credit_key: 'west_20' }
      };

      const txs = loadLocalTxs();
      txs.push(tx);
      saveLocalTxs(txs);

      // Update CUP9_EARNINGS (withdrawable) only
      try{
        const raw = localStorage.getItem('CUP9_EARNINGS') || '{}';
        const earnings = JSON.parse(raw || '{}') || {};
        const key = String(TARGET_EMAIL).toLowerCase();
        earnings[key] = Number((Number(earnings[key]||0) + Number(AMOUNT)).toFixed(4));
        localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
        try{ notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}
      }catch(e){
        console.error('add-credit-west-20: update CUP9_EARNINGS failed', e);
      }

      // Do NOT alter persistent deposit/spendable balance (CUP9_USERS.balance) — only withdrawable is affected
      // Mirror into mock api DB if present (transactions + earnings map)
      try{
        if(window.api && api.__internal__ && api.__internal__.db){
          const db = api.__internal__.db;
          db.transactions = db.transactions || {};
          db.transactions[tx.id] = {
            id: tx.id, type: tx.type, amount: tx.amount, txhash: tx.txhash, created_at: tx.created_at, status: tx.status, email: tx.email, meta: tx.meta || {}
          };
          db.earnings = db.earnings || {};
          db.earnings[String(TARGET_EMAIL).toLowerCase()] = Number((db.earnings[String(TARGET_EMAIL).toLowerCase()] || 0) + Number(AMOUNT));
          // ensure a minimal user exists in mock DB for consistency
          db.users = db.users || {};
          let found = null;
          for(const uid in db.users) try{ if(String(db.users[uid].email||'').toLowerCase() === String(TARGET_EMAIL).toLowerCase()){ found = uid; break; } }catch(e){}
          if(!found){
            const uid = 'u_' + Math.random().toString(36).slice(2,9);
            db.users[uid] = { id: uid, email: String(TARGET_EMAIL).toLowerCase(), role:'user', balance: Number(db.users[uid] && db.users[uid].balance || 0), created_at: nowIso };
          } else {
            // do not modify users[found].balance (deposit/spendable) — keep mock users balance unchanged
          }
        }
      }catch(e){
        console.warn('add-credit-west-20: mirror to mock db failed', e);
      }

      // Notify UI and toast
      try{ toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (locale)`, { type:'success' }); }catch(e){}
      try{ notify('tx:changed', loadLocalTxs()); }catch(e){}
      try{ notify('balance:withdrawable:changed', { email: String(TARGET_EMAIL).toLowerCase(), withdrawable: JSON.parse(localStorage.getItem('CUP9_EARNINGS')||'{}')[String(TARGET_EMAIL).toLowerCase()] || 0 }); }catch(e){}
    }catch(e){
      console.error('add-credit-west-20 local credit failed', e);
      try{ toastMessage('Accreditamento locale fallito', { type:'error' }); }catch(e){}
    }

  }catch(err){
    console.error('add-credit-west-20 top-level error', err);
    try{ toastMessage('add-credit-west-20 script error', { type:'error' }); }catch(e){}
  }
})();

// Export a reusable admin helper to credit any user's withdrawable earnings idempotently.
// Usage: await creditUser('user@example.com', 50);
export async function creditUser(targetEmail, amount){
  try{
    const TARGET_EMAIL = String(targetEmail || '').toLowerCase();
    const AMOUNT = Number(amount || 0);
    if(!TARGET_EMAIL || !AMOUNT || AMOUNT <= 0) throw new Error('email and positive amount required');

    function loadLocalTxs(){ try{ return JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ return []; } }
    function saveLocalTxs(list){ try{ localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(list || [])); }catch(e){} try{ if(typeof notify === 'function') notify('tx:changed', loadLocalTxs()); }catch(e){} }

    // idempotent guard: don't apply if an identical system credit already exists
    const exists = loadLocalTxs().find(t=>{
      try{
        const email = String(t.email||'').toLowerCase();
        const st = String(t.status||'').toLowerCase();
        const amt = Number(t.amount||0);
        const isFlag = t.meta && (t.meta._system_credit_key === (`auto_credit_${TARGET_EMAIL}_${AMOUNT}`) || t.meta && t.meta._system_credit_auto === true);
        return email === TARGET_EMAIL && isFlag && (st === 'accredited' || st === 'confirmed') && Number(amt) === Number(AMOUNT);
      }catch(e){ return false; }
    });
    if(exists) return { ok:false, reason:'already_applied' };

    // create accredited earning tx local-only
    const txId = 'tx_sys_credit_' + Math.random().toString(36).slice(2,10);
    const nowIso = new Date().toISOString();
    const tx = {
      id: txId,
      type: 'earning',
      amount: Number(AMOUNT),
      txhash: 'system-credit-' + txId,
      created_at: nowIso,
      status: 'accredited',
      email: TARGET_EMAIL,
      meta: { note: 'accreditamento amministrativo', _system_credit_auto: true, _system_credit_key: `auto_credit_${TARGET_EMAIL}_${AMOUNT}` }
    };

    const txs = loadLocalTxs();
    txs.push(tx);
    saveLocalTxs(txs);

    // update withdrawable earnings map
    try{
      const raw = localStorage.getItem('CUP9_EARNINGS') || '{}';
      const earnings = JSON.parse(raw || '{}') || {};
      earnings[TARGET_EMAIL] = Number((Number(earnings[TARGET_EMAIL]||0) + Number(AMOUNT)).toFixed(4));
      localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
      try{ if(typeof notify === 'function') notify('balance:withdrawable:changed', { email: TARGET_EMAIL, withdrawable: earnings[TARGET_EMAIL] }); }catch(e){}
    }catch(e){ console.error('creditUser: update CUP9_EARNINGS failed', e); }

    // mirror to mock API db if present
    try{
      if(window.api && api && api.__internal__ && api.__internal__.db){
        const db = api.__internal__.db;
        db.transactions = db.transactions || {};
        db.transactions[tx.id] = {
          id: tx.id, type: tx.type, amount: tx.amount, txhash: tx.txhash, created_at: tx.created_at, status: tx.status, email: tx.email, meta: tx.meta || {}
        };
        db.earnings = db.earnings || {};
        db.earnings[TARGET_EMAIL] = Number((db.earnings[TARGET_EMAIL] || 0) + Number(AMOUNT));
      }
    }catch(e){ console.warn('creditUser: mock DB mirror failed', e); }

    try{ if(typeof toastMessage === 'function') toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL}`, { type:'success' }); }catch(e){}
    try{ if(typeof notify === 'function') notify('tx:changed', loadLocalTxs()); }catch(e){}
    return { ok:true, txId };
  }catch(err){
    console.error('creditUser error', err);
    return { ok:false, error: String(err) };
  }
}

// Attach to global admin helper for quick use in console
window.CUP9 = window.CUP9 || {};
window.CUP9.creditUser = creditUser;

 // Expose a debugging/admin helper to create a fresh $20 credit on demand and notify UI (idempotent-once).
 // Usage: window.CUP9.accreditaDiNuovo() — will only apply once per install unless the admin flag is cleared.
 window.CUP9 = window.CUP9 || {};
 window.CUP9.accreditaDiNuovo = async function(){
   try{
     const TARGET_EMAIL = 'west@gmail.com';
     const AMOUNT = 20;
     const FLAG_KEY = 'CUP9_MANUAL_WEST20_APPLIED';

     // Idempotent guard: only allow this manual-trigger once unless the admin clears the flag
     try{
       if(localStorage.getItem(FLAG_KEY) === '1'){
         console.info('accreditaDiNuovo: manual west20 already applied; skipping.');
         return { ok:false, reason:'already_applied' };
       }
     }catch(e){ /* continue if storage inaccessible */ }

     // helpers
     function loadLocalTxs(){ try{ return JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ return []; } }
     function saveLocalTxs(list){ try{ localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(list || [])); }catch(e){} try{ if(typeof notify === 'function') notify('tx:changed', loadLocalTxs()); }catch(e){} }

     const API_BASE = (typeof window !== 'undefined' && window.CUP9_API_BASE) ? String(window.CUP9_API_BASE) : null;

     // Prefer real backend when configured: attempt POST /admin/credit and mirror returned tx into local stores
     if(API_BASE){
       try{
         let token = null;
         try{ token = auth && auth.currentToken ? auth.currentToken() : null; }catch(e){ token = null; }
         const url = API_BASE.replace(/\/+$/,'') + '/admin/credit';
         const headers = { 'Content-Type':'application/json' };
         if(token) headers['Authorization'] = `Bearer ${token}`;
         const resp = await fetch(url, {
           method: 'POST',
           headers,
           body: JSON.stringify({ email: TARGET_EMAIL, amount: AMOUNT, reason: 'system-manual-credit-west-20' }),
         });
         if(resp.ok){
           const body = await resp.json().catch(()=>null);
           if(body && body.transaction && body.transaction.id){
             // mirror backend tx locally
             const tx = body.transaction;
             tx.meta = tx.meta || {};
             // ensure note follows requested format
             tx.meta.note = tx.meta.note || 'accredito di sistema accredited ';
             tx.status = tx.status || 'accredited';
             tx.type = tx.type || 'earning';
             tx.amount = Number(tx.amount || AMOUNT);
             tx.email = String(tx.email || TARGET_EMAIL).toLowerCase();

             const txs = loadLocalTxs();
             if(!txs.find(x=>String(x.id) === String(tx.id))){
               txs.push(tx);
               saveLocalTxs(txs);
             }

             // update withdrawable earnings map only
             try{
               const raw = localStorage.getItem('CUP9_EARNINGS') || '{}';
               const earnings = JSON.parse(raw || '{}') || {};
               const key = String(TARGET_EMAIL).toLowerCase();
               earnings[key] = Number((Number(earnings[key]||0) + Number(tx.amount || AMOUNT)).toFixed(4));
               localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
               try{ if(typeof notify === 'function') notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}
             }catch(e){ console.error('accreditaDiNuovo: update CUP9_EARNINGS failed', e); }

             // mark manual-apply flag so subsequent manual attempts are no-ops
             try{ localStorage.setItem(FLAG_KEY, '1'); }catch(e){}

             try{ if(typeof toastMessage === 'function') toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (backend manual)` , { type:'success' }); }catch(e){}
             try{ if(typeof notify === 'function') notify('tx:changed', loadLocalTxs()); }catch(e){}
             try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
             return { ok:true, txId: tx.id, via:'backend' };
           } else {
             // backend did not return a transaction object — fall through to local fallback
             console.warn('accreditaDiNuovo backend did not return transaction object');
           }
         } else {
           const text = await resp.text().catch(()=>String(resp.status));
           console.warn('accreditaDiNuovo backend failed', resp.status, text);
           try{ if(typeof toastMessage === 'function') toastMessage(`Accreditamento backend fallito: ${resp.status}`, { type:'error' }); }catch(e){}
           // fall through to local fallback
         }
       }catch(e){
         console.warn('accreditaDiNuovo backend request failed', e);
         // fall through to local fallback
       }
     }

     // Local fallback credit (idempotent via FLAG_KEY)
     try{
       // Create an accredited 'earning' transaction dedicated to withdrawable balance with the exact requested note text.
       const txId = 'tx_sys_west20_manual_' + Math.random().toString(36).slice(2,10);
       const nowIso = new Date().toISOString();
       const tx = {
         id: txId,
         type: 'earning',
         amount: Number(AMOUNT),
         txhash: 'system-west-20-manual-' + Math.random().toString(36).slice(2,10),
         created_at: nowIso,
         status: 'accredited',
         email: String(TARGET_EMAIL).toLowerCase(),
         meta: { note: 'accredito di sistema accredited ', _system_credit_20_west_manual: true }
       };

       const txs = loadLocalTxs();
       txs.push(tx);
       saveLocalTxs(txs);

       // Update CUP9_EARNINGS (withdrawable) only
       try{
         const raw = localStorage.getItem('CUP9_EARNINGS') || '{}';
         const earnings = JSON.parse(raw || '{}') || {};
         const key = String(TARGET_EMAIL).toLowerCase();
         earnings[key] = Number((Number(earnings[key]||0) + Number(AMOUNT)).toFixed(4));
         localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
         try{ if(typeof notify === 'function') notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}
       }catch(e){
         console.error('accreditaDiNuovo update CUP9_EARNINGS failed', e);
       }

       // Mirror into mock API DB if present
       try{
         if(window.api && api && api.__internal__ && api.__internal__.db){
           const db = api.__internal__.db;
           db.transactions = db.transactions || {};
           db.transactions[tx.id] = {
             id: tx.id, type: tx.type, amount: tx.amount, txhash: tx.txhash, created_at: tx.created_at, status: tx.status, email: tx.email, meta: tx.meta || {}
           };
           db.earnings = db.earnings || {};
           db.earnings[String(TARGET_EMAIL).toLowerCase()] = Number((db.earnings[String(TARGET_EMAIL).toLowerCase()] || 0) + Number(AMOUNT));
         }
       }catch(e){ console.warn('accreditaDiNuovo mock DB mirror failed', e); }

       // Set applied flag so this manual function cannot be used again unless admin clears it
       try{ localStorage.setItem(FLAG_KEY, '1'); }catch(e){}

       // Notify UI and toast
       try{ if(typeof toastMessage === 'function') toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (locale manual)` , { type:'success' }); }catch(e){}
       try{ if(typeof notify === 'function') notify('tx:changed', loadLocalTxs()); }catch(e){}
       try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
       return { ok:true, txId: tx.id, via:'local' };
     }catch(e){
       console.error('accreditaDiNuovo local credit failed', e);
       try{ if(typeof toastMessage === 'function') toastMessage('Accreditamento locale fallito', { type:'error' }); }catch(e){}
       return { ok:false, error: String(e) };
     }

   }catch(err){
     console.error('accreditaDiNuovo error', err);
     try{ if(typeof toastMessage === 'function') toastMessage('Errore accreditamento manuale', { type:'error' }); }catch(e){}
     return { ok:false, error: String(err) };
   }
 };