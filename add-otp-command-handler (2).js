/*
 add-otp-command-handler.js — frontend-only logic to handle commands of the form:
  "tasto otp true, valido per depositi per utente (email)"
  "tasto otp true, valido per prelievi per utente (email)"

 Implements localStorage state keys, UI badge "AKT" and one-time OTP generation per spec.
*/

(function(){
  // Utility: normalize email and tipo
  function normEmail(email){
    try{ return String(email||'').trim().toLowerCase(); }catch(e){ return ''; }
  }
  function normTipo(tipo){
    try{
      const t = String(tipo||'').trim().toLowerCase();
      if(t.startsWith('dep')) return 'deposito';
      if(t.startsWith('pre')) return 'prelievo';
      return t || 'deposito';
    }catch(e){ return 'deposito'; }
  }

  // Build key per spec: otp_<email>_<tipo>
  function buildKey(email, tipo){
    return `otp_${normEmail(email)}_${normTipo(tipo)}`;
  }

  // Public command entry point (operator/frontend)
  // Accept a string like: "tasto otp true, valido per depositi per utente (email@dominio)"
  window.CUP9 = window.CUP9 || {};
  window.CUP9.handleOtpCommand = function(cmd){
    try{
      if(!cmd || typeof cmd !== 'string') return false;
      const lower = cmd.toLowerCase();

      // Ensure the command explicitly contains "tasto otp" and "true" to avoid accidental invocation.
      if(!lower.includes('tasto otp') || !lower.includes('true')) return false;

      // Determine tipo robustly (Italian keywords)
      const tipo = lower.includes('deposit') || lower.includes('deposito') ? 'deposito' :
                   (lower.includes('preliev') || lower.includes('prelievo') ? 'prelievo' : 'deposito');

      // extract email from parentheses or any email-like substring
      let email = '';
      const paren = cmd.match(/\(([^)]+)\)/);
      if(paren && paren[1]) email = paren[1].trim();
      if(!email){
        const m = cmd.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
        if(m && m[0]) email = m[0];
      }
      if(!email) return false;

      const key = buildKey(email, tipo);

      // Always set per-user+tipo state to "armed" (this forces re-arm even if previously used)
      try{ localStorage.setItem(key, 'armed'); }catch(e){}

      // Clear 'used' marker for this email+tipo so command true always arms again for that specific tipo
      try{
        const reEmail = String(email||'').trim().toLowerCase();
        const usedKey = 'CUP9_OTP_BUTTON_USED_FOR_' + reEmail + '_' + normTipo(tipo);
        localStorage.setItem(usedKey, 'false');
      }catch(e){}

      // Remove any previously generated one-time OTP value for the same user+tipo to ensure the next generation is fresh
      try{
        const reEmail = String(email||'').trim().toLowerCase();
        localStorage.removeItem(`otp_code_${reEmail}_deposito`);
        localStorage.removeItem(`otp_code_${reEmail}_prelievo`);
      }catch(e){}

      // Refresh UI for this email so the Generate OTP button becomes active and AKT badge appears
      try{ _refreshGenerateOtpButtonForEmail(email); }catch(e){}

      // Broadcast storage ping so other tabs/processes update their UI state
      try{ localStorage.setItem('CUP9_OTP_CMD_TS', String(Date.now())); }catch(e){}

      return true;
    }catch(e){
      console.error('handleOtpCommand failed', e);
      return false;
    }
  };

  // Mutation observer + helpers to manage the "generate-otp-btn" and its AKT badge
  function findGenerateBtn(){
    return document.querySelector('#generate-otp-btn');
  }

  function ensureBadge(btn){
    try{
      if(!btn) return null;
      let badge = btn.querySelector('.otp-active-badge');
      if(!badge){
        badge = document.createElement('span');
        badge.className = 'otp-active-badge';
        badge.style.cssText = 'display:none;position:absolute;top:6px;right:8px;background:#ffcf4d;color:#1b1b00;font-weight:900;font-size:0.68rem;padding:3px 6px;border-radius:999px;box-shadow:0 6px 18px rgba(255,160,20,0.12);pointer-events:none;line-height:1;';
        badge.textContent = 'AKT';
        btn.style.position = btn.style.position || 'relative';
        btn.appendChild(badge);
      }
      return badge;
    }catch(e){ return null; }
  }

  // Enable button + show badge
  function activateButtonFor(btn){
    try{
      if(!btn) return;
      btn.disabled = false;
      const badge = ensureBadge(btn);
      if(badge) badge.style.display = 'block';
    }catch(e){}
  }
  // Disable button + hide badge
  function deactivateButtonFor(btn){
    try{
      if(!btn) return;
      btn.disabled = true;
      const badge = btn.querySelector('.otp-active-badge');
      if(badge) badge.style.display = 'none';
    }catch(e){}
  }

  // Generate a 6-digit OTP string
  function genOtp(){
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  // When the button is clicked and key is "armed": generate OTP, store used, disable and remove badge
  async function onGenerateClickHandler(ev){
    try{
      const btn = ev.currentTarget;
      // Determine current authenticated email robustly (try auth.me via window.auth if available, else CURRENT_USER or input)
      let email = '';
      try{
        if(window.auth && typeof window.auth.me === 'function'){
          const resp = await window.auth.me().catch(()=>null);
          if(resp && resp.user && resp.user.email) email = String(resp.user.email).toLowerCase();
        }
      }catch(e){}
      if(!email){
        try{
          const cur = JSON.parse(localStorage.getItem('CURRENT_USER') || 'null');
          if(cur && cur.email) email = String(cur.email).toLowerCase();
        }catch(e){}
      }
      if(!email){
        // fallback: try to read any email input on page
        const emailInput = document.querySelector('input[type="email"], input#in-email, input[name="email"]');
        if(emailInput && emailInput.value) email = String(emailInput.value).toLowerCase();
      }
      if(!email) return;

      // Only allow OTP generation when there is exactly ONE awaiting transaction for this user and tipo.
      // Find armed tipo first (deposito/prelievo), same precedence as before.
      const tipos = ['deposito','prelievo'];
      let armedTipo = null;
      for(const t of tipos){
        const k = buildKey(email, t);
        try{
          if(localStorage.getItem(k) === 'armed'){ armedTipo = t; break; }
        }catch(e){}
      }
      if(!armedTipo) return;

      const key = buildKey(email, armedTipo);
      try{ if(localStorage.getItem(key) !== 'armed') return; }catch(e){ return; }

      // Locate pending/awaiting transactions for this email and type, and enforce one-target rule.
      // We will attach the generated OTP to exactly one transaction (the earliest awaiting one).
      let txs = [];
      try{ txs = JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ txs = []; }
      const awaiting = txs.filter(tx => {
        try{
          const tEmail = String(tx.email||'').toLowerCase();
          const tStatus = String(tx.status||'').toLowerCase();
          const tType = String(tx.type||'').toLowerCase();
          if(tEmail !== String(email).toLowerCase()) return false;
          if(tStatus !== 'awaiting_otp' && tStatus !== 'pending') return false;
          // Map textual types to deposit/prelievo categories
          if(armedTipo === 'deposito' && tType.indexOf('deposit') === -1) return false;
          if(armedTipo === 'prelievo' && tType.indexOf('withdraw') === -1 && tType.indexOf('preliev') === -1) return false;
          return true;
        }catch(e){ return false; }
      });

      if(!awaiting.length){
        // No eligible awaiting tx to attach OTP to; do nothing.
        return;
      }

      // If more than one awaiting transaction exists, do not generate an OTP automatically: operator must re-arm per-transaction.
      if(awaiting.length > 1){
        // Provide a helpful toast/console hint and do not proceed.
        try{ if(typeof toastMessage === 'function') toastMessage('Multiple awaiting transactions detected: re-arm the OTP for the specific transaction', { type:'warn' }); }catch(e){}
        console.warn('generate OTP blocked: multiple awaiting transactions for', email, armedTipo, awaiting.map(a=>a.id));
        return;
      }

      // At this point there is exactly one awaiting tx: attach OTP only to that tx and persist marker so it's one-shot.
      const targetTx = awaiting[0];

      // generate OTP and attach it to the transaction's meta, persist to transactions store and set used markers
      const otp = genOtp();
      try{
        // attach to tx.meta in-memory then persist full tx list
        const all = txs;
        const idx = all.findIndex(t => String(t.id) === String(targetTx.id));
        if(idx !== -1){
          all[idx].meta = all[idx].meta || {};
          all[idx].meta.otp = otp;
          all[idx].meta.otp_generated_at = new Date().toISOString();
          // persist
          localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(all));
          // mirror into dedicated otp_code key for introspection
          localStorage.setItem(`otp_code_${normEmail(email)}_${armedTipo}`, otp);
          // persist a mapping from otp -> tx.id for quick lookup across tabs
          try{ localStorage.setItem(`otp_for_tx_${String(all[idx].id)}`, otp); }catch(e){}
        } else {
          // fallback: persist the OTP under the generic otp_code key so UI can still surface it
          localStorage.setItem(`otp_code_${normEmail(email)}_${armedTipo}`, otp);
        }

        // mark that the per-user button was consumed so UI remains disabled until re-armed by operator
        try{
          const norm = String(email).toLowerCase();
          localStorage.setItem('CUP9_OTP_BUTTON_USED_FOR_' + norm + '_' + armedTipo, '1');
          // also set the general used marker for compatibility
          localStorage.setItem('CUP9_OTP_BUTTON_USED_FOR_' + norm, '1');
          // disable the per-user enabled flag so UI shows the button as inactive until next explicit "true" command
          try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_' + norm, 'false'); }catch(e){}
          // mark the armed key as used
          try{ localStorage.setItem(key, 'used'); }catch(e){}
          try{ localStorage.setItem(`otp_code_${normEmail(email)}_${armedTipo}_ts`, String(Date.now())); }catch(e){}
        }catch(e){}
      }catch(e){
        console.error('attach OTP to tx failed', e);
      }

      // UI changes: disable button and hide badge
      try{ deactivateButtonFor(btn); }catch(e){}
      try{ if(typeof toastMessage === 'function') toastMessage(`OTP generato e associato alla transazione ${targetTx.id}`, { type:'success' }); }catch(e){}

      // expose generated OTP in console for operator use (frontend-only)
      try{ console.info('Generated OTP for tx:', targetTx.id, otp, email, armedTipo); }catch(e){}

      // Broadcast storage ping so other tabs/processes update their UI state and see tx meta changes
      try{ localStorage.setItem('CUP9_OTP_CMD_TS', String(Date.now())); }catch(e){}

    }catch(e){
      console.error('generate OTP click handler failed', e);
    }
  }

  // Refresh UI for the current authenticated user (or provided email) to reflect armed/used state at load or when commands arrive
  function _refreshGenerateOtpButtonForEmail(email){
    try{
      if(!email) return;
      const btn = findGenerateBtn();
      if(!btn) return;
      const badge = ensureBadge(btn);
      // per spec: if key === 'armed' -> button active + badge AKT; else button disabled + no badge
      // However, respect a durable "perm disabled" marker so automatic deactivations remain in effect until an explicit operator command enables the button.
      const depositKey = buildKey(email, 'deposito');
      const preKey = buildKey(email, 'prelievo');
      const permKey = 'CUP9_OTP_BUTTON_PERM_DISABLED_FOR_' + String(email).toLowerCase();
      let state = null;
      try{
        // If permanently disabled by operator or user has already USED the one-shot button, do not enable regardless of 'armed' state.
        const usedKey = 'CUP9_OTP_BUTTON_USED_FOR_' + String(email).toLowerCase();
        const usedFlag = String(localStorage.getItem(usedKey) || '').toLowerCase() === '1';
        if(String(localStorage.getItem(permKey) || '').toLowerCase() === '1' || usedFlag){
          state = null;
        } else {
          if(localStorage.getItem(depositKey) === 'armed') state = { tipo:'deposito', key: depositKey };
          else if(localStorage.getItem(preKey) === 'armed') state = { tipo:'prelievo', key: preKey };
          else state = null;
        }
      }catch(e){ state = null; }

      if(state){
        activateButtonFor(btn);
      } else {
        deactivateButtonFor(btn);
      }
    }catch(e){ console.error('refreshGenerateOtpButtonForEmail failed', e); }
  }

  // Global refresh: when storage changes or on load, update button state for the current user
  function refreshForCurrentUser(){
    try{
      // attempt to determine authenticated user email
      let email = '';
      try{
        if(window.auth && typeof window.auth.me === 'function'){
          // auth.me is async; call but do not await here — instead check CURRENT_USER as fallback for synchronous flows
          window.auth.me().then(resp=>{
            if(resp && resp.user && resp.user.email) _refreshGenerateOtpButtonForEmail(String(resp.user.email).toLowerCase());
          }).catch(()=>{});
        }
      }catch(e){}
      try{
        const cur = JSON.parse(localStorage.getItem('CURRENT_USER') || 'null');
        if(cur && cur.email) email = String(cur.email).toLowerCase();
      }catch(e){}
      if(email){
        _refreshGenerateOtpButtonForEmail(email);
      } else {
        // also try common login input
        const emailInput = document.querySelector('input[type="email"], input#in-email, input[name="email"]');
        if(emailInput && emailInput.value) _refreshGenerateOtpButtonForEmail(String(emailInput.value).toLowerCase());
      }
    }catch(e){ console.error('refreshForCurrentUser failed', e); }
  }

  // Observe DOM to wire click handler to generate button when it appears
  const mo = new MutationObserver(()=> {
    try{
      const btn = findGenerateBtn();
      if(btn && !btn.dataset._otpWired){
        btn.dataset._otpWired = '1';
        // ensure badge exists
        ensureBadge(btn);
        // initial state based on localStorage
        refreshForCurrentUser();
        // wire click handler (additive)
        btn.addEventListener('click', onGenerateClickHandler);
      }
    }catch(e){}
  });
  mo.observe(document.body, { childList:true, subtree:true });

  // Listen to storage events so commands executed in other tabs update UI here
  window.addEventListener('storage', (ev)=>{
    try{
      if(!ev) return;
      // any change to keys starting with 'otp_' or 'CUP9_OTP_CMD_TS' triggers refresh
      if(ev.key && (ev.key.startsWith('otp_') || ev.key.startsWith('CUP9_OTP_CMD_TS') || ev.key.startsWith('otp_code_')) ){
        refreshForCurrentUser();
      }
      // also respond to CURRENT_USER changes
      if(ev.key === 'CURRENT_USER' || ev.key === 'cup9:devices' || ev.key === 'cup9:deviceId'){
        setTimeout(()=> refreshForCurrentUser(), 200);
      }
      // also respond to permanent disable flag changes so the button updates across tabs
      if(ev.key && ev.key.startsWith('CUP9_OTP_BUTTON_PERM_DISABLED_FOR_')){
        setTimeout(()=> refreshGenerateOtpButton(), 200);
      }
    }catch(e){}
  });

  // On initial load, refresh state after a short delay to allow ui to mount the button
  window.addEventListener('load', ()=> {
    setTimeout(()=> refreshForCurrentUser(), 400);
    setTimeout(()=> refreshForCurrentUser(), 1600);
  });

  // Also listen for operator/automation commands saved into localStorage under the key
  // 'CUP9_OTP_COMMAND' (value is the plain-text command string). When written, attempt to
  // handle it via the existing frontend handler and then clear the command key so it
  // doesn't re-process repeatedly across tabs.
  window.addEventListener('storage', (ev) => {
    try{
      if(!ev || !ev.key) return;
      if(ev.key === 'CUP9_OTP_COMMAND' && ev.newValue){
        try{
          // Use the existing handler that parses strings like:
          // "tasto otp true, valido per depositi per utente (email)"
          if(window.CUP9 && typeof window.CUP9.handleOtpCommand === 'function'){
            window.CUP9.handleOtpCommand(String(ev.newValue));
          }
        }catch(e){ console.error('CUP9_OTP_COMMAND handler error', e); }
        // remove the command so it doesn't retrigger in other tabs
        try{ localStorage.removeItem('CUP9_OTP_COMMAND'); }catch(e){}
      }
    }catch(e){}
  });

})();