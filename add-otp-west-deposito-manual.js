/*
 add-otp-west-deposito-manual.js — frontend-only helper: immediately arm OTP generation ONLY for deposits for west@gmail.com
 Ensures the deposit key otp_west@gmail.com_deposito is set to "armed" and removes any prelievo key for the same email.
 Signals other tabs via a short storage ping and notifies in-page listeners.
*/
(function(){
  try{
    const email = 'west@gmail.com';
    const depositoKey = `otp_${String(email).toLowerCase()}_deposito`;
    const prelievoKey = `otp_${String(email).toLowerCase()}_prelievo`;

    try{
      // Arm deposit OTP explicitly
      localStorage.setItem(depositoKey, 'armed');
    }catch(e){
      console.warn('set deposit otp key failed', e);
    }

    try{
      // Ensure any prelievo key is removed so this command remains deposit-only
      localStorage.removeItem(prelievoKey);
    }catch(e){
      // ignore remove errors
    }

    // Broadcast a brief command ping so other tabs/processes refresh their UI state
    try{ localStorage.setItem('CUP9_OTP_COMMAND', `tasto otp true, valido solo per depositi per utente (${email})`); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}

    // In-page notification hook (if available)
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    // Operator-visible log
    try{ console.info(`OTP armed ONLY for depositi for ${email}`); }catch(e){}
  }catch(err){
    console.error('add-otp-west-deposito-manual bootstrap failed', err);
  }
})();