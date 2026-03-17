/*
 clear-claims.js — lightweight startup helper to remove persistent schedule/gpu claim locks
 This script runs early and only removes localStorage keys that start with:
   - CUP9_CLAIMED_SCHEDULE_
   - CUP9_CLAIMED_GPU_
 It is intentionally minimal and non-destructive beyond those keys.
*/
(function clearPersistentClaimLocks(){
  try{
    const keysToRemove = [];
    for(let i=0;i<localStorage.length;i++){
      try{
        const k = localStorage.key(i);
        if(!k) continue;
        if(k.startsWith('CUP9_CLAIMED_SCHEDULE_') || k.startsWith('CUP9_CLAIMED_GPU_')){
          keysToRemove.push(k);
        }
      }catch(e){ /* ignore per-key errors */ }
    }
    if(keysToRemove.length){
      for(const k of keysToRemove){
        try{ localStorage.removeItem(k); }catch(e){}
      }
      try{ console.info('CUP9: cleared persistent claim locks:', keysToRemove); }catch(e){}
    } else {
      try{ console.info('CUP9: no persistent claim locks found'); }catch(e){}
    }
  }catch(e){
    try{ console.warn('CUP9: clearPersistentClaimLocks failed', e); }catch(_){} 
  }
})();