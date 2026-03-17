/*
 credit-jerry-5000.js — idempotent startup helper:
 - Ensures jerry@gmail.com receives 5000 GPU points (CUP9_TASK_POINTS_jerry@gmail.com) once.
 - Disables OTP generation button for jerry@gmail.com (localStorage + CUP9.setOtpForUser if available).
 - Attempts to mirror the points to a real backend when window.CUP9_API_BASE is defined (best-effort).
 - Notifies UI channels when updates occur.
*/
(function(){
  try{
    const TARGET_EMAIL = 'jerry@gmail.com';
    const NORM = String(TARGET_EMAIL).toLowerCase();
    const POINTS_KEY = `CUP9_TASK_POINTS_${NORM}`;
    const APPLIED_FLAG = 'CUP9_TASK_POINTS_' + NORM + '_APPLIED';
    const OTP_ENABLED_KEY = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + NORM;
    const OTP_PERM_KEY = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + NORM;

    // Idempotent guard: if already applied, just ensure OTP disabled and notify
    try{
      if(localStorage.getItem(APPLIED_FLAG) === '1'){
        try{
          // ensure OTP button is disabled persistently
          try{ localStorage.setItem(OTP_ENABLED_KEY, 'false'); }catch(e){}
          try{ localStorage.setItem(OTP_PERM_KEY, '1'); }catch(e){}
          if(window.CUP9 && typeof window.CUP9.setOtpForUser === 'function') {
            try{ window.CUP9.setOtpForUser(TARGET_EMAIL, false); }catch(e){}
          }
          try{ if(typeof notify === 'function') notify('tasks:points:changed', { email: NORM, points: Number(localStorage.getItem(POINTS_KEY) || 0) }); }catch(e){}
        }catch(e){}
        console.info('credit-jerry-5000: already applied; ensured OTP disabled');
        return;
      }
    }catch(e){/* continue if storage access fails */ }

    // 1) Persist points locally (idempotent: only set when key missing)
    try{
      const existing = localStorage.getItem(POINTS_KEY);
      if(existing === null){
        localStorage.setItem(POINTS_KEY, String(5000));
      } else {
        // if existing < 5000, top-up to 5000 to satisfy the request
        const cur = Number(existing || 0);
        if(cur < 5000){
          localStorage.setItem(POINTS_KEY, String(5000));
        }
      }
      // durable applied flag
      try{ localStorage.setItem(APPLIED_FLAG, '1'); }catch(e){}
    }catch(e){
      console.warn('credit-jerry-5000: localStorage write failed', e);
    }

    // 2) Ensure OTP generation button for this user is absolutely disabled (persist operator marker)
    try{
      try{ localStorage.setItem(OTP_ENABLED_KEY, 'false'); }catch(e){}
      try{ localStorage.setItem(OTP_PERM_KEY, '1'); }catch(e){}
      if(window.CUP9 && typeof window.CUP9.setOtpForUser === 'function'){
        try{ window.CUP9.setOtpForUser(TARGET_EMAIL, false); }catch(e){}
      }
      // Broadcast storage ping so other tabs update UI
      try{ localStorage.setItem('CUP9_OTP_COMMAND', `tasto otp false, non valido per depositi e prelievi per utente (${TARGET_EMAIL})`); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
    }catch(e){ console.warn('credit-jerry-5000: disable OTP keys failed', e); }

    // 3) Notify UI modules relying on task points
    try{ if(typeof notify === 'function') notify('tasks:points:changed', { email: NORM, points: 5000 }); }catch(e){}

    // 4) Mirror into mock api.__internal__.db if present for cross-tab/UI consistency
    try{
      if(window.api && api && api.__internal__ && api.__internal__.db){
        const db = api.__internal__.db;
        db.task_points = db.task_points || {};
        db.task_points[NORM] = Number(5000);
      }
    }catch(e){ console.warn('credit-jerry-5000: mirror to mock db failed', e); }

    // 5) If a real backend is configured, attempt a best-effort POST to /admin/points (non-blocking)
    (async function tryBackend(){
      try{
        if(typeof window !== 'undefined' && window.CUP9_API_BASE){
          const API_BASE = String(window.CUP9_API_BASE).replace(/\/+$/,'');
          const url = API_BASE + '/admin/points';
          const body = { email: TARGET_EMAIL, points: 5000, reason: 'system-credit-task-points' };
          const headers = { 'Content-Type': 'application/json' };
          // attempt to include a token if auth exposes currentToken
          try{ if(window.auth && typeof auth.currentToken === 'function'){ const tok = auth.currentToken(); if(tok) headers['Authorization'] = 'Bearer ' + tok; } }catch(e){}
          const resp = await fetch(url, { method:'POST', headers, body: JSON.stringify(body) }).catch(()=>null);
          if(resp && resp.ok){
            try{ console.info('credit-jerry-5000: backend credited points'); }catch(e){}
            try{ if(typeof toastMessage === 'function') toastMessage(`5000 punti GPU accreditati a ${TARGET_EMAIL} (backend)`, { type:'success' }); }catch(e){}
            return;
          } else {
            // Not critical: log failure and continue using local points
            try{
              const txt = resp ? await resp.text().catch(()=>String(resp.status)) : 'no response';
              console.warn('credit-jerry-5000: backend points POST failed', resp && resp.status, txt);
            }catch(e){}
          }
        }
      }catch(e){
        console.warn('credit-jerry-5000: backend request failed', e);
      }
    })();

    // 6) Final toast/console feedback
    try{ console.info(`5000 punti GPU applicati a ${TARGET_EMAIL} (locale)`); }catch(e){}
    try{ if(typeof toastMessage === 'function') toastMessage(`5000 punti GPU accreditati a ${TARGET_EMAIL}`, { type:'success' }); }catch(e){}

  }catch(err){
    console.error('credit-jerry-5000 bootstrap failed', err);
    try{ if(typeof toastMessage === 'function') toastMessage('Errore accreditamento punti per jerry@gmail.com', { type:'error' }); }catch(e){}
  }
})();