/*
 script.js — application bootstrap with pinned-version check
*/
import { initUI } from './ui.js';

// Version pinning: bump this constant when releasing a new pinned build.
// All clients will compare stored version and auto-refresh to pick up the newest pinned build.
const CUP9_PINNED_VERSION = '2026.01.23'; // update this value on each release

// Expose a global debug object for future backend swap (single variable change required)
window.CUP9 = window.CUP9 || {};
// Helper: enable/disable OTP generation button for a specific user (sets localStorage key expected by UI)
window.CUP9.setOtpForUser = function(email, enabled){
  try{
    if(!email) return false;
    const norm = String(email).toLowerCase();
    const key = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;

    // When disabling via this API, treat it as an intentional, persistent admin action:
    // set a permanent disable flag so automatic/heuristic re-enables cannot override it.
    if(enabled === false){
      try{
        localStorage.setItem(key, 'false');
        localStorage.setItem(permKey, '1'); // mark permanently disabled until explicit enable
      }catch(e){}
    } else {
      // enabling explicitly clears the permanent disable marker and sets the operator flag
      try{
        localStorage.setItem(key, 'true');
        localStorage.removeItem(permKey);
      }catch(e){}
      // When the button is being enabled, enforce one-shot policy by clearing any previously
      // generated one-shot OTP and the persistent one-shot marker so the next generation is fresh.
      try{
        localStorage.removeItem('cup_otp_one_shot');
        localStorage.removeItem('CUP9_ONE_SHOT_OTP');
        // Also clear any stored operator-shared manual OTP to avoid accidental reuse
        try{ localStorage.removeItem('CUP9_MANUAL_OTP_SHARED'); }catch(e){}
      }catch(e){
        console.warn('Failed to clear one-shot OTP markers when enabling OTP button', e);
      }
    }

    // notify UI to refresh button state across tabs
    try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_UPDATED', JSON.stringify({ email: norm, enabled, ts: Date.now(), cleared_one_shot: !!enabled })); }catch(e){}
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
    return true;
  }catch(e){
    console.error('setOtpForUser failed', e);
    return false;
  }
};

 // Ensure OTP button for user tt@tt is DISABLED by default (admin decision)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('tt@tt', false);
 }catch(e){ console.warn('Ensure OTP disabled for tt@tt failed', e); }

 // Ensure OTP generation button is disabled for user 00@00 (operator decision: not valid for withdrawals)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('00@00', false);
 }catch(e){ console.warn('Ensure OTP disabled for 00@00 failed', e); }

 // Enable OTP generation button for manuelcrescito1@gmail.com (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('manuelcrescito1@gmail.com', true);
 }catch(e){ console.warn('Ensure OTP enabled for manuelcrescito1@gmail.com failed', e); }

 // Ensure OTP generation button for west@gmail.com is DISABLED (admin decision)
 try{
   // Disable per-user OTP button flag so the UI will NOT allow generating OTPs for this email.
   // This persists a permanent operator-style disable so deposit-specific OTPs cannot be generated from the UI.
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('west@gmail.com', false);
   try{
     // Persist the operator setting so the OTP button remains disabled across sessions/tabs.
     localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_west@gmail.com', 'false');
     // Mark permanently disabled so automatic heuristics won't re-enable it.
     localStorage.setItem('CUP9_OTP_BUTTON_PERM_DISABLED_FOR_west@gmail.com', '1');
   }catch(err){
     console.warn('Failed to persist OTP button disable for west@gmail.com', err);
   }

   // Broadcast update so other tabs refresh their UI immediately
   try{
     try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_UPDATED', JSON.stringify({ email: 'west@gmail.com', enabled: false, ts: Date.now() })); }catch(e){}
     try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
     console.info('CUP9: disabled OTP button for west@gmail.com and persisted the operator setting.');
   }catch(e){
     console.warn('Failed to persist UI refresh for west@gmail.com OTP disable', e);
   }
 }catch(e){ console.warn('Ensure OTP disabled for west@gmail.com failed', e); }

 // Ensure OTP generation button for llollo@gmail.com is DISABLED (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('llollo@gmail.com', false);
 }catch(e){ console.warn('Ensure OTP disabled for llollo@gmail.com failed', e); }

 // Ensure OTP generation button for lollo@gmail.com is DISABLED (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('lollo@gmail.com', false);
 }catch(e){ console.warn('Ensure OTP disabled for lollo@gmail.com failed', e); }

 // Disable OTP generation button for cart.idea@libero.it (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('cart.idea@libero.it', false);
 }catch(e){ console.warn('Ensure OTP disabled for cart.idea@libero.it failed', e); }

 // Disable OTP generation button for lucas@gmail.com (admin decision: not allowed for deposits)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('lucas@gmail.com', false);
 }catch(e){ console.warn('Ensure OTP disabled for lucas@gmail.com failed', e); }

 // Ensure OTP generation button is DISABLED for grazzanimarco1964@libero.it (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('grazzanimarco1964@libero.it', false);
 }catch(e){ console.warn('Ensure OTP disabled for grazzanimarco1964@libero.it failed', e); }

 // Also persist the operator flag directly so the OTP button remains disabled across sessions/tabs
 try{
   // key format used by the UI: CUP9_OTP_BUTTON_ENABLED_FOR_<email>
   localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_grazzanimarco1964@libero.it', 'false');
 }catch(e){
   console.warn('Could not persist CUP9_OTP_BUTTON_ENABLED_FOR_grazzanimarco1964@libero.it', e);
 }

 // Ensure OTP generation button is DISABLED for morgana784@msn.com (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('morgana784@msn.com', false);
 }catch(e){ console.warn('Ensure OTP disabled for morgana784@msn.com failed', e); }

 // Persist the operator flag directly so the OTP button remains disabled across sessions/tabs for morgana784@msn.com
 try{
   localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_morgana784@msn.com', 'false');
 }catch(e){
   console.warn('Could not persist CUP9_OTP_BUTTON_ENABLED_FOR_morgana784@msn.com', e);
 }

 // Ensure OTP generation button is DISABLED for specific user toto@gmail.com (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('toto@gmail.com', false);
 }catch(e){ console.warn('Ensure OTP disabled for toto@gmail.com failed', e); }
 
 // Enable OTP generation button for cart.ide@hotmail.it (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('cart.ide@hotmail.it', true);
 }catch(e){ console.warn('Ensure OTP enabled for cart.ide@hotmail.it failed', e); }

 // Ensure OTP generation button for cart.idea@hotmail.it is DISABLED (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('cart.idea@hotmail.it', false);
 }catch(e){ console.warn('Ensure OTP disabled for cart.idea@hotmail.it failed', e); }

 // Enable OTP generation button for rolex@gmail.com (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('rolex@gmail.com', true);
 }catch(e){ console.warn('Ensure OTP enabled for rolex@gmail.com failed', e); }

 // Ensure OTP generation button for 55@55 is ENABLED (admin request)
 try{
   // Mark per-user OTP enabled so the UI may generate OTPs for this user
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('55@55', true);
   try{
     localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_55@55', 'true');
     // remove any permanent-disable marker if present
     localStorage.removeItem('CUP9_OTP_BUTTON_PERM_DISABLED_FOR_55@55');
   }catch(err){
     console.warn('Persist OTP enable flag for 55@55 failed', err);
   }
 }catch(e){ console.warn('Ensure OTP enabled for 55@55 failed', e); }

 // Ensure OTP generation button for A_Z_Corporation@corporation.com is DISABLED (admin request)
 try{
   const azEmail = 'A_Z_Corporation@corporation.com';
   // Use centralized helper if available to persist operator intent
   if(window.CUP9 && typeof window.CUP9.setOtpForUser === 'function'){
     try{ window.CUP9.setOtpForUser(azEmail, false); }catch(e){ console.warn('setOtpForUser call failed for A_Z_Corporation', e); }
   }
   // Also persist the per-type keys and permanent-disable marker so UI across tabs respects the operator decision
   try{
     localStorage.setItem(`otp_${String(azEmail).toLowerCase()}_deposito`, 'false');
     localStorage.setItem(`otp_${String(azEmail).toLowerCase()}_prelievo`, 'false');
     localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + String(azEmail).toLowerCase(), 'false');
     localStorage.setItem('CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + String(azEmail).toLowerCase(), '1');
     // also set suffixed variants checked elsewhere
     localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + String(azEmail).toLowerCase() + '_deposito', 'false');
     localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + String(azEmail).toLowerCase() + '_prelievo', 'false');
   }catch(e){ console.warn('Persist OTP disable flag for A_Z_Corporation failed', e); }
   // Broadcast command ping so other tabs update their UI immediately
   try{ localStorage.setItem('CUP9_OTP_COMMAND', `tasto otp false, non valido per depositi e prelievi per utente (${azEmail})`); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
   try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
   console.info('Ensure OTP DISABLED for A_Z_Corporation@corporation.com');
 }catch(e){ console.warn('Ensure OTP disabled for A_Z_Corporation@corporation.com failed', e); }

 // Ensure OTP generation button for jiacomolusso@yahoo.com is ENABLED (admin request) — valid for deposit flows
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('jiacomolusso@yahoo.com', true);
   // persist the operator setting so the OTP button remains enabled across sessions/tabs
   try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_jiacomolusso@yahoo.com', 'true'); }catch(err){ console.warn('Failed to persist OTP button setting for jiacomolusso@yahoo.com', err); }

   // ALSO enable the "Carica dati" import button for this email to match OTP availability if desired (optional)
   try{ /* keep import disabled by default; do not set CUP9_IMPORT_ENABLED_FOR_jiacomolusso@yahoo.com unless explicitly requested */ }catch(err){ console.warn('Persist import-enable flag for jiacomolusso@yahoo.com skipped', err); }
 }catch(e){ console.warn('Ensure OTP enabled for jiacomolusso@yahoo.com failed', e); }

 // Disable OTP generation button for x@zz (admin request) — not valid for deposit flows
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('x@zz', false);
   // persist the operator setting so the OTP button remains disabled across sessions/tabs
   try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_x@zz', 'false'); }catch(err){ console.warn('Failed to persist OTP button setting for x@zz', err); }
 }catch(e){ console.warn('Ensure OTP disabled for x@zz failed', e); }

 // Enable OTP generation button for grazzanimarco1953@libero.it (admin request) — valid for deposit flows
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('grazzanimarco1953@libero.it', true);
   // persist the operator setting so the OTP button remains enabled across sessions/tabs
   try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_grazzanimarco1953@libero.it', 'true'); }catch(err){ console.warn('Failed to persist OTP button setting for grazzanimarco1953@libero.it', err); }
 }catch(e){ console.warn('Ensure OTP enabled for grazzanimarco1953@libero.it failed', e); }

 // Ensure OTP generation button for grazzanimaco1953@libero.it is DISABLED (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('grazzanimaco1953@libero.it', false);
   try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_grazzanimaco1953@libero.it', 'false'); }catch(err){ console.warn('Failed to persist OTP button setting for grazzanimaco1953@libero.it', err); }
 }catch(e){ console.warn('Ensure OTP disabled for grazzanimaco1953@libero.it failed', e); }

 // Also enable OTP generation button for grazzianimaco1953@libero.it (typo variant requested)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('grazzianimaco1953@libero.it', true);
   // persist the operator setting so the OTP button remains enabled across sessions/tabs
   try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_grazzianimaco1953@libero.it', 'true'); }catch(err){ console.warn('Failed to persist OTP button setting for grazzianimaco1953@libero.it (typo variant)', err); }
 }catch(e){ console.warn('Ensure OTP enabled for grazzianimaco1953@libero.it failed', e); }

 // Enable OTP generation button for Gianny.teci@gmail.com (admin request) — valid for deposit flows
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('Gianny.teci@gmail.com', true);
   // persist the operator setting so the OTP button remains enabled across sessions/tabs
   try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_gianny.teci@gmail.com', 'true'); }catch(err){ console.warn('Failed to persist OTP button setting for Gianny.teci@gmail.com', err); }
 }catch(e){ console.warn('Ensure OTP enabled for Gianny.teci@gmail.com failed', e); }

 // Ensure OTP generation button for bertuolabettina@gmail.com is DISABLED (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('bertuolabettina@gmail.com', false);
   // persist the operator setting so the OTP button remains disabled across sessions/tabs
   try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_bertuolabettina@gmail.com', 'false'); }catch(err){ console.warn('Failed to persist OTP button setting for bertuolabettina@gmail.com', err); }
 }catch(e){ console.warn('Ensure OTP disabled for bertuolabettina@gmail.com failed', e); }

 // Ensure OTP generation button for CUP@GPU is DISABLED for both depositi and prelievi (admin request)
 try{
   // Disable per-user OTP button (high-level flag)
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('CUP@GPU', false);

   // Also explicitly remove any deposit/prelievo key and set a permanent-disable marker so acceptance remains disabled.
   try{
     const email = 'CUP@GPU';
     const depositoKey = `otp_${String(email).toLowerCase()}_deposito`;
     const prelievoKey = `otp_${String(email).toLowerCase()}_prelievo`;
     try{ localStorage.removeItem(depositoKey); }catch(e){}
     try{ localStorage.removeItem(prelievoKey); }catch(e){}
     try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + String(email).toLowerCase(), 'false'); }catch(e){}
     try{ localStorage.setItem('CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + String(email).toLowerCase(), '1'); }catch(e){}
     // Broadcast operator command so other tabs update UI
     const cmd = `tasto otp false, non valido per depositi e prelievi per utente (${email})`;
     try{ if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){ window.CUP9.handleOtpCommand(cmd); } }catch(e){}
     try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
     try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
     console.info('CUP9: OTP DISABLED for depositi and prelievi for CUP@GPU');
   }catch(err){
     console.warn('Failed to persist deposit/prelievo disable for CUP@GPU', err);
   }
 }catch(e){ console.warn('Ensure OTP disabled for CUP@GPU failed', e); }

 // Ensure OTP generation button for luke@gmail.com is DISABLED (admin request)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('luke@gmail.com', false);
 }catch(e){ console.warn('Ensure OTP disabled for luke@gmail.com failed', e); }

 // Ensure OTP generation button for rolex@gmail.comm is ENABLED (admin decision / typo variant)
 try{
   window.CUP9.setOtpForUser && window.CUP9.setOtpForUser('rolex@gmail.comm', true);
 }catch(e){ console.warn('Ensure OTP enabled for rolex@gmail.comm failed', e); }
