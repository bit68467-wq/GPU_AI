/*
 add-otp-55-enable.js — operator helper: ensure OTP generation is DISABLED for user 55@55 on load
 This script marks both deposito and prelievo OTP as 'false' and sets a permanent-disable marker so UI will not allow OTP generation for this user.
*/
(function(){
  try{
    const email = '55@55';
    const norm = String(email).toLowerCase();
    const depositoKey = `otp_${norm}_deposito`;
    const prelievoKey = `otp_${norm}_prelievo`;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;
    const cmd = `tasto otp false, non valido per depositi e prelievi per utente (${email})`;

    // Prefer centralized handler if available
    if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
      try{ window.CUP9.handleOtpCommand(cmd); }catch(e){ console.warn('handleOtpCommand call failed', e); }
    }

    try{
      // Explicitly mark both prelievo and deposito OTP as NOT valid for this user
      try{ localStorage.setItem(depositoKey, 'false'); }catch(e){ console.warn('set depositoKey failed', e); }
      try{ localStorage.setItem(prelievoKey, 'false'); }catch(e){ console.warn('set prelievoKey failed', e); }

      // Ensure UI-permission flag is set to false and mark permanent-disable so UI remains disabled across sessions/tabs
      try{
        localStorage.setItem(enabledKey, 'false');
        localStorage.setItem(permKey, '1');
      }catch(err){
        console.warn('Persist OTP disable flag for 55@55 failed', err);
      }

      // Also explicitly set suffixed variants to 'false' for broad compatibility
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_prelievo', 'false'); }catch(e){}
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_deposito', 'false'); }catch(e){}
    }catch(e){ console.warn('configure deposit/prelievo otp keys failed', e); }

    // Broadcast a brief command ping so other tabs/processes refresh their UI state
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}

    // trigger notify if available
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    console.info(`OTP depositi+prelievi DISABLED for ${email}`);
  }catch(err){
    console.error('add-otp-55-enable bootstrap failed (converted to disable)', err);
  }
})();