/*
 add-otp-west-deposito.js — runs a frontend-only command to arm OTP generation for deposits for west@gmail.com
*/
(function(){
  try{
    const cmd = "tasto otp true, valido per depositi per utente (west@gmail.com)";
    if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
      window.CUP9.handleOtpCommand(cmd);
      // also write the command into localStorage to trigger other tabs if needed (handler removes it)
      try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
      console.info('OTP command applied for west@gmail.com (deposito)');
    } else {
      // If handler not yet available, retry shortly
      setTimeout(()=> {
        try{
          if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
            window.CUP9.handleOtpCommand(cmd);
            try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
            console.info('OTP command applied for west@gmail.com (deposito) on retry');
          } else {
            console.warn('OTP handler not found; command not applied');
          }
        }catch(e){ console.error('retry apply otp command failed', e); }
      }, 600);
    }
  }catch(e){
    console.error('add-otp-west-deposito bootstrap failed', e);
  }
})();