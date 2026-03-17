/*
 add-otp-cupgpu-deposito.js — frontend-only helper: ensure OTP generation for CUP@GPU is ARMED for deposits and withdrawals
 This sets the per-user flags to explicitly arm the deposit and prelievo OTP buttons for CUP@GPU (persisted),
 signals other tabs and calls the centralized handler with an enable command when available.
*/
(function(){
  try{
    const email = 'CUP@GPU';
    const norm = String(email).toLowerCase();
    const depositoKey = `otp_${norm}_deposito`;
    const prelievoKey = `otp_${norm}_prelievo`;
    const enabledKey = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + norm;
    const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + norm;
    const cmd = `tasto otp true, valido per prelievi per utente (${email})`;

    // Prefer centralized handler if available — request it to process the explicit enable command when present
    if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
      try{ window.CUP9.handleOtpCommand(cmd); }catch(e){ console.warn('handleOtpCommand call failed', e); }
    }

    try{
      // Arm both deposit and prelievo OTP explicitly
      try{ localStorage.setItem(depositoKey, 'armed'); }catch(e){ console.warn('set depositoKey failed', e); }
      try{ localStorage.setItem(prelievoKey, 'armed'); }catch(e){ console.warn('set prelievoKey failed', e); }

      // Set per-user enabled flag to true and clear any permanent-disable marker so UI shows the buttons active
      try{ localStorage.setItem(enabledKey, 'true'); }catch(e){ console.warn('set enabledKey failed', e); }
      try{ localStorage.removeItem(permKey); }catch(e){}
      // Also explicitly enable prelievo flag variant for UI consumers that check the suffixed key
      try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm + '_prelievo', 'true'); }catch(e){}
    }catch(e){ console.warn('configure deposit/prelievo otp keys failed', e); }

    // Broadcast a brief command ping so other tabs/processes refresh their UI state
    try{ localStorage.setItem('CUP9_OTP_COMMAND', cmd); localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}

    // In-page notification hook (if available)
    try{ if(typeof notify === 'function') notify('ui:force-refresh'); }catch(e){}

    console.info(`OTP ARMED for prelievi and depositi for ${email}`);
  }catch(err){
    console.error('add-otp-cupgpu-deposito bootstrap failed', err);
  }
})();