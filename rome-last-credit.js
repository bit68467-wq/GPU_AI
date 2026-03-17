/*
 rome-last-credit.js — lightweight compatibility shim (no-op)
 This file exists only to satisfy the index.html import and avoid runtime errors
 so the UI init and the accrual/claim schedulers can run uninterrupted.
*/
(function(){
  try{
    // expose a safe helper for other modules to read the last daily payout timestamp
    window.CUP9 = window.CUP9 || {};
    window.CUP9.getLastDailyPayoutISO = function(){
      try{ return localStorage.getItem('CUP9_LAST_DAILY_PAYOUT_AT') || null; }catch(e){ return null; }
    };
    // no-op runner
    console.info('rome-last-credit shim loaded');
  }catch(e){
    console.warn('rome-last-credit shim failed to initialize', e);
  }
})();