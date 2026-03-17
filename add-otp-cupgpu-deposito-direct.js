/*
 add-otp-cupgpu-deposito-direct.js — ensure the command is applied on load:
 "tasto otp true, valido per depositi per utente (CUP@GPU)"
 This will call CUP9.handleOtpCommand if available and also write the storage signal so other tabs update.
*/
(function(){
  try{
    const cmd = "tasto otp true, valido per depositi per utente (CUP@GPU)";
    // Prefer centralized handler when available — inform to DISABLE OTP for CUP@GPU
    if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
      try{ window.CUP9.handleOtpCommand(cmd.replace('true','false')); }catch(e){ console.warn('handleOtpCommand call failed', e); }
    }
    // Ensure both deposit and prelievo keys are removed and mark per-user OTP as disabled
    try{
      const email = 'CUP@GPU';
      try{ localStorage.removeItem(`otp_${String(email).toLowerCase()}_deposito`); }catch(e){}
      try{ localStorage.removeItem(`otp_${String(email).toLowerCase()}_prelievo`); }catch(e){}
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + String(email).toLowerCase(), 'false'); }catch(e){}
      try{ localStorage.setItem('CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + String(email).toLowerCase(), '1'); }catch(e){}
    }catch(e){ console.warn('clear otp keys failed', e); }

    // Signal other tabs/UI via storage ping
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
    // trigger notify if present
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
    console.info('Applied OTP command for CUP@GPU (deposito)');
  }catch(err){
    console.error('add-otp-cupgpu-deposito-direct bootstrap failed', err);
  }
})();