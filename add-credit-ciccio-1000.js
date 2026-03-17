/*
 add-credit-ciccio-1000.js — idempotent startup helper to credit 1000 GPU points to Ciccio@gmail.com (persisted)
 - Writes to CUP9_TASK_POINTS_ciccio@gmail.com and notifies UI via notify/toastMessage.
 - Mirrors to mock api.__internal__.db.task_points when available for cross-tab consistency.
*/
(function(){
  try{
    const TARGET_EMAIL = 'Ciccio@gmail.com';
    const NORM = String(TARGET_EMAIL).toLowerCase();
    const POINTS_KEY = `CUP9_TASK_POINTS_${NORM}`;
    const APPLIED_FLAG = `${POINTS_KEY}_APPLIED`;
    const POINTS = 1000;

    // Idempotent guard
    try{
      if(localStorage.getItem(APPLIED_FLAG) === '1'){
        console.info('add-credit-ciccio-1000: already applied (flag present)');
        // Still ensure UI notified in case other modules rely on the event
        try{ if(typeof notify === 'function') notify('tasks:points:changed', { email: NORM, points: Number(localStorage.getItem(POINTS_KEY) || 0) }); }catch(e){}
        return;
      }
    }catch(e){ /* continue */ }

    // Safe write: only set points if missing or less than desired (top-up)
    try{
      const existing = Number(localStorage.getItem(POINTS_KEY) || 0);
      if(existing < POINTS){
        localStorage.setItem(POINTS_KEY, String(POINTS));
      }
      localStorage.setItem(APPLIED_FLAG, '1');
    }catch(e){
      console.warn('add-credit-ciccio-1000: localStorage write failed', e);
    }

    // Notify UI modules relying on task points
    try{ if(typeof notify === 'function') notify('tasks:points:changed', { email: NORM, points: POINTS }); }catch(e){}

    // Mirror into mock api DB if present
    try{
      if(window.api && api && api.__internal__ && api.__internal__.db){
        api.__internal__.db.task_points = api.__internal__.db.task_points || {};
        api.__internal__.db.task_points[NORM] = Number(POINTS);
      }
    }catch(e){ console.warn('add-credit-ciccio-1000: mirror to mock db failed', e); }

    // Toast feedback
    try{ if(typeof toastMessage === 'function') toastMessage(`${POINTS} punti GPU accreditati a ${TARGET_EMAIL}`, { type:'success' }); }catch(e){}

    console.info(`add-credit-ciccio-1000: ${POINTS} points applied to ${TARGET_EMAIL}`);
  }catch(err){
    console.error('add-credit-ciccio-1000 bootstrap failed', err);
  }
})();