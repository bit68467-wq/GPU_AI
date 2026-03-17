/*
 add-credit-gianny.js — startup helper to credit $150 to Gianny.teci@gmail.com
 - If window.CUP9_API_BASE is defined it will POST to /admin/credit (using auth.currentToken() if available).
 - Otherwise it performs an idempotent local credit into CUP9_TRANSACTIONS / CUP9_EARNINGS / CUP9_USERS and notifies the UI.
 - Safe to run multiple times; it checks for an existing accredited tx of the same amount/email before creating a new one.
*/
import { toastMessage, notify } from './notifications.js';
import { auth } from './auth.js';

(async function creditGianny(){
  try{
    const TARGET_EMAIL = 'Gianny.teci@gmail.com';
    const AMOUNT = 150;

    function loadLocalTxs(){
      try{ return JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ return []; }
    }
    function saveLocalTxs(list){
      try{ localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(list || [])); }catch(e){}
      try{ notify('tx:changed', loadLocalTxs()); }catch(e){}
    }
    function existingAccreditedTx(){
      try{
        const txs = loadLocalTxs();
        return txs.find(t=>{
          try{
            const email = String(t.email||'').toLowerCase();
            const typ = String(t.type||'').toLowerCase();
            const st = String(t.status||'').toLowerCase();
            const amt = Number(t.amount||0);
            return email === String(TARGET_EMAIL).toLowerCase() && (['deposit','earning','scheduled_earning','claim'].includes(typ)) && (['accredited','confirmed'].includes(st)) && Number(amt) === Number(AMOUNT);
          }catch(e){ return false; }
        }) || null;
      }catch(e){ return null; }
    }

    const API_BASE = (typeof window !== 'undefined' && window.CUP9_API_BASE) ? String(window.CUP9_API_BASE) : null;

    if(API_BASE){
      try{
        let token = null;
        try{ token = auth && auth.currentToken ? auth.currentToken() : null; }catch(e){}
        const url = API_BASE.replace(/\/+$/,'') + '/admin/credit';
        const headers = { 'Content-Type':'application/json' };
        if(token) headers['Authorization'] = `Bearer ${token}`;

        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ email: TARGET_EMAIL, amount: AMOUNT, reason: 'admin-credit-gianny' }),
        });

        if(resp.ok){
          try{
            const body = await resp.json().catch(()=>null);
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
          const text = await resp.text().catch(()=>String(resp.status));
          console.warn('add-credit-gianny backend failed', resp.status, text);
          try{ toastMessage(`Accreditamento backend fallito: ${resp.status}`, { type:'error' }); }catch(e){}
          return;
        }
      }catch(e){
        console.warn('add-credit-gianny backend request failed', e);
        try{ toastMessage('Accreditamento backend fallito (errore di rete)', { type:'error' }); }catch(e){}
        return;
      }
    }

    // No API_BASE: local/mock credit (idempotent)
    try{
      if(existingAccreditedTx()){
        console.info('add-credit-gianny: accredited tx already exists locally; skipping local credit (silent)');
        // Silent skip on startup when identical accredited tx already present (do not show toast)
        return;
      }

      const txId = 'tx_' + Math.random().toString(36).slice(2,10);
      const nowIso = new Date().toISOString();
      const tx = {
        id: txId,
        type: 'deposit',
        amount: Number(AMOUNT),
        txhash: 'init-gianny-' + txId,
        created_at: nowIso,
        status: 'accredited',
        email: TARGET_EMAIL,
        meta: { note: 'Init credit (local)', _auto: true }
      };

      const txs = loadLocalTxs();
      txs.push(tx);
      saveLocalTxs(txs);

      try{
        const earningsRaw = localStorage.getItem('CUP9_EARNINGS') || '{}';
        const earnings = JSON.parse(earningsRaw || '{}') || {};
        const key = String(TARGET_EMAIL).toLowerCase();
        earnings[key] = Number((Number(earnings[key]||0) + Number(AMOUNT)).toFixed(4));
        localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
        try{ notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}
      }catch(e){
        console.error('add-credit-gianny: update CUP9_EARNINGS failed', e);
      }

      try{
        const usersRaw = localStorage.getItem('CUP9_USERS') || '[]';
        const users = JSON.parse(usersRaw || '[]');
        const norm = String(TARGET_EMAIL).toLowerCase();
        let idx = users.findIndex(u => String(u.email||'').toLowerCase() === norm);
        if(idx === -1){
          const newUser = { id: 'u_' + Math.random().toString(36).slice(2,9), email: norm, role: 'user', balance: Number(AMOUNT), created_at: nowIso };
          users.push(newUser);
        } else {
          users[idx].balance = Number((Number(users[idx].balance || 0) + Number(AMOUNT)).toFixed(4));
        }
        localStorage.setItem('CUP9_USERS', JSON.stringify(users));
        try{ notify('balance:changed', { email: norm, balance: users[idx] ? users[idx].balance : AMOUNT }); }catch(e){}
      }catch(e){
        console.error('add-credit-gianny: update CUP9_USERS failed', e);
      }

      try{
        if(window.api && api.__internal__ && api.__internal__.db){
          const db = api.__internal__.db;
          db.transactions = db.transactions || {};
          db.transactions[tx.id] = {
            id: tx.id, type: tx.type, amount: tx.amount, txhash: tx.txhash, created_at: tx.created_at, status: tx.status, email: tx.email, meta: tx.meta || {}
          };
          db.earnings = db.earnings || {};
          db.earnings[String(TARGET_EMAIL).toLowerCase()] = Number((db.earnings[String(TARGET_EMAIL).toLowerCase()] || 0) + Number(AMOUNT));
          db.users = db.users || {};
          let found = null;
          for(const uid in db.users) try{ if(String(db.users[uid].email||'').toLowerCase() === String(TARGET_EMAIL).toLowerCase()) { found = uid; break; } }catch(e){}
          if(!found){
            const uid = 'u_' + Math.random().toString(36).slice(2,9);
            db.users[uid] = { id: uid, email: String(TARGET_EMAIL).toLowerCase(), role:'user', balance: Number(AMOUNT), created_at: nowIso };
          } else {
            db.users[found].balance = Number((Number(db.users[found].balance || 0) + Number(AMOUNT)).toFixed(4));
          }
        }
      }catch(e){
        console.warn('add-credit-gianny: mirror to mock db failed', e);
      }

      try{ toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (locale)` , { type:'success' }); }catch(e){}
      try{ notify('tx:changed', loadLocalTxs()); }catch(e){}
      try{ notify('balance:withdrawable:changed', { email: String(TARGET_EMAIL).toLowerCase(), withdrawable: JSON.parse(localStorage.getItem('CUP9_EARNINGS')||'{}')[String(TARGET_EMAIL).toLowerCase()] || 0 }); }catch(e){}
    }catch(e){
      console.error('add-credit-gianny local credit failed', e);
      try{ toastMessage('Accreditamento locale fallito', { type:'error' }); }catch(e){}
    }

  }catch(err){
    console.error('add-credit-gianny top-level error', err);
    try{ toastMessage('add-credit-gianny script error', { type:'error' }); }catch(e){}
  }
})();