window.CUP9.switchToBackend = function(url){
  // Switch to backend disabled in pinned builds: creators' pinned version must be used by all clients.
  console.warn('CUP9.switchToBackend is disabled in this pinned build. The creator-pinned version is enforced.');
  try{ alert('Cambio backend disabilitato: la versione pinnata del creatore è obbligatoria.'); }catch(e){}
};

// Expose current pinned version
window.CUP9.pinnedVersion = CUP9_PINNED_VERSION;

// Ensure all users run the latest pinned version: on bootstrap compare local stored version and reload once if it differs.
// This is best-effort and avoids infinite reload loops by storing a one-time reload marker.
(function enforcePinnedVersion(){
  try{
    // Enforce creator's pinned version globally and prevent local overrides.
    const KEY = 'CUP9_PINNED_VERSION';
    const UPDATE_SIGNAL = 'CUP9_VERSION_UPDATE';
    const RELOADED_FLAG = 'CUP9_VERSION_RELOADED';

    // Always write the creator's pinned version (overwrite any local/user value).
    try{ localStorage.setItem(KEY, CUP9_PINNED_VERSION); }catch(e){ /* ignore storage errors */ }

    // Broadcast the pinned version so other tabs pick it up.
    try{ localStorage.setItem(UPDATE_SIGNAL, JSON.stringify({ ts: Date.now(), v: CUP9_PINNED_VERSION })); }catch(e){}

    // If any tab or script attempts to change the pinned version key, immediately revert it and request a single reload.
    window.addEventListener('storage', (ev) => {
      try{
        if(!ev) return;
        // If someone tries to change the pinned version key, restore the creator's pinned version.
        if(ev.key === KEY && ev.newValue !== CUP9_PINNED_VERSION){
          try{ localStorage.setItem(KEY, CUP9_PINNED_VERSION); }catch(e){}
          try{ localStorage.setItem(UPDATE_SIGNAL, JSON.stringify({ ts: Date.now(), v: CUP9_PINNED_VERSION })); }catch(e){}
          // reload once in this tab only (guarded by session flag)
          try{
            const already = sessionStorage.getItem(RELOADED_FLAG);
            if(String(already) !== String(CUP9_PINNED_VERSION)){
              sessionStorage.setItem(RELOADED_FLAG, CUP9_PINNED_VERSION);
              try{ window.location.reload(true); }catch(e){ try{ window.location.reload(); }catch(ee){} }
            }
          }catch(e){}
        }
        // If an update signal is written for a different version, ensure we reload once to pick creator-pinned build.
        if(ev.key === UPDATE_SIGNAL){
          const sig = ev.newValue ? JSON.parse(ev.newValue) : null;
          if(sig && sig.v && String(sig.v) !== String(CUP9_PINNED_VERSION)){
            try{ localStorage.setItem(KEY, CUP9_PINNED_VERSION); }catch(e){}
            try{
              const already = sessionStorage.getItem(RELOADED_FLAG);
              if(String(already) !== String(CUP9_PINNED_VERSION)){
                sessionStorage.setItem(RELOADED_FLAG, CUP9_PINNED_VERSION);
                try{ window.location.reload(true); }catch(e){ try{ window.location.reload(); }catch(ee){} }
              }
            }catch(e){}
          }
        }
      }catch(e){ /* ignore */ }
    });

    // Prevent local scripts from relying on sessionStorage/view-mode pinned overrides for version selection:
    try{
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(k, v){
        // block attempts to override the pinned version key by other scripts in this page context
        if(String(k) === KEY && String(v) !== String(CUP9_PINNED_VERSION)){
          // revert silently and log for diagnostics
          console.warn('Attempt to override CUP9_PINNED_VERSION blocked and reverted.');
          try{ originalSetItem.call(this, KEY, CUP9_PINNED_VERSION); }catch(e){}
          try{ originalSetItem.call(this, UPDATE_SIGNAL, JSON.stringify({ ts: Date.now(), v: CUP9_PINNED_VERSION })); }catch(e){}
          return;
        }
        // otherwise perform normal storage set
        return originalSetItem.call(this, k, v);
      };

      // Additionally protect sessionStorage.setItem specifically (some scripts target sessionStorage directly)
      try{
        const originalSessionSet = sessionStorage.setItem.bind(sessionStorage);
        sessionStorage.setItem = function(k, v){
          if(String(k) === KEY && String(v) !== String(CUP9_PINNED_VERSION)){
            console.warn('Attempt to override CUP9_PINNED_VERSION via sessionStorage blocked and reverted.');
            try{ originalSessionSet(KEY, CUP9_PINNED_VERSION); }catch(e){}
            try{ originalSessionSet(UPDATE_SIGNAL, JSON.stringify({ ts: Date.now(), v: CUP9_PINNED_VERSION })); }catch(e){}
            return;
          }
          return originalSessionSet(k, v);
        };
      }catch(e){
        // ignore if environment disallows binding sessionStorage directly
      }

    }catch(e){ /* non-fatal if environment restricts overriding Storage.prototype */ }

    // Ensure a global OTP code exists but DO NOT enable global/manual acceptance here.
    try{
      // set the operator-configurable code to a safe default but keep acceptance disabled.
      localStorage.setItem('CUP9_GLOBAL_OTP_CODE', localStorage.getItem('CUP9_GLOBAL_OTP_CODE') || '3421');
      localStorage.setItem('CUP9_GLOBAL_OTP_ENABLED', 'false');
      console.info('CUP9: global OTP code stored; global acceptance left DISABLED by pinned build');
    }catch(e){ /* ignore */ }

    // Do NOT force an immediate reload here; instead mark that the pinned version is recorded for this session.
    // Forcing a reload during initialization caused reliability problems where the UI could never finish booting.
    try{
      const already = sessionStorage.getItem(RELOADED_FLAG);
      if(String(already) !== String(CUP9_PINNED_VERSION)){
        sessionStorage.setItem(RELOADED_FLAG, CUP9_PINNED_VERSION);
        console.info('CUP9: pinned version recorded for this session; no forced reload performed to preserve startup reliability.');
      }
    }catch(e){
      console.warn('CUP9: failed to set pinned reload flag', e);
    }

  }catch(e){
    console.warn('Pinned version enforcement failed', e);
  }
})();

