/*
 credit-west-5000-points.js — startup helper: ensure a one-time credit of 5000 GPU points to west@gmail.com (persisted)
 Writes to the per-user points key used by the Tasks UI (CUP9_TASK_POINTS_<email>).
 This version is idempotent across reloads and will NOT overwrite an existing points balance.
*/
(function(){
  try{
    const email = 'west@gmail.com';
    const norm = String(email).toLowerCase();
    const pointsKey = `CUP9_TASK_POINTS_${norm}`;
    const POINTS = 5000;

    // Only set points if the key does not already exist (preserve any user-spent changes)
    try{
      const existing = localStorage.getItem(pointsKey);
      if(existing === null){
        localStorage.setItem(pointsKey, String(POINTS));
        // Notify UI modules that rely on task points: emit a storage ping and notify channel if available
        try{ localStorage.setItem('CUP9_TASK_POINTS_UPDATED', JSON.stringify({ email: norm, points: POINTS, ts: Date.now() })); localStorage.removeItem('CUP9_TASK_POINTS_UPDATED'); }catch(e){}
        try{ if(typeof notify === 'function') notify('tasks:points:changed', { email: norm, points: POINTS }); }catch(e){}
        // show a single toast only when the points were newly applied
        try{ if(typeof toastMessage === 'function') toastMessage(`5000 punti GPU accreditati a ${email}`, { type:'success' }); }catch(e){}
        // Mirror a human-readable backup key so exports include the points in case of JSON backup
        try{
          const backupKey = 'CUP9_TASK_POINTS_BACKUP';
          const backup = JSON.parse(localStorage.getItem(backupKey) || '{}') || {};
          backup[norm] = Number(POINTS);
          localStorage.setItem(backupKey, JSON.stringify(backup));
        }catch(e){}
      } else {
        // existing value present — do not overwrite; still emit a lightweight notify so UI stays in sync
        try{ if(typeof notify === 'function') notify('tasks:points:changed', { email: norm, points: Number(existing) }); }catch(e){}
      }
    }catch(e){
      console.error('credit-west-5000: store/read failed', e);
    }

  }catch(err){
    try{ console.error('credit-west-5000 top-level error', err); }catch(e){}
  }
})();