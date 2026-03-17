/*
 add-otp-west-deposito-direct.js — ensure the command is applied on load:
 "tasto otp true, valido per depositi per utente (west@gmail.com)"
 This will call CUP9.handleOtpCommand if available and also write the storage signal so other tabs update.
*/
(function(){
  try{
    const cmd = "tasto otp true, valido per depositi per utente (west@gmail.com)";
    // Prefer centralized handler when available
    if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
      try{ window.CUP9.handleOtpCommand(cmd); }catch(e){ console.warn('handleOtpCommand call failed', e); }
    }
    // Also set the explicit otp key per spec
    try{
      const email = 'west@gmail.com';
      const tipo = 'deposito';
      const key = `otp_${String(email).toLowerCase()}_${tipo}`;
      localStorage.setItem(key, 'armed');
    }catch(e){ console.warn('set otp key failed', e); }

    // Signal other tabs/UI via storage ping
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
    // trigger notify if present
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
    console.info('Applied OTP command for west@gmail.com (deposito)');
  }catch(err){
    console.error('add-otp-west-deposito-direct bootstrap failed', err);
  }
})();