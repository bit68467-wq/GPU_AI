/*
 remove-lucas-claims.js — startup helper: remove all 'claim' transactions for lucas@gmail.com,
 deduct their amounts from CUP9_EARNINGS and from the persistent CUP9_USERS balance (if present),
 mark removed claim txs with meta._removed_by_script for traceability, persist and notify UI.
 Idempotent: running multiple times will not double-deduct.
*/
(function(){
  try{
    const TARGET = 'lucas@gmail.com';
    const TX_KEY = 'CUP9_TRANSACTIONS';
    const EARNINGS_KEY = 'CUP9_EARNINGS';
    const USERS_KEY = 'CUP9_USERS';

    function readTxs(){ try{ return JSON.parse(localStorage.getItem(TX_KEY) || '[]'); }catch(e){ return []; } }
    function writeTxs(txs){ try{ localStorage.setItem(TX_KEY, JSON.stringify(txs||[])); }catch(e){} }
    function readEarnings(){ try{ return JSON.parse(localStorage.getItem(EARNINGS_KEY) || '{}'); }catch(e){ return {}; } }
    function writeEarnings(obj){ try{ localStorage.setItem(EARNINGS_KEY, JSON.stringify(obj||{})); }catch(e){} }
    function readUsers(){ try{ return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); }catch(e){ return []; } }
    function writeUsers(u){ try{ localStorage.setItem(USERS_KEY, JSON.stringify(u||[])); }catch(e){} }

    const norm = String(TARGET).toLowerCase();
    let txs = readTxs();
    if(!txs || !txs.length) {
      try{ if(window && window.toastMessage) window.toastMessage('Nessuna transazione presente'); }catch(e){}
      return;
    }

    // Identify claim transactions belonging to lucas that have not been previously removed by scripts
    const claims = txs.filter(t=>{
      try{
        return String(t.type || '').toLowerCase() === 'claim' &&
               String(t.email || '').toLowerCase() === norm &&
               !(t.meta && t.meta._removed_by_script);
      }catch(e){ return false; }
    });

    if(!claims.length){
      try{ if(window && window.toastMessage) window.toastMessage('Nessun CLAIM attivo trovato per ' + TARGET); }catch(e){}
      return;
    }

    // Sum total to deduct
    const totalToDeduct = claims.reduce((s,c)=> s + Number(c.amount || 0), 0);

    if(totalToDeduct <= 0){
      // mark claims as tombstoned without financial effect
      let modified = false;
      txs = txs.map(t => {
        try{
          if(String(t.type||'').toLowerCase() === 'claim' && String(t.email||'').toLowerCase() === norm && !(t.meta && t.meta._removed_by_script)){
            t.meta = t.meta || {};
            t.meta._removed_by_script = true;
            t.meta._removed_at = new Date().toISOString();
            modified = true;
          }
        }catch(e){}
        return t;
      });
      if(modified) writeTxs(txs);
      try{ if(window && window.notify) window.notify('tx:changed', readTxs()); }catch(e){}
      try{ if(window && window.toastMessage) window.toastMessage('Claim marcati come rimossi (importo zero) per ' + TARGET, { type:'info' }); }catch(e){}
      return;
    }

    // Deduct from earnings map (withdrawable)
    const earnings = readEarnings();
    const prevEarn = Number(earnings[norm] || 0);
    const newEarn = Math.max(0, Number((prevEarn - totalToDeduct).toFixed(8)));
    earnings[norm] = newEarn;
    writeEarnings(earnings);

    // Adjust persistent CUP9_USERS balance if a matching local user exists (treat as deposit/spendable balance)
    let users = readUsers();
    let usersModified = false;
    try{
      const idx = users.findIndex(u => String(u.email || '').toLowerCase() === norm);
      if(idx !== -1){
        const prevBal = Number(users[idx].balance || 0);
        const nextBal = Math.max(0, Number((prevBal - totalToDeduct).toFixed(8)));
        users[idx].balance = nextBal;
        usersModified = true;
      }
    }catch(e){
      usersModified = false;
    }
    if(usersModified) writeUsers(users);

    // Mark each removed claim transaction with meta._removed_by_script and keep it in history (tombstone)
    const nowIso = new Date().toISOString();
    txs = txs.map(t => {
      try{
        if(String(t.type||'').toLowerCase() === 'claim' && String(t.email||'').toLowerCase() === norm && !(t.meta && t.meta._removed_by_script)){
          t.meta = t.meta || {};
          t.meta._removed_by_script = true;
          t.meta._removed_at = nowIso;
          t.meta._removed_amount = Number(t.amount || 0);
          // Optionally mark status to indicate normalized (do not delete to preserve audit trail)
          t.status = 'removed';
        }
      }catch(e){}
      return t;
    });
    writeTxs(txs);

    // Notify UI listeners and show a toast
    try{ if(window && window.notify) window.notify('tx:changed', readTxs()); }catch(e){}
    try{ if(window && window.notify) window.notify('earnings:changed', readEarnings()); }catch(e){}
    try{ if(window && window.notify) window.notify('balance:changed', { email: norm, balance: (users.find(u=>String(u.email||'').toLowerCase()===norm) || {}).balance || newEarn }); }catch(e){}
    try{ if(window && window.toastMessage) window.toastMessage(`Rimossi ${claims.length} CLAIM per ${TARGET}; dedotti $${Number(totalToDeduct).toFixed(4)} dal saldo`, { type:'success', duration:7000 }); }catch(e){}

  }catch(err){
    try{ if(window && window.toastMessage) window.toastMessage('Errore rimozione claim: ' + (err && err.message ? err.message : String(err)), { type:'error' }); }catch(e){}
    console.error('remove-lucas-claims error', err);
  }
})();