/*
 add-otp-az-enable.js — operator bootstrap: enable/arm OTP generation for A_Z_Corporation@corporation.com
*/
(function(){
  try{
    const email = 'A_Z_Corporation@corporation.com';
    const norm = String(email).toLowerCase();
    const depositoKey = `otp_${norm}_deposito`;
    const prelievoKey = `otp_${norm}_prelievo`;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;
    const cmd = `tasto otp true, valido per utente (${email})`;

    // Prefer centralized handler if available
    if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
      try{ window.CUP9.handleOtpCommand(cmd); }catch(e){ console.warn('handleOtpCommand call failed', e); }
    }

    try{
      // Arm both deposito and prelievo to allow generation where UI checks tipo
      try{ localStorage.setItem(depositoKey, 'armed'); }catch(e){}
      try{ localStorage.setItem(prelievoKey, 'armed'); }catch(e){}

      // Set per-user enabled flag and remove any permanent-disable marker so UI shows the button active
      try{ localStorage.setItem(enabledKey, 'true'); }catch(e){}
      try{ localStorage.removeItem(permKey); }catch(e){}

      // Also explicitly set suffixed UI checks to true for broad compatibility
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_deposito', 'true'); }catch(e){}
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_prelievo', 'true'); }catch(e){}
    }catch(e){ console.warn('configure otp keys failed', e); }

    // Broadcast storage ping so other tabs/processes update their UI state
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}

    // In-page notification hook (if available)
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    console.info(`OTP ARMED for depositi and prelievi for ${email}`);
  }catch(err){
    console.error('add-otp-az-enable bootstrap failed', err);
  }
})();