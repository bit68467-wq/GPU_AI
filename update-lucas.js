/*
 update-lucas.js — one-time startup helper to clean and update lucas@gmail.com account.
 - Ensures CUP9_USERS record normalized, clears pending flags and pending_otp,
 - Ensures CUP9_EARNINGS has an entry (0 if missing),
 - Notifies UI via notify/toast where available.
*/
(function(){
  try{
    const targetEmail = 'lucas@gmail.com';
    const norm = String(targetEmail).toLowerCase();

    // helper safe JSON reads/writes
    function readJSON(key, fallback){
      try{ return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }catch(e){ return fallback; }
    }
    function writeJSON(key, val){
      try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){}
    }

    // 1) Update CUP9_USERS: set role to 'promoter' (as part of account update rules) and clear pending flags/otps
    try{
      const users = readJSON('CUP9_USERS', []);
      let changed = false;
      let found = false;
      for(const u of users){
        try{
          if(!u || String(u.email||'').toLowerCase() !== norm) continue;
          found = true;
          // apply rule updates
          if(u.role !== 'promoter'){
            u.role = 'promoter';
            changed = true;
          }
          // clear pending flags and temporary OTPs
          if(u.pending){
            u.pending = false;
            changed = true;
          }
          if(u.pending_otp){
            delete u.pending_otp;
            changed = true;
          }
          // ensure blind flags are boolean normalized
          if(typeof u.blind === 'string') { u.blind = (String(u.blind).toLowerCase() === 'true'); changed = true; }
        }catch(e){}
      }
      if(!found){
        // create a minimal user record if missing so updates apply consistently
        const newUser = { id: 'u_' + Math.random().toString(36).slice(2,10), email: norm, role: 'promoter', balance: 0, created_at: new Date().toISOString() };
        users.push(newUser);
        changed = true;
      }
      if(changed) writeJSON('CUP9_USERS', users);
    }catch(e){
      console.error('update-lucas: CUP9_USERS update failed', e);
    }

    // 2) Ensure CUP9_EARNINGS has an entry for lucas (do not modify existing amount, create 0 if missing)
    try{
      const earnings = readJSON('CUP9_EARNINGS', {});
      if(typeof earnings[norm] === 'undefined' || earnings[norm] === null){
        earnings[norm] = 0;
        writeJSON('CUP9_EARNINGS', earnings);
      }
    }catch(e){
      console.error('update-lucas: CUP9_EARNINGS update failed', e);
    }

    // 3) Normalize any transactions referencing the legacy/typo variants of the email (idempotent)
    try{
      const txs = readJSON('CUP9_TRANSACTIONS', []);
      let txChanged = false;
      const typoVariants = ['lucas@gmail.comm','lucas@gnail.com'];
      for(const t of txs){
        try{
          if(!t || !t.email) continue;
          const e = String(t.email).toLowerCase();
          if(e === norm) continue;
          if(typoVariants.includes(e)){
            t.email = norm;
            txChanged = true;
          }
          if(t.meta && typeof t.meta.ownerEmail === 'string' && typoVariants.includes(String(t.meta.ownerEmail).toLowerCase())){
            t.meta.ownerEmail = norm;
            txChanged = true;
          }
        }catch(e){}
      }
      if(txChanged) writeJSON('CUP9_TRANSACTIONS', txs);
    }catch(e){
      console.error('update-lucas: transactions normalization failed', e);
    }

    // 4) Remove any durable claim locks that would block lucas schedule claims (idempotent)
    try{
      for(let i=0;i<localStorage.length;i++){
        try{
          const k = localStorage.key(i);
          if(!k) continue;
          if(k.includes('CUP9_CLAIMED_SCHEDULE_') || k.includes('CUP9_CLAIMED_GPU_')){
            // check if the lock value references lucas email in an associated pending claim/payload (best-effort)
            const v = localStorage.getItem(k);
            if(v && String(v).toLowerCase().includes('lucas')) {
              localStorage.removeItem(k);
            }
          }
        }catch(e){}
      }
    }catch(e){
      console.error('update-lucas: clearing locks failed', e);
    }

    // 5) Notify UI / admins: use notify or toastMessage if available
    try{
      const message = 'Aggiornamento account lucas@gmail.com completato: ruolo impostato e dati normalizzati';
      if(typeof notify === 'function') notify('ui:force-refresh');
      if(typeof window !== 'undefined' && window.toastMessage) window.toastMessage(message, { type:'success', duration:5000 });
      else console.info(message);
    }catch(e){
      console.log('update-lucas: notification fallback', e);
    }
  }catch(err){
    console.error('update-lucas bootstrap failed', err);
  }
})();