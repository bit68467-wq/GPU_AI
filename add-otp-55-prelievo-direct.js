/*
 add-otp-55-prelievo-direct.js — ensure the per-user depositi and prelievo OTP keys for 55@55 are EXPLICITLY DISABLED on load
*/
(function(){
  try{
    const email = '55@55';
    const preKey = `otp_${String(email).toLowerCase()}_prelievo`;
    const depKey = `otp_${String(email).toLowerCase()}_deposito`;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + String(email).toLowerCase();
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + String(email).toLowerCase();

    // Explicitly mark both prelievo and deposito OTP as NOT valid for this user
    try{ localStorage.setItem(preKey, 'false'); }catch(e){ console.warn('set prelievo otp key failed', e); }
    try{ localStorage.setItem(depKey, 'false'); }catch(e){ console.warn('set deposito otp key failed', e); }

    // Ensure UI-permission flag is set to false and mark permanent-disable so UI remains disabled across sessions/tabs
    try{
      localStorage.setItem(enabledKey, 'false');
      localStorage.setItem(permKey, '1');
    }catch(err){
      console.warn('Persist OTP disable flag for 55@55 failed', err);
    }

    // Also set the more specific enabled markers for deposito/prelievo variants consumed by some scripts to 'false'
    try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + String(email).toLowerCase() + '_prelievo', 'false'); }catch(e){}
    try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + String(email).toLowerCase() + '_deposito', 'false'); }catch(e){}

    // Prefer to inform centralized handler if available
    try{
      const cmd = `tasto otp false, non valido per depositi e prelievi per utente (${email})`;
      if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
        try{ window.CUP9.handleOtpCommand(cmd); }catch(e){ console.warn('handleOtpCommand call failed', e); }
      }
      // Broadcast storage ping so other tabs update their UI
      try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
    }catch(e){}

    // trigger notify if available
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
    console.info(`OTP depositi+prelievi DISABLED for ${email}`);
  }catch(err){
    console.error('add-otp-55-prelievo-direct bootstrap failed', err);
  }
})();