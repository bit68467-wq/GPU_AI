/*
 add-otp-alberto-ensure-enable.js — ensure OTP generation is armed/enabled for Alberto.33@gmail.com (runs last)
 This sets per-user deposit/prelievo keys to 'armed', clears any permanent-disable marker, sets the per-user enabled flag,
 invokes the centralized handler if present, and broadcasts a storage ping so other tabs update.
*/
(function(){
  try{
    const email = 'Alberto.33@gmail.com';
    const norm = String(email).toLowerCase();
    const depositoKey = `otp_${norm}_deposito`;
    const prelievoKey = `otp_${norm}_prelievo`;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;
    const cmd = `tasto otp true, valido per utente (${email})`;

    try{
      // Arm both deposito and prelievo explicitly
      try{ localStorage.setItem(depositoKey, 'armed'); }catch(e){}
      try{ localStorage.setItem(prelievoKey, 'armed'); }catch(e){}

      // Set per-user enabled flag and remove any permanent-disable marker
      try{ localStorage.setItem(enabledKey, 'true'); }catch(e){}
      try{ localStorage.removeItem(permKey); }catch(e){}

      // Also enable suffixed UI-check keys for compatibility
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_deposito', 'true'); }catch(e){}
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_prelievo', 'true'); }catch(e){}
    }catch(e){ console.warn('configure otp keys failed', e); }

    // Prefer centralized handler if available
    try{
      if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
        window.CUP9.handleOtpCommand(cmd);
      }
    }catch(e){ console.warn('handleOtpCommand call failed', e); }

    // Broadcast storage ping so other tabs/processes update their UI state
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
    try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_UPDATED', JSON.stringify({ email: norm, enabled: true, ts: Date.now() })); }catch(e){}
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    console.info('OTP ARMED/ENABLED for depositi and prelievi for', email);
  }catch(err){
    console.error('add-otp-alberto-ensure-enable bootstrap failed', err);
  }
})();