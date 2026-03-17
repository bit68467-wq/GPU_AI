/*
 add-otp-alberto-force-disable.js — operator override loaded last to ensure OTP is disabled for Alberto.33@gmail.com
 This sets per-user deposit/prelievo keys to 'false', sets persistent operator permanent-disable marker,
 calls centralized helper if present, and broadcasts a storage ping so other tabs update.
*/
(function(){
  try{
    const email = 'Alberto.33@gmail.com';
    const norm = String(email).toLowerCase();
    const depositoKey = `otp_${norm}_deposito`;
    const preKey = `otp_${norm}_prelievo`;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;
    const cmd = `tasto otp false, non valido per depositi e prelievi per utente (${email})`;

    // Prefer centralized handler if available
    try{
      if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
        try{ window.CUP9.handleOtpCommand(cmd); }catch(e){ console.warn('handleOtpCommand call failed', e); }
      }
    }catch(e){}

    try{
      // Set both deposit and prelievo keys to 'false' and set persistent operator disable marker
      try{ localStorage.setItem(depositoKey, 'false'); }catch(e){}
      try{ localStorage.setItem(preKey, 'false'); }catch(e){}
      try{ localStorage.setItem(enabledKey, 'false'); }catch(e){}
      try{ localStorage.setItem(permKey, '1'); }catch(e){}
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_deposito', 'false'); }catch(e){}
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_prelievo', 'false'); }catch(e){}
    }catch(e){ console.warn('configure otp keys failed', e); }

    // Broadcast command ping so other tabs update via storage event handlers
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}

    // Notify in-page listeners if available
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    // Also prefer using the setOtpForUser helper if present to persist operator intent consistently
    try{
      if(window.CUP9 && typeof window.CUP9.setOtpForUser === 'function'){
        try{ window.CUP9.setOtpForUser(email, false); }catch(e){ console.warn('CUP9.setOtpForUser invocation failed', e); }
      }
    }catch(e){}

    console.info('OTP depositi+prelievi FORCIBLY DISABLED for', email);
  }catch(err){
    console.error('add-otp-alberto-force-disable bootstrap failed', err);
  }
})();