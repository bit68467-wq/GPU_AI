/*
 add-otp-cupgpu-deposito-override.js — operator override to mark:
 "tasto otp false, non valido per prelievi per utente (CUP@GPU)"
 This sets the per-user enabled flag to false and explicitly marks prelievo (withdrawal) OTP as not valid,
 invokes the centralized handler if present, and broadcasts a storage ping so other tabs update.
*/
(function(){
  try{
    const email = 'CUP@GPU';
    const norm = String(email).toLowerCase();
    const depositoKey = `otp_${norm}_deposito`;
    const preKey = `otp_${norm}_prelievo`;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const cmd = `tasto otp false, non valido per prelievi per utente (${email})`;

    // Persist explicit per-user enable for deposits and remove permanent-disable marker
    try{
      // set per-user enabled flag to true for deposits and clear permanent-disable
      localStorage.setItem(enabledKey, 'true');
    }catch(e){}
    try{ localStorage.removeItem(permKey); }catch(e){}

    // Ensure deposit key is armed for deposits and explicitly mark prelievo (withdrawal) as false so withdrawals are not valid
    try{ localStorage.setItem(depositoKey, 'armed'); }catch(e){}
    try{ localStorage.setItem(preKey, 'false'); }catch(e){}
    // Also persist operator-level disable for prelievo so other tabs/clients respect the decision
    try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_prelievo', 'false'); }catch(e){}

    // Prefer centralized handler if present (inform it of the disable command)
    try{
      if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
        window.CUP9.handleOtpCommand(cmd);
      }
    }catch(e){ console.warn('CUP9.handleOtpCommand invocation failed', e); }

    // Broadcast storage ping to update other tabs/UI
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
    try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_UPDATED', JSON.stringify({ email: norm, enabled: false, ts: Date.now() })); }catch(e){}
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}
    console.info('Override: OTP ARMED for depositi for', email);
  }catch(err){
    console.error('add-otp-cupgpu-deposito-override failed', err);
  }
})();