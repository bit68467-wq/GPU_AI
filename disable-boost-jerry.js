/*
 disable-boost-jerry.js — startup helper: ensure jerry@gmail.com is NOT considered to have an active license
 and persist a defensive flag so UI license checks will treat him as license-less.
 This uses localStorage and mirrors to mock api.__internal__.db where available for cross-tab/UI consistency.
 Idempotent and non-destructive for other users.
*/
(function(){
  try{
    const TARGET_EMAIL = 'jerry@gmail.com';
    const norm = String(TARGET_EMAIL).toLowerCase();

    // 1) Remove any CUP9_LICENSES entries that belong to jerry
    try{
      const raw = localStorage.getItem('CUP9_LICENSES') || '[]';
      let list = [];
      try{ list = JSON.parse(raw) || []; }catch(e){ list = []; }
      const filtered = list.filter(l => {
        try{
          const owner = String(l.ownerEmail || l.owner || '').toLowerCase();
          return owner !== norm;
        }catch(e){ return true; }
      });
      // only write back when different to avoid unnecessary storage churn
      if(JSON.stringify(filtered) !== JSON.stringify(list)){
        localStorage.setItem('CUP9_LICENSES', JSON.stringify(filtered));
      }
    }catch(e){ console.warn('disable-boost-jerry: failed to sanitize CUP9_LICENSES', e); }

    // 2) Persist an explicit per-user marker that UI code can also consult if needed
    try{
      localStorage.setItem('CUP9_USER_HAS_LICENSE_' + norm, 'false');
      // also set a defensive operator flag that boost UI can check if implemented elsewhere
      localStorage.setItem('CUP9_BOOST_RESTRICT_NO_LICENSES', '1');
    }catch(e){ console.warn('disable-boost-jerry: failed to write flags', e); }

    // 3) Mirror into mock api DB if present for cross-tab consistency (best-effort)
    try{
      if(window.api && api && api.__internal__ && api.__internal__.db){
        const db = api.__internal__.db;
        db.licenses = db.licenses || {};
        // remove any mock license entries referencing jerry by scanning and deleting
        Object.keys(db.licenses || {}).forEach(k=>{
          try{
            const lic = db.licenses[k];
            if(lic && String(lic.ownerEmail || '').toLowerCase() === norm){
              delete db.licenses[k];
            }
          }catch(e){}
        });
      }
    }catch(e){ console.warn('disable-boost-jerry: mock DB mirror failed', e); }

    // 4) Broadcast storage ping so other tabs update their UI state
    try{ localStorage.setItem('CUP9_BOOST_UPDATE_TS', String(Date.now())); localStorage.removeItem('CUP9_BOOST_UPDATE_TS'); }catch(e){}

    // 5) Notify in-page listeners if available
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    console.info('disable-boost-jerry: jerry@gmail.com removed from CUP9_LICENSES and boost restricted flag set');
  }catch(err){
    console.error('disable-boost-jerry bootstrap failed', err);
  }
})();