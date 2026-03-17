/*
 add-otp-55-enable.js — operator helper: ensure OTP generation is ARMED/ENABLED for user 55@55 on load
 This script marks both deposito and prelievo OTP as 'armed' and sets the per-user enabled flag so the UI can generate OTPs for this user.
*/
(function(){
  try{
    const email = '55@55';
    const norm = String(email).toLowerCase();
    const depositoKey = `otp_${norm}_deposito`;
    const prelievoKey = `otp_${norm}_prelievo`;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;
    const cmd = `tasto otp true, valido per depositi e prelievi per utente (${email})`;

    // Prefer centralized handler if available
    if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
      try{ window.CUP9.handleOtpCommand(cmd); }catch(e){ console.warn('handleOtpCommand call failed', e); }
    }

    try{
      // Arm both deposito and prelievo to allow generation where UI checks tipo
      try{ localStorage.setItem(depositoKey, 'armed'); }catch(e){ console.warn('set depositoKey failed', e); }
      try{ localStorage.setItem(prelievoKey, 'armed'); }catch(e){ console.warn('set prelievoKey failed', e); }

      // Set per-user enabled flag and remove any permanent-disable marker so UI shows the button active
      try{ localStorage.setItem(enabledKey, 'true'); }catch(e){ console.warn('set enabledKey failed', e); }
      try{ localStorage.removeItem(permKey); }catch(e){}

      // Also explicitly enable suffixed variants if present
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_deposito', 'true'); }catch(e){}
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_prelievo', 'true'); }catch(e){}
    }catch(e){ console.warn('configure deposit/prelievo otp keys failed', e); }

    // Broadcast storage ping so other tabs/processes update their UI state
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}

    // In-page notification hook (if available)
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    console.info('OTP ARMED for depositi and prelievi for', email);
  }catch(err){
    console.error('add-otp-55-enable bootstrap failed', err);
  }
})();