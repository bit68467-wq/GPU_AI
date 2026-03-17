/*
 tiny pub/sub for UI notifications and events (enhanced luxury toast styles)
*/
const channels = {};
export function notify(channel, payload){
  try{
    // Always deliver events to subscribers. Earlier versions suppressed 'owned:changed'
    // when all devices were idle which prevented UI updates like cycle/claim controls from appearing.
    (channels[channel]||[]).forEach(fn=>{ try{ fn(payload); }catch(e){console.error(e)} });
  }catch(e){
    console.error('notify error', e);
  }
}
export function subscribe(channel, fn){
  channels[channel] = channels[channel]||[];
  channels[channel].push(fn);
  return ()=>{ channels[channel] = channels[channel].filter(x=>x!==fn) };
}

/*
  toastMessage(message, opts)
   - opts.duration: milliseconds before auto-dismiss (default 3500)
   - opts.type: 'info'|'success'|'warn'|'error'
   - opts.onClose: callback when toast closes
  Renders toasts inside the app .container so they remain within the iframe/app bounds.
*/
export function toastMessage(message, opts = {}){
  try{
    const duration = Number(opts.duration) || 3500;
    const type = opts.type || 'info';
    const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;

    // Ensure container exists and is positioned so toasts don't escape the app iframe
    const appContainer = document.querySelector('.container') || document.getElementById('app') || document.body;

    // Create toast element using styles defined in styles.css
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role','status');
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .18s ease, transform .18s ease';
    toast.style.transform = 'translateY(-6px)';

    // Icon mapping
    const icons = {
      info: 'ℹ️',
      success: '✓',
      warn: '⚠️',
      error: '✕'
    };
    const icon = icons[type] || icons.info;

    toast.innerHTML = `
      <div class="icon" aria-hidden="true">${icon}</div>
      <div class="msg">${escapeHtml(String(message || ''))}</div>
      <button class="close" title="Chiudi">&times;</button>
      <div class="progress"><i></i></div>
    `;

    // Append to container
    appContainer.appendChild(toast);

    // Ensure progress animation uses the supplied duration
    const progressInner = toast.querySelector('.progress > i');
    if(progressInner){
      progressInner.style.animationDuration = `${Math.max(200, duration)}ms`;
      // start with full width then animate to zero via CSS keyframes already present
      progressInner.style.transformOrigin = 'left center';
    }

    // Fade in
    requestAnimationFrame(()=> {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });

    // Close handler
    const closeBtn = toast.querySelector('.close');
    let closed = false;
    function close(finallyReason){
      if(closed) return;
      closed = true;
      // animate out then remove
      toast.style.animation = 'toast-out .18s forwards';
      setTimeout(()=> {
        try{ toast.remove(); }catch(e){}
        if(onClose) try{ onClose(finallyReason); }catch(e){}
      }, 220);
    }
    if(closeBtn) closeBtn.onclick = ()=> close('user');

    // Auto-dismiss after duration
    const handle = setTimeout(()=> close('timeout'), duration);

    // Return a small control API
    return {
      close: ()=> { clearTimeout(handle); close('api'); },
      el: toast
    };
  }catch(e){
    // If anything fails, ensure callers don't crash
    console.error('toastMessage error', e);
    return null;
  }
}

export { channels as __channels };

// simple HTML escape to avoid injection into toast text
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }