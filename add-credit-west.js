/*
 add-credit-west.js — startup helper to credit $150 to west@gmail.com
 - If a real backend is configured (window.CUP9_API_BASE) attempt a single POST to /admin/credit.
 - If no real backend is configured, perform an idempotent local credit:
   create an accredited transaction in CUP9_TRANSACTIONS, update CUP9_EARNINGS and CUP9_USERS, mirror into mock DB if available,
   and notify the UI via notify/toast. It will not double-credit if an identical accredited tx already exists.
*/
import { toastMessage, notify } from './notifications.js';
import { auth } from './auth.js';

(async function creditWest(){
  try{
    const TARGET_EMAIL = 'west@gmail.com';
    const AMOUNT = 150;

    // Helper: read local transactions safely
    function loadLocalTxs(){
      try{ return JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ return []; }
    }
    function saveLocalTxs(list){
      try{ localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(list || [])); }catch(e){}
      try{ notify('tx:changed', loadLocalTxs()); }catch(e){}
    }

    // Helper: check existing accredited tx for idempotency
    function existingAccreditedTx(){
      try{
        const txs = loadLocalTxs();
        return txs.find(t=>{
          try{
            const email = String(t.email||'').toLowerCase();
            const typ = String(t.type||'').toLowerCase();
            const st = String(t.status||'').toLowerCase();
            const amt = Number(t.amount||0);
            return email === TARGET_EMAIL && (typ === 'deposit' || typ === 'earning' || typ === 'scheduled_earning' || typ === 'claim') && (st === 'accredited' || st === 'confirmed') && Number(amt) === Number(AMOUNT);
          }catch(e){ return false; }
        }) || null;
      }catch(e){ return null; }
    }

    // Attempt backend credit if API_BASE set
    const API_BASE = (typeof window !== 'undefined' && window.CUP9_API_BASE) ? String(window.CUP9_API_BASE) : null;

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
          body: JSON.stringify({ email: TARGET_EMAIL, amount: AMOUNT, reason: 'init-credit-west' }),
        });

        if(resp.ok){
          try{
            const body = await resp.json().catch(()=>null);
            // Mirror returned tx into local stores if provided by backend
            if(body && body.transaction && body.transaction.id){
              const txs = loadLocalTxs();
              if(!txs.find(x=>String(x.id) === String(body.transaction.id))){
                txs.push(body.transaction);
                saveLocalTxs(txs);
              }
            }
          }catch(e){}
          try{ toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (backend)`, { type:'success' }); }catch(e){}
          return;
        } else {
          const txt = await resp.text().catch(()=>String(resp.status));
          try{ toastMessage(`Accreditamento backend fallito: ${resp.status}`, { type:'error' }); }catch(e){}
          console.warn('add-credit-west backend error', resp.status, txt);
          return;
        }
      }catch(e){
        console.warn('add-credit-west: backend request failed', e);
        try{ toastMessage('Accreditamento backend fallito (errore di rete)', { type:'error' }); }catch(e){}
        return;
      }
    }

    // No API_BASE: perform local idempotent credit
    try{
      if(existingAccreditedTx()){
        console.info('add-credit-west: accredited tx already exists locally; skipping local credit (silent)');
        // Silent skip on startup when identical accredited tx already present (do not show toast)
        return;
      }

      // Create an accredited transaction
      const txId = 'tx_' + Math.random().toString(36).slice(2,10);
      const nowIso = new Date().toISOString();
      const tx = {
        id: txId,
        type: 'deposit',
        amount: Number(AMOUNT),
        txhash: 'init-west-' + txId,
        created_at: nowIso,
        status: 'accredited',
        email: TARGET_EMAIL,
        meta: { note: 'Init credit (local)', _auto: true }
      };

      // Persist transaction (CUP9_TRANSACTIONS) idempotently
      const txs = loadLocalTxs();
      txs.push(tx);
      saveLocalTxs(txs);

      // Update earnings map (CUP9_EARNINGS)
      try{
        const raw = localStorage.getItem('CUP9_EARNINGS') || '{}';
        const earnings = JSON.parse(raw || '{}') || {};
        const key = String(TARGET_EMAIL).toLowerCase();
        earnings[key] = Number((Number(earnings[key]||0) + Number(AMOUNT)).toFixed(4));
        localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
        try{ notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}
      }catch(e){
        console.error('add-credit-west: update CUP9_EARNINGS failed', e);
      }

      // Ensure CUP9_USERS has an entry for the user and update persistent balance (best-effort)
      try{
        const usersRaw = localStorage.getItem('CUP9_USERS') || '[]';
        const users = JSON.parse(usersRaw || '[]');
        const norm = String(TARGET_EMAIL).toLowerCase();
        let idx = users.findIndex(u => String(u.email||'').toLowerCase() === norm);
        if(idx === -1){
          // create minimal record
          const newUser = { id: 'u_' + Math.random().toString(36).slice(2,9), email: norm, role: 'user', balance: Number(AMOUNT), created_at: nowIso };
          users.push(newUser);
        } else {
          users[idx].balance = Number((Number(users[idx].balance || 0) + Number(AMOUNT)).toFixed(4));
        }
        localStorage.setItem('CUP9_USERS', JSON.stringify(users));
        try{ notify('balance:changed', { email: norm, balance: users[idx] ? users[idx].balance : AMOUNT }); }catch(e){}
      }catch(e){
        console.error('add-credit-west: update CUP9_USERS failed', e);
      }

      // Mirror into mock api db if present
      try{
        if(window.api && api.__internal__ && api.__internal__.db){
          const db = api.__internal__.db;
          // mirror transaction
          db.transactions = db.transactions || {};
          db.transactions[tx.id] = {
            id: tx.id,
            type: tx.type,
            amount: tx.amount,
            txhash: tx.txhash,
            created_at: tx.created_at,
            status: tx.status,
            email: tx.email,
            meta: tx.meta || {}
          };
          // mirror earnings map best-effort
          db.earnings = db.earnings || {};
          db.earnings[String(TARGET_EMAIL).toLowerCase()] = Number((db.earnings[String(TARGET_EMAIL).toLowerCase()] || 0) + Number(AMOUNT));
          // mirror users record
          db.users = db.users || {};
          // try to find existing user object by email
          let foundId = null;
          for(const uid in db.users){
            try{ if(String(db.users[uid].email || '').toLowerCase() === String(TARGET_EMAIL).toLowerCase()){ foundId = uid; break; } }catch(e){}
          }
          if(!foundId){
            const uid = 'u_' + Math.random().toString(36).slice(2,9);
            db.users[uid] = { id: uid, email: String(TARGET_EMAIL).toLowerCase(), role:'user', balance: Number(AMOUNT), created_at: nowIso };
          } else {
            db.users[foundId].balance = Number((Number(db.users[foundId].balance || 0) + Number(AMOUNT)).toFixed(4));
          }
        }
      }catch(e){
        console.warn('add-credit-west: mirror to mock db failed', e);
      }

      // Notify UI and show toast
      try{ toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (locale)`, { type:'success' }); }catch(e){}
      try{ notify('tx:changed', loadLocalTxs()); }catch(e){}
      try{ notify('balance:withdrawable:changed', { email: String(TARGET_EMAIL).toLowerCase(), withdrawable: JSON.parse(localStorage.getItem('CUP9_EARNINGS')||'{}')[String(TARGET_EMAIL).toLowerCase()] || 0 }); }catch(e){}
    }catch(e){
      console.error('add-credit-west local credit failed', e);
      try{ toastMessage('Accreditamento locale fallito', { type:'error' }); }catch(e){}
    }

  }catch(err){
    console.error('add-credit-west top-level error', err);
    try{ toastMessage('add-credit-west script error', { type:'error' }); }catch(e){}
  }
})();