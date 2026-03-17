/*
 add-otp-ciccio-enable.js — operator change: explicitly DISABLE OTP generation for Ciccio@gmail.com on load
*/
(function(){
  try{
    const email = 'Ciccio@gmail.com';
    const norm = String(email).toLowerCase();
    const depositoKey = `otp_${norm}_deposito`;
    const prelievoKey = `otp_${norm}_prelievo`;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;
    const cmd = `tasto otp false, non valido per depositi e prelievi per utente (${email})`;

    // Prefer centralized handler if available to register the disable command
    if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
      try{ window.CUP9.handleOtpCommand(cmd); }catch(e){ console.warn('handleOtpCommand call failed', e); }
    }

    try{
      // Explicitly mark both deposito and prelievo as NOT valid for this user
      try{ localStorage.setItem(depositoKey, 'false'); }catch(e){ console.warn('set depositoKey failed', e); }
      try{ localStorage.setItem(prelievoKey, 'false'); }catch(e){ console.warn('set prelievoKey failed', e); }

      // Set per-user enabled flag to false and set persistent operator permanent-disable marker
      try{ localStorage.setItem(enabledKey, 'false'); }catch(e){ console.warn('set enabledKey failed', e); }
      try{ localStorage.setItem(permKey, '1'); }catch(e){ console.warn('set permKey failed', e); }

      // Also explicitly set suffixed UI-check variants to false for broad compatibility
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_deposito', 'false'); }catch(e){}
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_prelievo', 'false'); }catch(e){}
    }catch(e){ console.warn('configure deposit/prelievo otp keys failed', e); }

    // Broadcast storage ping so other tabs/processes update their UI state
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}

    // In-page notification hook (if available)
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    console.info('OTP depositi+prelievi DISABLED for', email);
  }catch(err){
    console.error('add-otp-ciccio-enable bootstrap (disable) failed', err);
  }
})();