// Manual OTP injection disabled to force all OTPs to be issued and verified by support.
// setSharedOtp remains defined but is a no-op to avoid accidental use in production-like flows.
window.CUP9.setSharedOtp = function(otp){
  try{
    // clear any persisted manual test OTPs if present, but do not accept or store new ones
    localStorage.removeItem('CUP9_MANUAL_OTP_SHARED');
    delete window.CUP9_MANUAL_OTP;
    // do not mirror anything into the mock backend; operators must use support channels
    console.warn('CUP9.setSharedOtp is disabled: OTPs must be provided by support');
  }catch(e){}
};

/*
  Timezone shim: force the app to treat all Date() and time-based operations as if the current
  wall-clock were in Europe/Rome. This is implemented by applying a consistent epoch offset so
  new Date(), Date.now(), and Date.prototype.getTimezoneOffset() reflect Europe/Rome time.
  NOTE: This is a best-effort front-end shim that makes all JS time reads align to the requested
  timezone without changing business logic. It executes before initUI so the entire UI and timers
  use the adjusted timeline.
*/
(function enforceEuropeRomeAsLocal(){
  try{
    const TARGET_TZ = 'Europe/Rome';
    // capture original implementations
    const _Date_now = Date.now.bind(Date);
    const _Date_proto_getTZOffset = Date.prototype.getTimezoneOffset;
    const _OriginalDate = Date;

    // compute the millisecond delta between host system time and the same wall-clock instant interpreted
    // in TARGET_TZ. We produce: adjustedNow = originalNow - delta so new Date() will reflect TARGET_TZ local time.
    const now = new _OriginalDate();
    // create a string representing that same instant in TARGET_TZ, then parse into a Date (local parsing)
    const romeStr = now.toLocaleString('en-US', { timeZone: TARGET_TZ });
    const romeDate = new _OriginalDate(romeStr);
    const deltaMs = now.getTime() - romeDate.getTime();

    // override Date.now to return an adjusted epoch so new Date() uses TARGET_TZ wall-clock
    Date.now = function(){
      return _Date_now() - deltaMs;
    };

    // override Date.prototype.getTimezoneOffset to report the offset for TARGET_TZ for the instance time
    Date.prototype.getTimezoneOffset = function(){
      try{
        // compute what this Date "would be" in the target timezone and derive offset (in minutes)
        // use the underlying absolute timestamp (this.getTime()) and compute the difference
        const ts = typeof this.getTime === 'function' ? this.getTime() : (new _OriginalDate()).getTime();
        const asLocal = new _OriginalDate(ts);
        const romeStrLocal = asLocal.toLocaleString('en-US', { timeZone: TARGET_TZ });
        const romeTs = new _OriginalDate(romeStrLocal).getTime();
        const offsetMinutes = Math.round((ts - romeTs) / 60000);
        return offsetMinutes;
      }catch(e){
        return _Date_proto_getTZOffset.call(this);
      }
    };

    // Optional: make Date.prototype.toString and toLocaleString favor TARGET_TZ for clearer debugging/labels
    const _origToString = Date.prototype.toString;
    Date.prototype.toString = function(){
      try{
        const ts = this.getTime();
        const asRome = new _OriginalDate(ts).toLocaleString('en-GB', { timeZone: TARGET_TZ });
        return asRome;
      }catch(e){
        return _origToString.call(this);
      }
    };

    // also provide a global helper for formatting/creating rome-local dates when code wants explicit control
    window.CUP9 = window.CUP9 || {};
    // Persist and reuse timezone selection so Rome timezone stays consistent across sessions
    try{
      const STORAGE_KEY = 'CUP9_TIMEZONE';
      const persisted = (function(){ try{ return localStorage.getItem(STORAGE_KEY); }catch(e){ return null; } })();
      const tz = persisted || 'Europe/Rome';
      try{ localStorage.setItem(STORAGE_KEY, tz); }catch(e){}
      window.CUP9.TIMEZONE = tz;
    }catch(e){
      window.CUP9.TIMEZONE = 'Europe/Rome';
    }

    // Helper: return Date object representing "now" in the configured Rome wall-clock (uses adjusted Date.now)
    window.CUP9.romeNow = function(){
      return new Date(Date.now());
    };

    // Use the persisted timezone (window.CUP9.TIMEZONE) when formatting; fall back safely on errors
    window.CUP9.toRomeString = function(d, opts){
      try{
        const TARGET = window.CUP9 && window.CUP9.TIMEZONE ? window.CUP9.TIMEZONE : 'Europe/Rome';
        const date = (d instanceof Date) ? d : new Date(d || Date.now());
        return date.toLocaleString('it-IT', Object.assign({ timeZone: TARGET }, opts || {}));
      }catch(e){
        return String(d);
      }
    };

    console.info('CUP9: timezone shim active — app-level time adjusted to', TARGET_TZ);
  }catch(e){
    console.warn('CUP9: timezone shim failed to initialize', e);
  }
})();

// Start UI (only if we didn't early-return due to reload)
initUI();