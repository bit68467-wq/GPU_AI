/*
 enforce-boost-license.js — persistently enforce Boost availability per-user based on active licenses.
 - Writes localStorage key CUP9_BOOST_AVAILABLE_FOR_<email> = '1'|'0'
 - Ensures UI buttons with id/class used by Tasks/Boost check this flag and disables Boost when missing.
 - Listens to auth/me, owned/licenses changes and storage events to keep state current.
*/
import { auth } from './auth.js';

(function(){
  const FLAG_PREFIX = 'CUP9_BOOST_AVAILABLE_FOR_';

  function normEmail(e){ try{ return String(e||'').toLowerCase(); }catch(e){ return ''; } }

  function hasActiveLicenseForEmail(email){
    try{
      const norm = normEmail(email);
      if(!norm) return false;
      const now = new Date();
      let licenses = [];
      try{ licenses = JSON.parse(localStorage.getItem('CUP9_LICENSES') || '[]') || []; }catch(e){ licenses = []; }
      const activeLocal = (licenses || []).some(l => {
        try{
          const owner = String(l.ownerEmail || l.owner || '').toLowerCase();
          const until = l.valid_until ? new Date(l.valid_until) : null;
          const ownerMatch = owner === norm;
          const notExpired = !until || (until > now);
          return ownerMatch && notExpired;
        }catch(e){ return false; }
      });
      if(activeLocal) return true;
      // fallback to mock API db if present
      try{
        if(window.api && api && api.__internal__ && api.__internal__.db && api.__internal__.db.licenses){
          const mock = Object.values(api.__internal__.db.licenses || {}).some(l=>{
            try{
              const owner = String(l.ownerEmail || l.owner || '').toLowerCase();
              const until = l.valid_until ? new Date(l.valid_until) : null;
              const ownerMatch = owner === norm;
              const notExpired = !until || (until > now);
              return ownerMatch && notExpired;
            }catch(e){ return false; }
          });
          if(mock) return true;
        }
      }catch(e){}
      return false;
    }catch(e){
      return false;
    }
  }

  function setBoostFlag(email){
    try{
      const norm = normEmail(email);
      if(!norm) return;
      const ok = hasActiveLicenseForEmail(norm);
      try{ localStorage.setItem(FLAG_PREFIX + norm, ok ? '1' : '0'); }catch(e){}
      // broadcast a small ping so UI that listens to storage events updates immediately
      try{ localStorage.setItem('CUP9_BOOST_FLAG_UPDATED_AT', String(Date.now())); localStorage.removeItem('CUP9_BOOST_FLAG_UPDATED_AT'); }catch(e){}
      return ok;
    }catch(e){ return false; }
  }

  // disable any in-page boost buttons (common selectors used by modals/pages)
  function applyBoostUiStateForEmail(email){
    try{
      const norm = normEmail(email);
      if(!norm) return;
      const flag = String(localStorage.getItem(FLAG_PREFIX + norm) || '0') === '1';
      // selectors to cover Boost buttons in Tasks modals and profile/home UIs
      const selectors = [
        '#boost-btn',
        '.boost-btn',
        'button[id^="boost-"]',
        'button[data-action="boost"]'
      ];
      selectors.forEach(sel=>{
        try{
          const el = document.querySelector(sel);
          if(!el) return;
          if(flag){
            el.disabled = false;
            el.style.opacity = '';
            el.title = el.title || 'Applica Boost';
          } else {
            el.disabled = true;
            el.style.opacity = '0.6';
            el.title = 'Boost disabilitato: richiede licenza attiva';
          }
        }catch(e){}
      });
      // also update any boost-status textual hints
      try{
        const statusEls = document.querySelectorAll('#boost-status, .boost-status');
        statusEls.forEach(s=>{
          try{ s.textContent = flag ? 'Disponibile' : 'Richiede licenza attiva'; }catch(e){}
        });
      }catch(e){}
    }catch(e){}
  }

  // refresh for current authenticated user
  async function refreshForCurrentUser(){
    try{
      let meResp = null;
      try{ meResp = await auth.me().catch(()=>null); }catch(e){ meResp = null; }
      let email = meResp && meResp.user && meResp.user.email ? String(meResp.user.email).toLowerCase() : null;
      if(!email){
        try{
          const cur = JSON.parse(localStorage.getItem('CURRENT_USER') || 'null');
          if(cur && cur.email) email = String(cur.email).toLowerCase();
        }catch(e){}
      }
      if(!email) return;
      setBoostFlag(email);
      applyBoostUiStateForEmail(email);
    }catch(e){ console.error('refreshForCurrentUser error', e); }
  }

  // react to storage events and known notifications to keep state in sync
  window.addEventListener('storage', (ev)=>{
    try{
      if(!ev) return;
      // if licenses changed or flags updated, recompute for current user and apply UI
      if(ev.key && (ev.key.startsWith('CUP9_LICENSES') || ev.key.startsWith('CUP9_LICENSES_UPDATED') || ev.key.startsWith('CUP9_BOOST_FLAG_UPDATED_AT') || ev.key === 'CURRENT_USER' || ev.key && ev.key.startsWith('CUP9_OTP_BUTTON_ENABLED_FOR_'))){
        setTimeout(()=> refreshForCurrentUser(), 120);
      }
    }catch(e){}
  });

  // Subscribe to UI notifications if available (owned/licences changes)
  try{
    if(typeof notify === 'function' && typeof subscribe === 'function'){
      subscribe('owned:changed', ()=> setTimeout(()=> refreshForCurrentUser(), 120));
      subscribe('schedules:changed', ()=> setTimeout(()=> refreshForCurrentUser(), 120));
      subscribe('ui:force-refresh', ()=> setTimeout(()=> refreshForCurrentUser(), 120));
    }
  }catch(e){}

  // compute & persist boost availability for all known users (applies to every registered user)
  function recomputeForAllUsers(){
    try{
      // load persisted users list (CUP9_USERS) and any mock DB users
      let users = [];
      try{ users = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]') || []; }catch(e){ users = []; }
      try{
        if(window.api && api && api.__internal__ && api.__internal__.db && api.__internal__.db.users){
          const mockUsers = Object.values(api.__internal__.db.users || {}).map(u => ({ email: String(u.email||'').toLowerCase() }));
          for(const mu of mockUsers){
            if(mu && mu.email && !users.find(x => String(x.email||'').toLowerCase() === mu.email)) users.push({ email: mu.email });
          }
        }
      }catch(e){ /* ignore */ }

      // For each discovered user email, compute and persist boost flag
      for(const u of users){
        try{
          const email = String(u.email || '').toLowerCase();
          if(!email) continue;
          setBoostFlag(email);
        }catch(e){}
      }
      // Also refresh current user UI after mass update
      try{ refreshForCurrentUser(); }catch(e){}
    }catch(e){
      console.error('recomputeForAllUsers failed', e);
    }
  }

  // initial run on load and also react to explicit license store changes
  function scheduleInitialRefresh(){
    try{
      // compute for current user quickly
      setTimeout(()=> refreshForCurrentUser(), 200);
      setTimeout(()=> refreshForCurrentUser(), 800);
      setTimeout(()=> refreshForCurrentUser(), 1600);
      // also compute availability for all known users (idempotent, safe)
      try{ setTimeout(()=> recomputeForAllUsers(), 400); }catch(e){}
    }catch(e){}
  }

  // run at startup
  scheduleInitialRefresh();

  // If the licenses list is updated elsewhere, ensure boost flags recompute immediately
  window.addEventListener('storage', (ev) => {
    try{
      if(!ev || !ev.key) return;
      // watch license store and related keys that may affect boost availability
      if(ev.key === 'CUP9_LICENSES' || ev.key === 'CUP9_LICENSES_UPDATED' || ev.key === 'CUP9_LICENSES_REFRESH' || ev.key === 'CUP9_LICENSES_CHANGE'){
        // small debounce via timeout to allow the write to complete
        setTimeout(()=> refreshForCurrentUser(), 120);
      }
      // also refresh on current user changes
      if(ev.key === 'CURRENT_USER' || ev.key === 'cup9:deviceId' || ev.key === 'cup9:devices'){
        setTimeout(()=> refreshForCurrentUser(), 120);
      }
    }catch(e){}
  });

  // expose immediate recompute for admin/debug use
  window.CUP9 = window.CUP9 || {};
  window.CUP9.forceRecomputeBoostForCurrent = function(){
    try{ refreshForCurrentUser(); return true; }catch(e){ return false; }
  };

  // Expose helper admin API
  window.CUP9 = window.CUP9 || {};
  window.CUP9.recomputeBoostFlag = async function(email){
    try{ return setBoostFlag(email); }catch(e){ return false; }
  };

})();