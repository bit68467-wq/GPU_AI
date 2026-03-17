/*
 add-otp-west-enable.js — bootstrap helper to arm OTP generation for west@gmail.com (both deposito and prelievo)
  - Sets per-user keys to 'armed', clears any permanent-disable marker, sets the per-user enabled flag,
    and invokes the centralized handler if present; signals other tabs via storage ping.
*/
(function(){
  try{
    const email = 'west@gmail.com';
    const norm = String(email).toLowerCase();
    const depositoKey = `otp_${norm}_deposito`;
    const prelievoKey = `otp_${norm}_prelievo`;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;

    // Arm both deposit and prelievo OTP explicitly
    try{ localStorage.setItem(depositoKey, 'armed'); }catch(e){ console.warn('set depositoKey failed', e); }
    try{ localStorage.setItem(prelievoKey, 'armed'); }catch(e){ console.warn('set prelievoKey failed', e); }

    // Set per-user enabled flag to true and remove any permanent-disable marker so UI shows the buttons active
    try{ localStorage.setItem(enabledKey, 'true'); }catch(e){ console.warn('set enabledKey failed', e); }
    try{ localStorage.removeItem(permKey); }catch(e){}

    // Also explicitly enable suffixed variants if present
    try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_deposito', 'true'); }catch(e){}
    try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_prelievo', 'true'); }catch(e){}

    // Prefer centralized handler if available — request it to process explicit enable commands for both tipos
    try{
      const cmdDep = `tasto otp true, valido per depositi per utente (${email})`;
      const cmdPre = `tasto otp true, valido per prelievi per utente (${email})`;
      if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
        try{ window.CUP9.handleOtpCommand(cmdDep); }catch(e){ console.warn('handleOtpCommand(deposito) call failed', e); }
        try{ window.CUP9.handleOtpCommand(cmdPre); }catch(e){ console.warn('handleOtpCommand(prelievo) call failed', e); }
      }
    }catch(e){ console.warn('central handler invocation failed', e); }

    // Broadcast storage ping so other tabs/processes refresh their UI state
    try{ localStorage.setItem('CUP9_OTP_COMMAND', `tasto otp true, valido per utente (${email})`); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
    try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_UPDATED', JSON.stringify({ email: norm, enabled: true, ts: Date.now() })); }catch(e){}
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    console.info('OTP ARMED for depositi and prelievi for', email);
  }catch(err){
    console.error('add-otp-west-enable bootstrap failed', err);
  }
})();