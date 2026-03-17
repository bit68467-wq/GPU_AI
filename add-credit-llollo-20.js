/*
 add-credit-llollo-20.js — idempotent startup helper to credit $20 to llollo@gmail.com (withdrawable)
 - Prefers real backend when window.CUP9_API_BASE is set (POST /admin/credit).
 - Otherwise performs a safe local, idempotent credit into CUP9_TRANSACTIONS / CUP9_EARNINGS,
   mirrors into mock api.__internal__.db if present, and notifies the UI.
 - Creates a single accredited 'earning' transaction with meta.note 'accredito di sistema accredited '
   and ensures it is only applied once.
*/
import { toastMessage, notify } from './notifications.js';
import { auth } from './auth.js';
import { api } from './api.js';

(async function creditLlollo20(){
  try{
    const TARGET_EMAIL = 'llollo@gmail.com';
    const AMOUNT = 20;
    const FLAG_KEY = 'CUP9_SYSTEM_CREDIT_llollo_20_APPLIED';

    function loadLocalTxs(){
      try{ return JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ return []; }
    }
    function saveLocalTxs(list){
      try{ localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(list || [])); }catch(e){}
      try{ notify('tx:changed', loadLocalTxs()); }catch(e){}
    }
    function readEarnings(){ try{ return JSON.parse(localStorage.getItem('CUP9_EARNINGS') || '{}'); }catch(e){ return {}; } }
    function writeEarnings(obj){ try{ localStorage.setItem('CUP9_EARNINGS', JSON.stringify(obj||{})); }catch(e){} }

    // idempotent guard: check existing system-marked tx
    function existingAccreditedTxLocal(){
      try{
        const txs = loadLocalTxs();
        return txs.find(t=>{
          try{
            const email = String(t.email||'').toLowerCase();
            const st = String(t.status||'').toLowerCase();
            const amt = Number(t.amount||0);
            const isFlag = t.meta && (t.meta._system_credit_llollo_20 === true || t.meta && t.meta._system_credit_key === 'llollo_20');
            return email === TARGET_EMAIL && isFlag && (st === 'accredited' || st === 'confirmed') && Number(amt) === Number(AMOUNT);
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

        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ email: TARGET_EMAIL, amount: AMOUNT, reason: 'system-credit-llollo-20' }),
        });

        if(resp.ok){
          try{
            const body = await resp.json().catch(()=>null);
            if(body && body.transaction && body.transaction.id){
              const txs = loadLocalTxs();
              if(!txs.find(x=>String(x.id) === String(body.transaction.id))){
                const tx = body.transaction;
                tx.meta = tx.meta || {};
                tx.meta._system_credit_llollo_20 = true;
                tx.meta._system_credit_key = 'llollo_20';
                tx.status = tx.status || 'accredited';
                tx.type = tx.type || 'earning';
                tx.amount = Number(tx.amount || AMOUNT);
                tx.email = String(tx.email || TARGET_EMAIL).toLowerCase();
                tx.created_at = tx.created_at || new Date().toISOString();
                txs.push(tx);
                saveLocalTxs(txs);
              }
            }
          }catch(e){}
          try{ toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (backend)`, { type:'success' }); }catch(e){}
          try{ localStorage.setItem(FLAG_KEY, '1'); }catch(e){}
          return;
        } else {
          const text = await resp.text().catch(()=>String(resp.status));
          console.warn('add-credit-llollo-20 backend failed', resp.status, text);
          try{ toastMessage(`Accreditamento backend fallito: ${resp.status}`, { type:'error' }); }catch(e){}
        }
      }catch(e){
        console.warn('add-credit-llollo-20 backend request failed', e);
        try{ toastMessage('Accreditamento backend fallito (errore di rete)', { type:'error' }); }catch(e){}
      }
    }

    // Local/mock idempotent credit
    try{
      // durable flag guard
      try{ if(localStorage.getItem(FLAG_KEY) === '1'){ console.info('add-credit-llollo-20: already applied (flag)'); return; } }catch(e){}

      if(existingAccreditedTxLocal()){
        console.info('add-credit-llollo-20: accredited tx already exists locally; skipping local credit');
        try{ localStorage.setItem(FLAG_KEY, '1'); }catch(e){}
        return;
      }

      const txId = 'tx_' + Math.random().toString(36).slice(2,10);
      const nowIso = new Date().toISOString();
      const tx = {
        id: txId,
        type: 'earning',
        amount: Number(AMOUNT),
        txhash: 'system-llollo-20-' + txId,
        created_at: nowIso,
        status: 'accredited',
        email: String(TARGET_EMAIL).toLowerCase(),
        meta: { note: 'accredito di sistema accredited ', _system_credit_llollo_20: true, _system_credit_key: 'llollo_20' }
      };

      const txs = loadLocalTxs();
      txs.push(tx);
      saveLocalTxs(txs);

      // Update CUP9_EARNINGS (withdrawable)
      try{
        const earnings = readEarnings();
        const key = String(TARGET_EMAIL).toLowerCase();
        earnings[key] = Number((Number(earnings[key]||0) + Number(AMOUNT)).toFixed(4));
        writeEarnings(earnings);
        try{ notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}
      }catch(e){
        console.error('add-credit-llollo-20: update CUP9_EARNINGS failed', e);
      }

      // Mirror into mock api db if present
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
      }catch(e){
        console.warn('add-credit-llollo-20: mirror to mock db failed', e);
      }

      try{ localStorage.setItem(FLAG_KEY, '1'); }catch(e){}
      try{ toastMessage(`Accreditati $${AMOUNT} a ${TARGET_EMAIL} (locale)`, { type:'success' }); }catch(e){}
      try{ notify('tx:changed', loadLocalTxs()); }catch(e){}
      try{ notify('balance:withdrawable:changed', { email: String(TARGET_EMAIL).toLowerCase(), withdrawable: JSON.parse(localStorage.getItem('CUP9_EARNINGS')||'{}')[String(TARGET_EMAIL).toLowerCase()] || 0 }); }catch(e){}
    }catch(e){
      console.error('add-credit-llollo-20 local credit failed', e);
      try{ toastMessage('Accreditamento locale fallito', { type:'error' }); }catch(e){}
    }

  }catch(err){
    console.error('add-credit-llollo-20 top-level error', err);
    try{ toastMessage('add-credit-llollo-20 script error', { type:'error' }); }catch(e){}
  }
})();