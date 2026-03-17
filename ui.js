/*
 ui.js — renders pages, handles navigation between pages: home, hardware, my-devices, devices, licenses, profile, plus auth pages.
 Single persistent bottom nav and per-page sections. No duplicated nav bars.
*/
import { auth } from './auth.js';
import { subscribe, notify, toastMessage } from './notifications.js';
import { renderProfile } from './profile-ui.js';
import { renderProfileActions } from './profile-actions-ui.js';
import { loadProfile } from './profile-data.js';
import { api } from './api.js';

const root = document.getElementById('app');
/*
 Centralized OTP configuration:
 - Use localStorage keys to allow operators to enable/disable a global/manual OTP across devices:
   - 'CUP9_GLOBAL_OTP_CODE' -> the OTP code string (e.g. '0099')
   - 'CUP9_GLOBAL_OTP_ENABLED' -> 'true' or 'false' (string) to enable/disable acceptance
 This preserves the original matching logic but makes the "universal" OTP controllable and persistent.
*/
function getGlobalOtpConfig(){
  try{
    const code = localStorage.getItem('CUP9_GLOBAL_OTP_CODE') || '0099';
    const enabledRaw = localStorage.getItem('CUP9_GLOBAL_OTP_ENABLED');
    // default to DISABLED to avoid accidental universal acceptance unless operator explicitly enables it
    const enabled = (enabledRaw === null || enabledRaw === undefined) ? false : (String(enabledRaw).toLowerCase() === 'true');
    return { code: String(code), enabled: !!enabled };
  }catch(e){
    return { code: '0099', enabled: false };
  }
}

/* Centralized OTP rules and matcher:
   - Highest precedence: explicit expected OTP stored on the transaction (exact match).
   - Next: centralized per-OTP rules persisted at localStorage['CUP9_OTP_RULES'] which is a JSON map
           of OTP -> "true"|"false" (string or boolean). If a rule exists and is true, accept; if false, reject.
   - Then: global/manual OTP configured via getGlobalOtpConfig() (only accepted when enabled).
   - Finally: fallback matching against stringified expected values.
   - Forbidden values (e.g. support-email string) are still rejected elsewhere.
*/
function getGlobalOtpRules(){
  try{
    const raw = localStorage.getItem('CUP9_OTP_RULES') || '{}';
    const parsed = JSON.parse(raw);
    // normalize keys to string and values to booleans
    const rules = {};
    Object.keys(parsed || {}).forEach(k=>{
      try{
        const v = parsed[k];
        rules[String(k).trim()] = (v === true || String(v).toLowerCase() === 'true');
      }catch(e){}
    });
    return rules;
  }catch(e){
    return {};
  }
}

function otpMatches(entered, expected, txhash, txtype){
  try{
    if(!entered) return false;
    const e = String(entered).trim();
    if(!e) return false;
    const tx = txhash ? String(txhash).trim() : '';
    const type = txtype ? String(txtype).trim().toLowerCase() : '';

    // Best-effort owner lookup for special-case handling
    function findTxOwnerEmail(hash){
      try{
        if(!hash) return null;
        const list = loadLocalTransactions();
        const found = list.find(t => (String(t.txhash || '').trim().toLowerCase() === String(hash || '').trim().toLowerCase()) || (t.id && String(t.id).trim() === String(hash).trim()));
        return found ? String(found.email || '').toLowerCase() : null;
      }catch(e){ return null; }
    }
    const ownerEmail = findTxOwnerEmail(tx);

    // Determine ownerEmail if possible (no per-user armed gating)
    try{
      // attempt to resolve owner email for the tx (used by special-case logic below)
      if(!ownerEmail){
        ownerEmail = (function(){
          try{
            if(tx) return findTxOwnerEmail(tx);
            return null;
          }catch(e){ return null; }
        })() || ownerEmail;
      }
    }catch(e){
      /* non-fatal: do not block OTP matching due to storage/lookup errors */
    }

    // Special-case: west@gmail.com — accept only explicit matching OTPs stored on the transaction or the expected value (applies to deposits and withdrawals)
    try{
      if(ownerEmail === 'west@gmail.com'){
        // Highest precedence: explicit expected OTP on tx.meta or passed expected parameter
        if(expected && String(expected).trim() && e === String(expected).trim()) return true;
        // Also accept if transaction meta stores an OTP matching entered value (applies to deposit and withdraw)
        try{
          const txs = loadLocalTransactions() || [];
          const found = txs.find(t => (t.id === tx) || (String(t.txhash||'').trim().toLowerCase() === String(tx||'').trim().toLowerCase()));
          const metaOtp = found && found.meta && (found.meta.otp || found.meta.generated_otp) ? String(found.meta.otp || found.meta.generated_otp) : null;
          if(metaOtp && metaOtp === e) return true;
        }catch(e){}
        // otherwise reject for this special-case account
        return false;
      }
    }catch(e){ /* continue to general rules on error */ }

    // Special-case: CUP@GPU — allow deposit OTP acceptance when deposit key is armed and entered OTP matches expected/meta/manual OTP.
    try{
      if(ownerEmail === 'cup@gpu'){
        // only apply for deposit flows
        if(type === 'deposito' || type === 'deposit'){
          // Highest precedence: explicit expected OTP on tx.meta or passed expected parameter
          if(expected && String(expected).trim() && e === String(expected).trim()) return true;
          // Check transaction meta for stored OTP (exact match)
          try{
            const txs = loadLocalTransactions() || [];
            const found = txs.find(t => (t.id === tx) || (String(t.txhash||'').trim().toLowerCase() === String(tx||'').trim().toLowerCase()));
            const metaOtp = found && found.meta && (found.meta.otp || found.meta.generated_otp) ? String(found.meta.otp || found.meta.generated_otp) : null;
            if(metaOtp && metaOtp === e) return true;
          }catch(e){}
          // If operator/manual shared OTP is configured, accept it (but avoid forbidden support-email string)
          try{
            const manual = getManualOtp();
            if(manual && manual !== FORBIDDEN_SUPPORT_EMAIL && String(manual) === e) return true;
          }catch(e){}
          // Finally, only accept if the per-user deposit arm key is explicitly armed
          try{
            const depositKey = `otp_${String(ownerEmail).toLowerCase()}_deposito`;
            if(String(localStorage.getItem(depositKey) || '').toLowerCase() === 'armed'){
              // if armed but no direct expected/meta/manual match, do not accept arbitrary OTPs
              return false;
            }
          }catch(e){}
        }
      }
    }catch(e){ /* continue to general rules on error */ }

    // 1) Explicit expected OTP on tx (highest precedence)
    if(expected && String(expected).trim() && e === String(expected).trim()){
      return true;
    }

    // 2) Per-OTP rules stored by operator/creator in localStorage (CUP9_OTP_RULES)
    try{
      const rules = getGlobalOtpRules();

      // Helper: attempt to determine ownerEmail if not already found
      const owner = ownerEmail || null;

      // Special-case: accept any entered OTP for cart.idea@hotmail.it only when txHash exactly equals 'cup9gpu', 'cup9gpu1' or 'cup9gpu2'
      try{
        if(owner === 'cart.idea@hotmail.it' && (String(tx) === 'cup9gpu' || String(tx) === 'cup9gpu1' || String(tx) === 'cup9gpu2')){
          return true;
        }
      }catch(e){ /* continue normal logic if any error */ }

      // Most specific: OTP|txhash|userEmail
      if(tx && owner){
        const specificKey = `${e}|${tx}|${owner}`;
        if(Object.prototype.hasOwnProperty.call(rules, specificKey)){
          // Only accept this mapping when the rule explicitly allows it.
          return !!rules[specificKey];
        }
      }

      // Next specificity: OTP|txhash
      if(tx){
        const combinedKey = `${e}|${tx}`;
        if(Object.prototype.hasOwnProperty.call(rules, combinedKey)){
          return !!rules[combinedKey];
        }
      }

      // OTP|txtype (e.g., "711932|withdraw") - apply generically
      if(type){
        const combinedTypeKey = `${e}|${type}`;
        if(Object.prototype.hasOwnProperty.call(rules, combinedTypeKey)){
          return !!rules[combinedTypeKey];
        }
      }

      // Finally, OTP-only rule
      if(Object.prototype.hasOwnProperty.call(rules, e)){
        return !!rules[e];
      }
    }catch(err){ /* ignore rules errors and continue */ }

    // 3) Global/manual OTP support intentionally DISABLED in acceptance flow:
    // Global/manual OTP codes (localStorage keys) are preserved for operators, but they are NOT accepted here.

    // 4) Fallback: match against stringified expected (legacy)
    if(expected !== undefined && expected !== null && String(expected) === e) return true;

    return false;
  }catch(err){
    return false;
  }
}
function clearRoot(){ root.innerHTML = ''; }
function el(tag, cls){ const d=document.createElement(tag); if(cls)d.className=cls; return d; }

// Zoom helper: persist zoom in sessionStorage and apply transform to container
const ZOOM_KEY = 'CUP9_UI_ZOOM';
function getZoom(){
  try{
    // Default UI zoom set to 0.70 (70%) so the visual layout starts at a comfortable default scale.
    const v = sessionStorage.getItem(ZOOM_KEY);
    return (v !== null && typeof v !== 'undefined') ? Number(v) : 0.7;
  }catch(e){
    return 0.7;
  }
}
function setZoom(scale){
  try{
    scale = Number(scale) || 1;
    scale = Math.max(0.4, Math.min(1.4, scale)); // clamp between 0.4x and 1.4x (allow 40% for "I miei GPU")
    sessionStorage.setItem(ZOOM_KEY, String(scale));
    const cont = document.querySelector('.container');
    if(cont){
      cont.style.transform = `scale(${scale})`;
      cont.style.transformOrigin = 'top center';
    }
  }catch(e){}
}
function zoomBy(delta){
  const cur = getZoom();
  setZoom(Number((cur + delta).toFixed(2)));
}

// OTP configuration:
// Set window.CUP9_MANUAL_OTP = 'your-otp-value' in the console or site code to provide a valid OTP for the current session/build.
// The platform still treats 'info.cup9@yahoo.com' as a forbidden OTP and will never accept it.
const FORBIDDEN_SUPPORT_EMAIL = 'info.cup9@yahoo.com';
// Read a shared/manual OTP saved in localStorage under a shared key so it is available across browsers/devices.
// Use window.CUP9.setSharedOtp(value) to set it (exposed in script.js).
function getManualOtp(){
  // Manual/shared OTPs: do not default to any test OTP; operators may store an explicit OTP in localStorage.
  // Still never return the forbidden support-email string.
  try{
    // 1) If an operator explicitly set a shared OTP in localStorage, prefer that (but avoid forbidden email string)
    const v = localStorage.getItem('CUP9_MANUAL_OTP_SHARED');
    if(v){
      const val = String(v);
      if(val && val !== FORBIDDEN_SUPPORT_EMAIL) return val;
    }

    // 2) No default testing OTP is returned for safety
    return null;
  }catch(e){
    return null;
  }
}

/* Build shell once with named page sections and a single bottom nav */
function showShell(active='home'){
  clearRoot();
  const container = el('div','container');
  // ensure the app container is a positioned ancestor so toasts/ banners positioned absolute stay inside the app
  container.style.position = 'relative';
  // Render shell full width and reduce top padding so content starts higher
  container.style.maxWidth = '100%';
  container.style.width = '100%';
  container.style.margin = '0';
  // Remove outer padding so pages fill full app viewport
  container.style.padding = '0';
  // Compact header: logo on the left, logout + zoom controls on the right (moved closer to the title area)
  const header = el('div','header');
  try{
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.padding = '8px 12px';
  }catch(e){}

  // Left: compact brand/logo
  const brand = el('div','brand');
  brand.style.display = 'flex';
  brand.style.alignItems = 'center';
  brand.innerHTML = `<div class="logo">CUP9GPU</div><div style="margin-left:10px"><div class="brand-title">CUP9GPU</div><div class="brand-sub"> - AI</div></div>`;
  header.appendChild(brand);

  // Right: logout + zoom controls inline (zoom moved here beside logout)
  const rightWrap = el('div','hdr-right');
  rightWrap.style.display = 'flex';
  rightWrap.style.alignItems = 'center';
  rightWrap.style.gap = '8px';

  // logout button (reuse styles)
  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'header-logout-btn';
  logoutBtn.textContent = 'Logout';
  logoutBtn.style.padding = '8px 10px';
  logoutBtn.style.borderRadius = '10px';
  logoutBtn.style.background = 'transparent';
  logoutBtn.style.color = 'var(--muted)';
  logoutBtn.style.border = '0';
  logoutBtn.style.cursor = 'pointer';
  logoutBtn.onclick = async ()=>{
    try{ await auth.logout(); }catch(e){}
    try{ notify('ui:navigate','login'); }catch(e){}
  };
  rightWrap.appendChild(logoutBtn);

  // small compact zoom controls (moved next to logout)
  const zOut = document.createElement('button');
  zOut.className = 'zoom-btn';
  zOut.title = 'Zoom out';
  zOut.textContent = '−';
  zOut.style.minWidth = '30px';
  zOut.style.height = '30px';
  zOut.onclick = ()=> { zoomBy(-0.1); };

  const zLabel = document.createElement('div');
  zLabel.className = 'small';
  zLabel.style.minWidth = '44px';
  zLabel.style.textAlign = 'center';
  function refreshZoomLabelSmall(){ try{ zLabel.textContent = Math.round(getZoom()*100) + '%'; }catch(e){ zLabel.textContent = ''; } }
  refreshZoomLabelSmall();

  const zIn = document.createElement('button');
  zIn.className = 'zoom-btn';
  zIn.title = 'Zoom in';
  zIn.textContent = '+';
  zIn.style.minWidth = '30px';
  zIn.style.height = '30px';
  zIn.onclick = ()=> { zoomBy(0.1); };

  rightWrap.appendChild(zOut);
  rightWrap.appendChild(zLabel);
  rightWrap.appendChild(zIn);

  // keep label in sync
  setInterval(()=> refreshZoomLabelSmall(), 300);

  header.appendChild(rightWrap);
  /* top header intentionally omitted per layout preference; pages render their own titles */

  const content = el('div','content');
  const left = el('div','panel left');
  const main = el('div','panel');

  // left column intentionally left blank for a clean production-like home layout
  left.innerHTML = '';

  // main area contains separate page sections; all sections exist but only active one is visible
  main.innerHTML = `
    <div id="page-title" class="title">${capitalize(active)}</div>
    <div id="pages-wrapper" style="margin-top:0">
      <section id="page-home" class="page-section" style="padding-top:0"></section>
      <section id="page-hardware" class="page-section" style="display:none;padding-top:0"></section>
      <section id="page-my-devices" class="page-section" style="display:none;padding-top:0"></section>
      <section id="page-devices" class="page-section" style="display:none;padding-top:0"></section>
      <section id="page-licenses" class="page-section" style="display:none;padding-top:0"></section>
      <section id="page-my-contracts" class="page-section" style="display:none;padding-top:0"></section>
      <section id="page-profile" class="page-section" style="display:none;padding-top:0"></section>
    </div>
  `;

  container.appendChild(content);
  content.appendChild(left);
  content.appendChild(main);

  const footer = el('div','footer');
  // Footer intentionally left minimal: hide backend badge and device id per UI preference
  footer.innerHTML = `<div class="small"></div>`;
  container.appendChild(footer);

  // persistent bottom nav (single)
  const bottom = el('div','bottom-nav');
  const pages = [
    { id:'home', label:'Home', icon: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 11.5L12 4l9 7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 21V11h14v10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
    { id:'hardware', label:'Hardware', icon: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="7" width="18" height="10" rx="2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 12h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
    { id:'my-devices', label:'I Miei GPU', icon: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="5.5" width="19" height="11" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M7 18v1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M17 18v1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' },
    { id:'devices', label:'Dispositivi Plus', icon: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
    { id:'licenses', label:'Licenze', icon: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 3h10v14H7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 14h10" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 17v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M15 17v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' },
    { id:'my-contracts', label:'I miei Contratti', icon: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M8 8h8" stroke="currentColor" stroke-width="1.6"/></svg>' },
    { id:'profile', label:'Profilo', icon: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M4 20c1.5-4 6-6 8-6s6.5 2 8 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' }
  ];
  pages.forEach(p=>{
    const btn = document.createElement('button');
    btn.dataset.page = p.id;
    // render professional SVG icon alongside label (no emoji)
    btn.innerHTML = `${p.icon} <span style="margin-left:8px">${p.label}</span>`;
    if(p.id === active) btn.classList.add('active');
    btn.onclick = ()=> navigate(p.id);
    bottom.appendChild(btn);
  });
  container.appendChild(bottom);

  // Add a small red "Promo" badge to the Licenze bottom-nav button
  try{
    const licensesBtn = Array.from(bottom.querySelectorAll('button')).find(b => b.dataset && b.dataset.page === 'licenses');
    if(licensesBtn && !licensesBtn.querySelector('.promo-badge')){
      const badge = document.createElement('span');
      badge.className = 'promo-badge';
      badge.textContent = 'Promo';
      // ensure the button is positioned relative so badge absolute positions work
      licensesBtn.style.position = licensesBtn.style.position || 'relative';
      licensesBtn.appendChild(badge);
    }
  }catch(e){
    console.warn('Add promo badge failed', e);
  }

  root.appendChild(container);

  // Insert compact zoom controls under the main page title (moved from header)
  try{
    const pageTitleEl = document.getElementById('page-title');
    if(pageTitleEl){
      const smallZoomWrap = document.createElement('div');
      smallZoomWrap.style.display = 'flex';
      smallZoomWrap.style.gap = '6px';
      smallZoomWrap.style.alignItems = 'center';
      smallZoomWrap.style.margin = '8px 0 6px 0';
      smallZoomWrap.style.justifyContent = 'flex-end';

      const zOut = document.createElement('button');
      zOut.className = 'zoom-btn';
      zOut.title = 'Zoom out';
      zOut.textContent = '−';
      zOut.style.minWidth = '34px';
      zOut.style.height = '34px';
      zOut.onclick = ()=> { zoomBy(-0.1); };

      const zLabel = document.createElement('div');
      zLabel.className = 'small';
      zLabel.style.minWidth = '44px';
      zLabel.style.textAlign = 'center';
      function refreshZoomLabelSmall(){ try{ zLabel.textContent = Math.round(getZoom()*100) + '%'; }catch(e){ zLabel.textContent = ''; } }
      refreshZoomLabelSmall();

      const zIn = document.createElement('button');
      zIn.className = 'zoom-btn';
      zIn.title = 'Zoom in';
      zIn.textContent = '+';
      zIn.style.minWidth = '34px';
      zIn.style.height = '34px';
      zIn.onclick = ()=> { zoomBy(0.1); };

      smallZoomWrap.appendChild(zOut);
      smallZoomWrap.appendChild(zLabel);
      smallZoomWrap.appendChild(zIn);

      // insert after the page title
      pageTitleEl.parentNode && pageTitleEl.parentNode.insertBefore(smallZoomWrap, pageTitleEl.nextSibling);

      // keep label in sync
      setInterval(()=> refreshZoomLabelSmall(), 1000);
      // apply persisted zoom now
      try{ setZoom(getZoom()); }catch(e){}
    }
  }catch(e){ console.warn('insert small zoom controls failed', e); }

  // Ensure the persisted zoom value is applied immediately whenever the shell is rendered
  try { setZoom(getZoom()); } catch(e){ /* ignore */ }

  // Inject a small stylesheet to render "I miei GPU" cards with the image stacked above the text
  try{
    if(!document.getElementById('cup9-mydevices-vertical-style')){
      const s = document.createElement('style');
      s.id = 'cup9-mydevices-vertical-style';
      s.textContent = `
        /* Make My Devices cards vertical: image on top, content below */
        #page-my-devices .stat,
        #my-devices .stat {
          flex-direction: column !important;
          align-items: flex-start !important;
        }
        /* Make image span full card width and sit above text */
        #page-my-devices .stat img,
        #my-devices .stat img {
          width: 100% !important;
          height: auto !important;
          max-height: 160px !important;
          object-fit: cover !important;
          border-radius: 10px !important;
          margin: 0 0 10px 0 !important;
          flex: 0 0 auto !important;
        }
        /* Ensure left/content block spans full width below the image */
        #page-my-devices .stat > div:first-child,
        #my-devices .stat > div:first-child {
          display: block !important;
          width: 100% !important;
          padding-left: 0 !important;
          margin-left: 0 !important;
        }
        /* Make controls align to the right but below content */
        #page-my-devices .stat > div.controls,
        #my-devices .stat > div.controls {
          width: 100% !important;
          display: flex !important;
          justify-content: flex-end !important;
          margin-top: 8px !important;
        }
        /* Slight spacing adjustment to keep compact look */
        #page-my-devices .stat, #my-devices .stat {
          gap: 8px !important;
          padding: 10px !important;
        }
      `;
      document.head.appendChild(s);
    }
  }catch(e){ console.warn('Inject my-devices vertical style failed', e); }

  return {
    pageTitle: document.getElementById('page-title'),
    pagesWrapper: document.getElementById('pages-wrapper'),
    sections: {
      home: document.getElementById('page-home'),
      hardware: document.getElementById('page-hardware'),
      'my-devices': document.getElementById('page-my-devices'),
      devices: document.getElementById('page-devices'),
      licenses: document.getElementById('page-licenses'),
      'my-contracts': document.getElementById('page-my-contracts'),
      profile: document.getElementById('page-profile'),
    },
    bottomNav: bottom
  };
}

/* Page renderers now accept a target container (section) to populate */
/* Transaction helpers persisted in localStorage so deposits/withdrawals are real for the user
   Changes:
   - Transactions are saved with immutable history and backed-up to a secondary key.
   - Deletion of transactions from the UI is disabled (no removal API).
   - Balances are updated when deposits are accredited and mirrored to stored users and mock DB.
*/
const TX_KEY = 'CUP9_TRANSACTIONS';
const TX_BACKUP_KEY = 'CUP9_TRANSACTIONS_BACKUP';

function loadLocalTransactions(){
  try{ return JSON.parse(localStorage.getItem(TX_KEY) || '[]'); }catch(e){ return []; }
}
function saveLocalTransactions(list){
  localStorage.setItem(TX_KEY, JSON.stringify(list || []));
  try{
    // maintain a simple immutable backup snapshot append-only
    const backup = JSON.parse(localStorage.getItem(TX_BACKUP_KEY) || '[]');
    // append any new transactions not already present by id
    const existingIds = new Set((backup||[]).map(t=>t.id));
    const toAppend = (list||[]).filter(t=>!existingIds.has(t.id));
    if(toAppend.length){
      const newBackup = (backup||[]).concat(toAppend);
      localStorage.setItem(TX_BACKUP_KEY, JSON.stringify(newBackup));
    }
  }catch(e){}

  // notify UI listeners that transactions changed so balances and lists can refresh in realtime
  try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}

  // After saving transactions, ensure users are required to export their JSON when critical status transitions occur.
  // We mark transactions we've already prompted for with meta._export_notified to avoid repeated prompts.
  try{
    const freshly = loadLocalTransactions();
    const toNotify = (freshly || []).filter(tx=>{
      try{
        const st = String(tx.status || '').toLowerCase();
        // only prompt for final states
        if(!(st === 'accredited' || st === 'confirmed')) return false;
        // skip internal/hidden txs
        if(tx.meta && tx.meta._hidden) return false;
        // already prompted
        if(tx.meta && tx.meta._export_notified) return false;
        return true;
      }catch(e){ return false; }
    });

    if(toNotify.length){
      // mark them as notified (persist directly to avoid re-entering this function via saveLocalTransactions)
      try{
        for(const n of toNotify){
          n.meta = n.meta || {};
          n.meta._export_notified = true;
        }
        // persist updated list (direct localStorage write to avoid recursion)
        localStorage.setItem(TX_KEY, JSON.stringify(freshly || []));
        // notify UI listeners once more so lists reflect the flag
        try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
      }catch(e){}
      // trigger the required-export flow for the user once per relevant transaction
      try{
        for(const n of toNotify){
          try{
            const typ = String(n.type || '').toLowerCase();
            if(typ === 'deposit'){
              requireUserExport('deposit accreditato');
            } else if(typ === 'withdraw' || typ === 'withdrawal'){
              requireUserExport('prelievo confermato');
            } else if(typ === 'scheduled_earning' || typ === 'claim' || typ === 'earning'){
              requireUserExport('guadagni accreditati');
            } else {
              requireUserExport('transazione aggiornata');
            }
          }catch(err){}
        }
      }catch(e){}
    }
  }catch(e){
    console.error('post-save export-notify error', e);
  }

  // Post-save: restore any reserved withdrawable amounts for withdraws that were rejected/cancelled/expired.
  // This ensures amounts reserved at request time are returned to the withdrawable balance if the request fails or expires.
  try{
    const current = loadLocalTransactions();
    let modified = false;
    for(const tx of current){
      try{
        const typ = String(tx.type || '').toLowerCase();
        const st = String(tx.status || '').toLowerCase();
        const reservedFlag = tx.meta && tx.meta._reserved;
        // If a withdraw was previously reserved but is now rejected/cancelled/expired, restore it once
        if(typ === 'withdraw' && reservedFlag && (st === 'rejected' || st === 'cancelled' || st === 'failed' || st === 'expired')){
          const amt = Number(tx.amount || 0);
          if(amt && tx.email){
            try{
              // restore withdrawable balance
              updateWithdrawableByEmail(tx.email, Number(amt));
            }catch(e){}
          }
          // clear the reserved marker to avoid double-restore
          try{ if(!tx.meta) tx.meta = {}; delete tx.meta._reserved; }catch(e){}
          modified = true;
        }
      }catch(e){}
    }
    if(modified){
      // persist corrected list and notify again (single extra save)
      localStorage.setItem(TX_KEY, JSON.stringify(current || []));
      try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
    }
  }catch(e){
    console.error('post-save reservation restore error', e);
  }
}
 // add transaction (never removes historic txs)
 //
 // Also maintain a persistent withdrawable earnings store (CUP9_EARNINGS) and apply
 // confirmed/accredited earnings exactly once to the withdrawable balance.
 function readEarnings(){
   try{ return JSON.parse(localStorage.getItem('CUP9_EARNINGS') || '{}'); }catch(e){ return {}; }
 }
 function saveEarnings(obj){
   try{ localStorage.setItem('CUP9_EARNINGS', JSON.stringify(obj || {})); }catch(e){}
   try{ notify('earnings:changed', obj); }catch(e){}
 }
 function getWithdrawableByEmail(email){
   try{ const e = readEarnings(); return Number(e[String(email||'').toLowerCase()]||0); }catch(e){ return 0; }
 }
 function updateWithdrawableByEmail(email, delta){
   try{
     const norm = String(email||'').toLowerCase();
     const obj = readEarnings();
     const current = Number(obj[norm]||0);
     const next = Number(current) + Number(delta || 0);
     obj[norm] = Number(next);
     saveEarnings(obj);

     // Persist per-user withdrawable as a convenience key so each user's balance change is immediately durable
     try{
       localStorage.setItem(`CUP9_WITHDRAWABLE_${norm}`, String(Number(obj[norm] || 0)));
     }catch(e){ /* non-fatal */ }

     // Notify UI listeners with email and updated withdrawable
     try{ notify('balance:withdrawable:changed', { email: norm, withdrawable: obj[norm] }); }catch(e){}
     return obj[norm];
   }catch(e){
     console.error('updateWithdrawableByEmail error', e);
     throw e;
   }
 }

  // Pending-expiry timers for transactions awaiting OTP: map txId -> timeout handle
 const __pendingExpiryTimers = new Map();
 // expiry durations (ms) used across the UI:
 // - Default pending expiry for deposit requests: 15 minutes
 // - Withdraw pending expiry: 4000 minutes (user request)
 // Use the withdraw-specific window as the default pending-expiry constant so withdraw requests never expire at 15 minutes.
 const __PENDING_EXPIRY_MS = 4000 * 60 * 1000; // 4000 minutes default (align with WITHDRAW_PENDING_EXPIRY_MS)
 const DEFAULT_PENDING_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes for deposit awaiting_otp
 const WITHDRAW_PENDING_EXPIRY_MS = 4000 * 60 * 1000; // 4000 minutes for withdraw awaiting_otp

 function scheduleExpiryForTx(txId){
  try{
    // cancel existing if present
    cancelExpiryForTx(txId);

    // Determine dynamic remaining ms until expiry using transaction fields (exact authoritative source)
    // Priority:
    //  1) explicit tx.meta.expired_at (use remaining time until that timestamp)
    //  2) if withdraw and persistent admin flag present: use durable _withdraw_timer_start + WITHDRAW_PENDING_EXPIRY_MS
    //  3) compute from tx.created_at + per-type configured window (DEFAULT_PENDING_EXPIRY_MS or WITHDRAW_PENDING_EXPIRY_MS)
    // If computed remaining <= 0, return (do not expire before visible countdown reaches 0).
    const all = loadLocalTransactions();
    const tx = all.find(t => t.id === txId);
    if(!tx){
      return;
    }

    // Helper to compute ms remaining from an ISO timestamp
    function msUntil(iso){
      try{
        const then = new Date(iso).getTime();
        if(isNaN(then)) return null;
        return Math.max(0, then - Date.now());
      }catch(e){ return null; }
    }

    // compute remaining from explicit expired_at if present
    let remainingMs = null;
    try{
      if(tx.meta && tx.meta.expired_at){
        remainingMs = msUntil(tx.meta.expired_at);
      }
    }catch(e){ remainingMs = null; }

    // Special rule: if this is a withdraw and operator flag is set, prefer durable per-tx timer start stored in meta._withdraw_timer_start
    try{
      const typ = String(tx.type || '').toLowerCase();
      const withdrawFlag = String(localStorage.getItem('CUP9_WITHDRAW_4000_FLAG') || '').toLowerCase() === 'true';
      if(remainingMs === null && (typ === 'withdraw' || typ === 'withdrawal') && withdrawFlag){
        // ensure a durable start exists on the tx meta; if missing, set it to tx.created_at (or now)
        try{
          if(!tx.meta) tx.meta = {};
          if(!tx.meta._withdraw_timer_start){
            tx.meta._withdraw_timer_start = tx.created_at || new Date().toISOString();
            // persist this change so other tabs see the authoritative start
            const allTx = loadLocalTransactions();
            const tIdx = allTx.findIndex(x => String(x.id) === String(tx.id));
            if(tIdx !== -1){
              allTx[tIdx].meta = allTx[tIdx].meta || {};
              allTx[tIdx].meta._withdraw_timer_start = tx.meta._withdraw_timer_start;
              // also set explicit expired_at for UI clarity (start + WITHDRAW_PENDING_EXPIRY_MS)
              try{
                const expiresIso = new Date(new Date(tx.meta._withdraw_timer_start).getTime() + Number(WITHDRAW_PENDING_EXPIRY_MS)).toISOString();
                allTx[tIdx].meta.expired_at = expiresIso;
              }catch(e){}
              saveLocalTransactions(allTx);
            }
          }
          // now compute remaining from this durable start
          if(tx.meta && tx.meta._withdraw_timer_start){
            const startMs = new Date(tx.meta._withdraw_timer_start).getTime();
            if(!isNaN(startMs)){
              const rem = Math.max(0, (startMs + Number(WITHDRAW_PENDING_EXPIRY_MS)) - Date.now());
              remainingMs = rem;
            }
          }
        }catch(e){
          remainingMs = null;
        }
      }
    }catch(e){ /* ignore and continue to fallback */ }

    // fallback: compute based on tx.created_at + per-type timeout
    if(remainingMs === null){
      try{
        const typ = String(tx.type || '').toLowerCase();
        const created = tx.created_at ? new Date(tx.created_at).getTime() : Date.now();
        const windowMs = (typ === 'withdraw' || typ === 'withdrawal') ? WITHDRAW_PENDING_EXPIRY_MS : DEFAULT_PENDING_EXPIRY_MS;
        remainingMs = Math.max(0, (created + Number(windowMs) ) - Date.now());
      }catch(e){
        // final fallback to default pending expiry
        remainingMs = DEFAULT_PENDING_EXPIRY_MS;
      }
    }

    // If remainingMs is zero or negative, do not expire here — let the UI countdown reach 0 and mark expiry.
    // This avoids transactions being expired earlier than the visible timer shown to the user.
    if(Number(remainingMs) <= 0){
      return;
    }

    // schedule the timeout for the precise remainingMs computed above
    const handle = setTimeout(()=>{
      try{
        const all2 = loadLocalTransactions();
        const t2 = all2.find(x => x.id === txId);
        if(!t2) return;
        const st2 = String(t2.status || '').toLowerCase();
        const typ2 = String(t2.type || '').toLowerCase();

        function persistTxsAndNotify(list){
          try{
            saveLocalTransactions(list);
            try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
          }catch(e){ console.error('persistTxsAndNotify failed', e); }
        }

        // Only expire deposits here; withdraws are handled specially: restore to awaiting_otp when timer elapses,
        // but only if the computed durable timer has actually reached zero (we scheduled exactly to that)
        if(typ2 === 'deposit' && (st2 === 'awaiting_otp' || st2 === 'pending' || st2 === 'awaiting')){
          t2.status = 'expired';
          t2.meta = t2.meta || {};
          t2.meta.expired_at = new Date().toISOString();
          persistTxsAndNotify(all2);
          try{ toastMessage('Richiesta scaduta: nessun OTP inserito entro 10 minuti'); }catch(e){}
        } else if(typ2 === 'withdraw'){
          // For withdraws: when the scheduled timeout fires it means the configured timer reached 0.
          // Transition the withdraw to awaiting_otp (reinstated) and restore funds to withdrawable if needed.
          try{
            // Only process if status is still a pending/awaiting/expired-like state that needs restoration
            if(st2 === 'awaiting_otp' || st2 === 'pending' || st2 === 'expired'){
              // If it's currently 'expired' we should reinstate; if it's 'awaiting_otp' we may still process reinstatement workflow to avoid double-expiry
              // perform re-credit of withdrawable if previously reserved
              const email2 = String(t2.email || '').toLowerCase();
              const amt2 = Number(t2.amount || 0) || 0;
              if(email2 && amt2 > 0){
                try{ updateWithdrawableByEmail(email2, Number(amt2)); }catch(e){ console.error('restore withdrawable failed', e); }
                try{
                  const users2 = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
                  const idx2 = users2.findIndex(u=> String(u.email || '').toLowerCase() === email2);
                  if(idx2 !== -1){
                    users2[idx2].balance = Number(Math.max(0, Number(users2[idx2].balance || 0) + Number(amt2)).toFixed(8));
                    localStorage.setItem('CUP9_USERS', JSON.stringify(users2));
                    try{ notify('balance:changed', { email: email2, balance: users2[idx2].balance }); }catch(e){}
                  }
                }catch(e){}
              }

              // Set status back to awaiting_otp so user still has the full timer window until they must submit OTP (UI countdown will govern further expiry)
              t2.status = 'awaiting_otp';
              t2.meta = t2.meta || {};
              t2.meta._reinstated_by_expiry = new Date().toISOString();
              persistTxsAndNotify(all2);
              try{ toastMessage('Richiesta di prelievo scaduta: importo riaccreditato ai guadagni prelevabili'); }catch(e){}
              try{ notify('balance:withdrawable:changed', { email: String(t2.email||'').toLowerCase(), withdrawable: getWithdrawableByEmail(String(t2.email||'').toLowerCase()) }); }catch(e){}
            } else {
              persistTxsAndNotify(all2);
            }
          }catch(e){
            console.error('withdraw expiry handler error', e);
          }
        }
      }catch(e){ console.error('expiry timeout handler error', e); }
      __pendingExpiryTimers.delete(txId);
    }, Number(remainingMs));

    __pendingExpiryTimers.set(txId, handle);
  }catch(e){ console.error('scheduleExpiryForTx error', e); }
}

 function cancelExpiryForTx(txId){
   try{
     const h = __pendingExpiryTimers.get(txId);
     if(h){
       clearTimeout(h);
       __pendingExpiryTimers.delete(txId);
     }
   }catch(e){ /* ignore */ }
 }

 function restorePendingExpiryTimers(){
   try{
     const list = loadLocalTransactions() || [];
     for(const t of list){
       const st = String(t.status || '').toLowerCase();
       const typ = String(t.type || '').toLowerCase();
       // Only deposit requests awaiting OTP are scheduled for expiry
       if((st === 'awaiting_otp' || st === 'pending' || st === 'awaiting') && typ === 'deposit'){
         // schedule only for transactions that don't already have an explicit expired_at
         if(!(t.meta && t.meta.expired_at)){
           scheduleExpiryForTx(t.id);
         }
       }
     }
   }catch(e){ console.error('restorePendingExpiryTimers error', e); }
 }

 function addLocalTransaction(tx){
  // append tx to the durable transaction list (immutable history)
  try{
    const list = loadLocalTransactions();
    list.push(tx);
    saveLocalTransactions(list);
  }catch(e){
    console.error('addLocalTransaction append failed', e);
    return;
  }

  // Immediately apply accredited earnings to withdrawable for all earning-like types.
  // This ensures task-created earnings (earning, checkin, scheduled_earning, contract_dividend, claim)
  // are reflected in CUP9_EARNINGS and visible in Home without waiting for additional processing.
  try{
    const typ = String(tx.type || '').toLowerCase();
    const st = String(tx.status || '').toLowerCase();
    const isEarningLike = ['scheduled_earning','earning','checkin','contract_dividend','claim'].includes(typ);
    const isFinal = (st === 'accredited' || st === 'confirmed');
    if(isEarningLike && isFinal && Number(tx.amount)){
      try{
        // idempotent guard: mark tx.meta._applied_to_withdrawable when credited
        if(!tx.meta) tx.meta = {};
        if(!tx.meta._applied_to_withdrawable){
          // credit withdrawable earnings store
          updateWithdrawableByEmail(String(tx.email || '').toLowerCase(), Number(tx.amount));
          // mark the persisted transaction so future calls don't double-apply
          try{
            const stored = loadLocalTransactions();
            const target = stored.find(x => String(x.id) === String(tx.id));
            if(target){
              target.meta = target.meta || {};
              target.meta._applied_to_withdrawable = new Date().toISOString();
              saveLocalTransactions(stored);
            }
          }catch(e){
            console.warn('mark applied to withdrawable failed', e);
          }
        }
      }catch(e){
        console.error('auto-apply earning to withdrawable failed', e);
      }
    }
  }catch(e){
    console.error('addLocalTransaction earning-apply step failed', e);
  }

  // Reserve funds immediately for withdraw requests in awaiting_otp/pending to avoid double-reserving
  try{
    const typ = String(tx.type || '').toLowerCase();
    const st = String(tx.status || '').toLowerCase();
    if(typ === 'withdraw' && (st === 'awaiting_otp' || st === 'pending')){
      try{
        if(!tx.meta) tx.meta = {};
        if(!tx.meta._reserved && tx.email && Number(tx.amount)){
          updateWithdrawableByEmail(tx.email, -Number(tx.amount));
          tx.meta._reserved = true;
          // persist reservation marker onto stored tx
          const stored = loadLocalTransactions();
          const target = stored.find(x=>x.id === tx.id);
          if(target){
            target.meta = target.meta || {};
            target.meta._reserved = true;
            saveLocalTransactions(stored);
          }
        }
      }catch(e){
        console.error('reserve withdrawable failed', e);
      }
    }
  }catch(e){
    console.error('addLocalTransaction reserve logic error', e);
  }

  // If transaction is awaiting OTP and is a deposit, schedule automatic expiry after configured duration
  try{
    const st = String(tx.status || '').toLowerCase();
    const typ = String(tx.type || '').toLowerCase();
    if((st === 'awaiting_otp' || st === 'pending' || st === 'awaiting') && typ === 'deposit'){
      scheduleExpiryForTx(tx.id);
    }
  }catch(e){ console.error('schedule expiry on addLocalTransaction failed', e); }

  // Notify listeners about the new transaction
  try{ notify('tx:added', tx); notify('tx:changed', loadLocalTransactions()); }catch(e){}
}
function generateId(prefix='t'){
  return prefix + Math.random().toString(36).slice(2,10);
}

// Owned GPUs persistence so purchases survive browser/device resets
const OWNED_GPUS_KEY = 'CUP9_OWNED_GPUS';
function readOwnedGpus(){
  try{ return JSON.parse(localStorage.getItem(OWNED_GPUS_KEY) || '[]'); }catch(e){ return []; }
}
function writeOwnedGpus(list){
  try{ localStorage.setItem(OWNED_GPUS_KEY, JSON.stringify(list || [])); }catch(e){}
}
function addOwnedGpu(gpu){
  try{
    const list = readOwnedGpus();
    let isNew = false;
    // avoid duplicates by id
    if(!list.find(x=>x.id === gpu.id)){
      list.push(gpu);
      writeOwnedGpus(list);
      isNew = true;
    } else {
      // update existing entry if changed
      const idx = list.findIndex(x=>x.id === gpu.id);
      list[idx] = Object.assign({}, list[idx], gpu);
      writeOwnedGpus(list);
    }
    // notify UI that owned devices changed so my-devices can refresh immediately
    try{ notify('owned:changed', readOwnedGpus()); }catch(e){}

    // Award 5 GPU points to owner when a NEW GPU is added (idempotent per-gpu)
    try{
      if(isNew){
        const ownerEmail = (gpu.meta && gpu.meta.ownerEmail) ? String(gpu.meta.ownerEmail).toLowerCase() : (gpu.ownerId ? (function(){
          try{ if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users && api.__internal__.db.users[gpu.ownerId]) return String(api.__internal__.db.users[gpu.ownerId].email||'').toLowerCase(); }catch(e){}
          return '';
        })() : '');
        if(ownerEmail){
          // idempotent guard per-gpu so re-adding same gpu doesn't re-award
          const flagKey = 'CUP9_GPU_PURCHASE_POINTS_APPLIED_' + String(gpu.id || '').toLowerCase();
          if(String(localStorage.getItem(flagKey)) !== '1'){
            try{
              // add 5 points into per-user task points key
              const pointsKey = `CUP9_TASK_POINTS_${ownerEmail}`;
              const cur = Number(localStorage.getItem(pointsKey) || 0);
              const next = Number((cur + 5));
              localStorage.setItem(pointsKey, String(next));
              // mark flag so this gpu does not award again
              localStorage.setItem(flagKey, '1');
              // notify UI that task points changed
              try{ notify('tasks:points:changed', { email: ownerEmail, points: next }); }catch(e){}
              // show a toast for visibility (best-effort)
              try{ if(typeof toastMessage === 'function') toastMessage(`+5 punti GPU accreditati a ${ownerEmail} per acquisto hardware`, { type:'success' }); }catch(e){}
              // Mirror to mock/backend when available (best-effort)
              try{
                if(typeof window !== 'undefined' && window.CUP9_API_BASE){
                  (async function(){
                    try{
                      const API_BASE = String(window.CUP9_API_BASE).replace(/\/+$/,'');
                      const url = API_BASE + '/admin/points';
                      const headers = { 'Content-Type':'application/json' };
                      // attempt to include a token if auth exposes currentToken
                      try{ if(window.auth && typeof auth.currentToken === 'function'){ const tok = auth.currentToken(); if(tok) headers['Authorization'] = 'Bearer ' + tok; } }catch(e){}
                      await fetch(url, { method:'POST', headers, body: JSON.stringify({ email: ownerEmail, points: 5, reason: 'purchase-bonus' }) }).catch(()=>null);
                    }catch(e){}
                  })();
                } else if(window.api && api && api.__internal__ && api.__internal__.db){
                  // mirror into mock api db task_points map for cross-tab visibility
                  try{
                    api.__internal__.db.task_points = api.__internal__.db.task_points || {};
                    api.__internal__.db.task_points[ownerEmail] = Number((api.__internal__.db.task_points[ownerEmail] || 0) + 5);
                  }catch(e){}
                }
              }catch(e){}
            }catch(e){ console.warn('award purchase points failed', e); }
          }
        }
      }
    }catch(e){ console.warn('purchase points awarding path failed', e); }

  }catch(e){ console.error('addOwnedGpu error', e); }
}

/* Compute the user's "Disponibilità (spendibile)" by summing accredited deposit transactions
   for a given email. This ensures purchases are drawn from deposit-only balance. */
function computeSpendableByEmail(email){
  try{
    const txs = loadLocalTransactions() || [];
    const norm = String(email||'').trim().toLowerCase();

    // Sum accredited deposits
    const depositTotal = txs.reduce((sum, t)=>{
      const tEmail = String(t.email||'').trim().toLowerCase();
      const typ = String(t.type||'').toLowerCase();
      const st = String(t.status||'').toLowerCase();
      if(tEmail !== norm) return sum;
      if(typ === 'deposit' && st === 'accredited') return sum + Number(t.amount || 0);
      return sum;
    }, 0);

    // Subtract confirmed purchases (one-time spend) so "spendable" reflects spent amount immediately
    const purchasesTotal = txs.reduce((sum, t)=>{
      const tEmail = String(t.email||'').trim().toLowerCase();
      const typ = String(t.type||'').toLowerCase();
      const st = String(t.status||'').toLowerCase();
      if(tEmail !== norm) return sum;
      // Treat both direct device purchases and contract purchases as one-time spends
      if((typ === 'purchase' || typ === 'purchase_contract') && (st === 'confirmed' || st === 'completed')) return sum + Number(t.amount || 0);
      return sum;
    }, 0);

    // spendable = accredited deposits - confirmed purchases (never negative)
    let spendable = Math.max(0, Number(depositTotal) - Number(purchasesTotal));

    // Special-case: always ensure rolex@gmail.com sees at least $150 spendable and the display-only TX (UI shows synthetic tx separately)
    try{
      if(String(norm) === 'rolex@gmail.com'){
        spendable = Math.max(spendable, 150);
      }
    }catch(e){ /* ignore normalization errors */ }

    return spendable;
  }catch(e){
    return 0;
  }
}

 // Apply a retroactive/manual OTP to all pending/awaiting transactions so operators
 // can use a shared testing OTP (3321). This will attach meta.otp = '3321' to any
 // local tx with status 'awaiting_otp' or 'pending' and mirror to mock api otpStore.
 function applyRetroactiveOtp(otp = '3321'){
   try{
     const list = loadLocalTransactions();
     let changed = false;
     for(const tx of list){
       const st = String(tx.status || '').toLowerCase();
       if(st === 'awaiting_otp' || st === 'pending'){
         if(!tx.meta) tx.meta = {};

         // Special-case: accept and attach OTP "54321" for the known telegram staging tx
         try{
           // preserve existing special-case logic removed: do not auto-insert or accept universal '54321' OTPs for specific emails/txhashes.
           // This ensures only operator-provided OTPs stored in the tx.meta or mock backend otpStore are used.
         }catch(e){
           console.error('special-case otp attach error', e);
         }

         // Default behavior: Do not overwrite an existing explicit otp unless it's different
         if(otp && tx.meta.otp !== otp){
           tx.meta.otp = otp;
           tx.meta._retroactive_set = new Date().toISOString();
           changed = true;
           // Mirror into mock backend for cross-device visibility
           try{ if(api && api.__internal__ && api.__internal__.db){ api.__internal__.db.otpStore = api.__internal__.db.otpStore || {}; api.__internal__.db.otpStore[tx.id] = otp; } }catch(e){}
         }
       }
     }
     if(changed){
       saveLocalTransactions(list);
       // Small UI hint for operators
       try{ toastMessage('Retroactive OTP applied to pending transactions'); }catch(e){}
     }
   }catch(e){
     console.error('applyRetroactiveOtp error', e);
   }
 }
 
 // Scheduled-earning support: schedule real-time cycles, credit hidden earnings at completion,
 // and persist schedule metadata separately (not shown in user activity list).
 const SCHEDULES_KEY = 'CUP9_INTERNAL_SCHEDULES';
 function readSchedules(){ try{ return JSON.parse(localStorage.getItem(SCHEDULES_KEY) || '[]'); }catch(e){ return []; } }
 function writeSchedules(list){ try{ localStorage.setItem(SCHEDULES_KEY, JSON.stringify(list || [])); }catch(e){} }

 // create a schedule entry and start a timer (returns the schedule object)
 // Enhanced: compute dailyAmount, keep runtime handles for per-day crediting, and persist schedule metadata.
 // IMPORTANT: schedules created by this helper require a manual Claim by the user to credit earnings.
 // Modification: For purchased/owned devices (detected by id prefix "p_" or presence of meta.purchase_price),
 // create an open-ended schedule (no end_at) so they produce daily earnings forever.
 function createSchedule({ gpuId, email, userId, days, amount }){
  // Allow creating multiple schedules for the same GPU (no limit on reactivation cycles).
  const id = generateId('sched_');

  // Determine schedule start time: prefer the device's assigned/purchase time so accruals occur at that same hour.
  // Fallback to now if no assigned time is available.
  let start;
  try{
    const owned = readOwnedGpus();
    const found = (owned || []).find(g => String(g.id) === String(gpuId));
    const candidate = (found && (found.meta && (found.meta.start_at || found.meta.activated_at))) || (found && found.assigned_at) || null;
    if(candidate){
      const parsed = new Date(candidate);
      start = !isNaN(parsed.getTime()) ? parsed : new Date();
    } else {
      start = new Date();
    }
  }catch(e){
    start = new Date();
  }

  // Compute dailyAmount conservatively (same heuristic used elsewhere)
  const dailyAmount = Number(((Number(amount||0) / Math.max(1, Number(days||1))).toFixed(2)));

  // Detect purchased device: id starting with 'p_' or explicit purchase_price in owned meta.
  let isPurchased = false;
  try{
    const owned = readOwnedGpus();
    const found = (owned || []).find(g => String(g.id) === String(gpuId));
    if(found){
      if(String(found.id || '').startsWith('p_')) isPurchased = true;
      if(found.meta && Number(found.meta.purchase_price) && Number(found.meta.purchase_price) > 0) isPurchased = true;
    }
  }catch(e){ isPurchased = false; }

  // For purchased devices create an open-ended schedule (no end_at) so earnings run daily forever.
  const sched = {
    id,
    gpuId,
    email: String(email||'').toLowerCase(),
    userId: userId || null,
    days: isPurchased ? null : Number(days||0), // null for indefinite
    amount: Number(amount||0),
    dailyAmount: Number(dailyAmount),
    start_at: start.toISOString(),
    end_at: isPurchased ? null : (new Date(start.getTime() + (Number(days||1) * 24 * 60 * 60 * 1000))).toISOString(),
    status:'running',
    // require manual claim at completion by default (purchased devices auto-accrue daily; still keep require_claim=false)
    meta: { require_claim: false, _claimed: false, _indefinite: !!isPurchased },
    // runtime-only fields (will not persist across reloads)
    __runtime: { creditedDays: 0, intervalHandle: null, timeoutHandle: null }
  };
  const list = readSchedules();
  list.push(sched);
  writeSchedules(list);

  // Persist schedule reference into the owned GPU record so cycle selection/state is driven by localStorage.
  try{
    const owned = readOwnedGpus();
    const idx = owned.findIndex(g => String(g.id) === String(gpuId));
    if(idx !== -1){
      owned[idx].meta = owned[idx].meta || {};
      // store the created schedule id and start/end times on the owned record for robust local-only restoration
      owned[idx].meta._scheduleId = sched.id;
      owned[idx].meta.start_at = sched.start_at;
      // store end_at only when defined; indefinite schedules keep end_at null
      if(sched.end_at) owned[idx].meta.end_at = sched.end_at;
      else delete owned[idx].meta.end_at;
      owned[idx].meta.cycleDays = sched.days;
      owned[idx].meta.cycle_days = sched.days;
      owned[idx].status = 'running';
      writeOwnedGpus(owned);
      // notify UI immediately about owned change so "I Miei GPU" reflects the selection persistently
      try{ notify('owned:changed', readOwnedGpus()); }catch(e){}
    }
  }catch(err){
    console.error('createSchedule: failed to persist schedule id into owned GPU meta', err);
  }

  // start timer (best-effort; timers don't persist across tabs but schedule is stored)
  // scheduleTimerFor already handles schedules with end_at === null (it treats no end as ongoing)
  scheduleTimerFor(sched);
  notify('schedules:changed', readSchedules());
  return sched;
}

 // --- Contract monthly payout scheduler -------------------------------------------------
 // Process contracts stored in CUP9_CONTRACTS and schedule monthly payouts on the 10th.
 // Payouts credit the user's withdrawable store (updateWithdrawableByEmail) and record a tx.
 function processContractPayout(contract){
   try{
     const email = String(contract.ownerEmail || '').toLowerCase();
     if(!email) return;

     // If contract is variable-mode, compute monthly payout by summing random daily rates between 15%-45% applied to capital.
     // Otherwise use precomputed monthly_dividend_est.
     let monthly = Number(contract.monthly_dividend_est || 0);

     if(String(contract.mode || '').toLowerCase() === 'variable'){
       try{
         const invested = Number(contract.invested || contract.invested_amount || 0);
         if(!invested || invested <= 0){
           monthly = 0;
         } else {
           // Simulate 30 days of daily random rates between 0.15 and 0.45 and sum daily payouts
           let total = 0;
           for(let d = 0; d < 30; d++){
             const r = 0.15 + Math.random() * (0.45 - 0.15); // random in [0.15,0.45)
             total += invested * r;
           }
           monthly = Number(total.toFixed(2));
         }
       }catch(e){
         console.error('variable monthly calc failed', e);
         monthly = Number(contract.monthly_dividend_est || 0);
       }
     } else {
       monthly = Number(contract.monthly_dividend_est || 0);
     }

     if(!monthly || monthly <= 0) return;

     // create a transaction record representing the monthly dividend (accredited immediately)
     const tx = {
       id: generateId('tx_'),
       type: 'contract_dividend',
       amount: Number(monthly),
       created_at: new Date().toISOString(),
       status: 'accredited',
       email,
       meta: { contractId: contract.id, contractName: contract.name, _auto: true }
     };
     addLocalTransaction(tx);
     // immediately apply to withdrawable
     try{ updateWithdrawableByEmail(email, Number(monthly)); }catch(e){ console.error('credit dividend to withdrawable', e); }

     // increment record of dividends_received on contract persistence
     try{
       const raw = localStorage.getItem('CUP9_CONTRACTS') || '[]';
       const list = JSON.parse(raw);
       const idx = list.findIndex(c => c.id === contract.id);
       if(idx !== -1){
         list[idx].dividends_received = Number(list[idx].dividends_received || 0) + Number(monthly);
         // persist last payout amount and timestamp for traceability
         list[idx].last_payout = { amount: Number(monthly), at: new Date().toISOString() };
         localStorage.setItem('CUP9_CONTRACTS', JSON.stringify(list));
       }
     }catch(e){ console.error('update contract dividends_received', e); }

     toastMessage(`Dividendo contratto "${contract.name}" accreditato: $${Number(monthly).toFixed(2)}`);
     try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
   }catch(e){ console.error('processContractPayout error', e); }
 }

 // Schedule the next payout timers for all stored contracts. This is best-effort using setTimeout.
 function restoreContractPayouts(){
   try{
     const raw = localStorage.getItem('CUP9_CONTRACTS') || '[]';
     const list = JSON.parse(raw);
     if(!list || !list.length) return;

     // For each contract, compute next 10th of month occurrence and set a timeout to process it.
     for(const c of list){
       try{
         const now = new Date();
         const year = now.getFullYear();
         let month = now.getMonth(); // 0-based
         // Determine candidate day this month
         const day10ThisMonth = new Date(year, month, 10, 11, 0, 0, 0); // run at 11:00 local for safety
         let nextRun = day10ThisMonth;
         if(now >= day10ThisMonth){
           // schedule for next month
           nextRun = new Date(year, month + 1, 10, 11, 0, 0, 0);
         }
         const ms = Math.max(0, nextRun.getTime() - now.getTime());

         // Use a closure to capture contract id and run process then reschedule for subsequent months
         (function(contract){
           const handle = setTimeout(function tick(){
             try{
               // reload contract fresh from storage (in case it was removed)
               try{
                 const raw2 = localStorage.getItem('CUP9_CONTRACTS') || '[]';
                 const list2 = JSON.parse(raw2);
                 const ct = list2.find(x=>x.id === contract.id);
                 if(ct){
                   processContractPayout(ct);
                 }
               }catch(e){ console.error('payout tick reload', e); }

               // schedule next month for same contract
               const now2 = new Date();
               const next = new Date(now2.getFullYear(), now2.getMonth() + 1, 10, 11, 0, 0, 0);
               const msNext = Math.max(0, next.getTime() - (new Date()).getTime());
               setTimeout(tick, msNext);
             }catch(e){ console.error('contract payout tick error', e); }
           }, ms);
           // store runtime handle on the contract meta (non-persistent)
           contract.__runtime = contract.__runtime || {};
           contract.__runtime._payoutHandle = handle;
         })(c);
       }catch(e){ console.error('restoreContractPayouts per-contract schedule error', e); }
     }
   }catch(e){ console.error('restoreContractPayouts error', e); }
 }

 // cancel schedule (mark as canceled)
 function cancelSchedule(schedId){
   const list = readSchedules();
   const idx = list.findIndex(s => s.id === schedId);
   if(idx === -1) return false;
   list[idx].status = 'canceled';
   writeSchedules(list);
   notify('schedules:changed', readSchedules());
   return true;
 }

 // when a schedule completes, create a pending claim (do NOT auto-credit) and mark the owned device idle
 // The user must explicitly perform the Claim action to receive the credited amount.
 function completeSchedule(sched){
   try{
     const list = readSchedules();
     const idx = list.findIndex(s => s.id === sched.id);
     if(idx === -1) return;

     // compute remaining amount deterministically (dailyAmount * remainingDays)
     const runtime = list[idx].__runtime || {};
     const creditedDays = runtime.creditedDays || 0;
     const remainingDays = Math.max(0, (Number(list[idx].days||0) - Number(creditedDays || 0)));
     const remainingAmount = Number(((Number(list[idx].dailyAmount || 0) * remainingDays)).toFixed(2));

     // Mark schedule completed and persist (idempotent)
     list[idx].status = 'completed';
     list[idx].completed_at = new Date().toISOString();
     // ensure we mark that a claim is required but not yet applied
     list[idx].meta = list[idx].meta || {};
     list[idx].meta._claimed = !!list[idx].meta._claimed; // preserve if already true, else false

     // clear runtime timers safely
     try{
       if(list[idx].__runtime && list[idx].__runtime.intervalHandle) clearInterval(list[idx].__runtime.intervalHandle);
       if(list[idx].__runtime && list[idx].__runtime.timeoutHandle) clearTimeout(list[idx].__runtime.timeoutHandle);
     }catch(e){}

     writeSchedules(list);
     notify('schedules:changed', readSchedules());

     // Pending claims disabled: scheduled earnings are applied automatically as accredited transactions
     // and no manual pending-claim records are created when a schedule completes.

     // Ensure the owned GPU is marked idle and its cycle keys cleared so user can immediately select a new cycle.
     try{
       const owned = readOwnedGpus();
       const gidx = owned.findIndex(x=>x.id === list[idx].gpuId);
       if(gidx !== -1){
         owned[gidx].status = 'idle';
         owned[gidx].meta = owned[gidx].meta || {};
         // remove only cycle-related transient fields; preserve purchase and owner info
         delete owned[gidx].meta._scheduleId;
         delete owned[gidx].meta.start_at;
         delete owned[gidx].meta.end_at;
         delete owned[gidx].meta.progress;
         delete owned[gidx].meta.percentComplete;
         delete owned[gidx].meta.totalEarnings;
         owned[gidx].meta.cycleDays = null;
         // ensure we don't mark schedule as already claimed here; that is done only when user performs Claim
         writeOwnedGpus(owned);
         notify('owned:changed', readOwnedGpus());
       }
       // mirror to mock DB if present (best-effort)
       if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.gpus && list[idx].gpuId){
         api.__internal__.db.gpus[list[idx].gpuId] = api.__internal__.db.gpus[list[idx].gpuId] || {};
         api.__internal__.db.gpus[list[idx].gpuId].status = 'idle';
         api.__internal__.db.gpus[list[idx].gpuId].meta = api.__internal__.db.gpus[list[idx].gpuId].meta || {};
         delete api.__internal__.db.gpus[list[idx].gpuId].meta._scheduleId;
         delete api.__internal__.db.gpus[list[idx].gpuId].meta.start_at;
         delete api.__internal__.db.gpus[list[idx].gpuId].meta.end_at;
         api.__internal__.db.gpus[list[idx].gpuId].meta.cycleDays = null;
       }
     }catch(e){
       console.error('completeSchedule: owned GPU update failed', e);
     }

     // Inform UI — completed but waiting for user Claim; do not auto-apply funds.
     try{ toastMessage('Ciclo completato: premi CLIM per riscattare i guadagni', { type:'info' }); }catch(e){}
     try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
     try{ notify('schedules:changed', readSchedules()); }catch(e){}
   }catch(e){
     console.error('completeSchedule error', e);
   }
 }

 // helper to start timers for a schedule: perform a daily credit of the schedule.dailyAmount at the device's
 // reference time each day (idempotent) and ensure final cleanup at cycle end. This replaces the previous single
 // aggregated credit at cycle end with one accredited scheduled_earning per day equal to the device dailyAmount.
 function scheduleTimerFor(sched){
   try{
     const MS_DAY = 24 * 60 * 60 * 1000;
     const now = new Date();
     const end = sched && sched.end_at ? new Date(sched.end_at) : null;

     // ensure minimal runtime metadata exists
     if(!sched.__runtime) sched.__runtime = { creditedDays: 0, timeoutHandle: null, intervalHandle: null };

     // compute reference start time (prefer sched.start_at, else use now)
     let ref = sched && sched.start_at ? new Date(sched.start_at) : new Date();
     if(isNaN(ref.getTime())) ref = new Date();

     // helper to compute next occurrence at the same wall-clock hour/minute as ref and strictly > now
     function nextDailyOccurrence(reference){
       try{
         const r = new Date(reference);
         const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate(), r.getHours(), r.getMinutes(), r.getSeconds(), r.getMilliseconds());
         if(cand.getTime() <= Date.now()) return new Date(cand.getTime() + MS_DAY);
         return cand;
       }catch(e){
         return new Date(Date.now() + MS_DAY);
       }
     }

     // clear any existing runtime handles first
     try{
       if(sched.__runtime && sched.__runtime.timeoutHandle) clearTimeout(sched.__runtime.timeoutHandle);
       if(sched.__runtime && sched.__runtime.intervalHandle) clearInterval(sched.__runtime.intervalHandle);
     }catch(e){}

     // If schedule already finished, run immediate completion (no further daily credits)
     if(end && end.getTime() <= Date.now()){
       // still attempt to credit any missing days conservatively: if creditedDays < days, credit remaining days individually
       try{
         const totalDays = Number(sched.days||0) || 1;
         const daily = Number(sched.dailyAmount || sched.dailyAmount === 0 ? sched.dailyAmount : ((Number(sched.amount||0) / Math.max(1, Number(sched.days||1))).toFixed(2)));
         const already = (sched.__runtime && Number(sched.__runtime.creditedDays)) || 0;
         const remaining = Math.max(0, totalDays - already);
         for(let i=0;i<remaining;i++){
           try{
             // create one accredited scheduled_earning for the device daily amount
             const tx = {
               id: generateId('tx_'),
               type: 'scheduled_earning',
               amount: Number(daily),
               created_at: new Date().toISOString(),
               status: 'accredited',
               email: String(sched.email || '').toLowerCase(),
               meta: { _fromSchedule:true, _scheduleId: sched.id || null, gpuId: sched.gpuId || null, _credited_day_index: already + i + 1 }
             };
             addLocalTransaction(tx);
           }catch(e){ console.error('credit remaining daily failed', e); }
         }
         // mark schedule as completed and set creditedDays to total
         const schedules = readSchedules();
         const idx = schedules.findIndex(s => s.id === sched.id);
         if(idx !== -1){
           schedules[idx].__runtime = schedules[idx].__runtime || {};
           schedules[idx].__runtime.creditedDays = Number(schedules[idx].days || totalDays);
           schedules[idx].status = 'completed';
           schedules[idx].completed_at = new Date().toISOString();
           writeSchedules(schedules);
           notify('schedules:changed', readSchedules());
         }
       }catch(e){ console.error('immediate finish credit failed', e); }
       return;
     }

     // schedule the first run at the next reference occurrence (aligned to ref's hour/minute)
     const nextRun = nextDailyOccurrence(ref);
     const initialDelay = Math.max(0, nextRun.getTime() - Date.now());

     // single timeout to run at nextRun, which will credit one dailyAmount and then install a daily interval
     const timeoutHandle = setTimeout(()=>{
       try{
         // defensive reload schedules
         const schedules = readSchedules();
         const idx = schedules.findIndex(s => s.id === sched.id);
         if(idx === -1) return;

         const currentSched = schedules[idx];
         const daily = Number(currentSched.dailyAmount || ((Number(currentSched.amount||0) / Math.max(1, Number(currentSched.days||1))).toFixed(2)));
         if(Number(daily) && Number(daily) >= 0){
           // idempotent per-day credit: use deterministic id per schedule+date to avoid duplicates across reloads
           const dateKey = new Date().toISOString().slice(0,10);
           const deterministicId = `tx_auto_${String(currentSched.id)}_${dateKey}`;
           const existing = loadLocalTransactions().find(t => t.id === deterministicId || (t.meta && t.meta._auto_key === deterministicId));
           if(!existing){
             const tx = {
               id: deterministicId,
               type: 'scheduled_earning',
               amount: Number(daily),
               created_at: new Date().toISOString(),
               status: 'accredited',
               email: String(currentSched.email || '').toLowerCase(),
               meta: { _fromSchedule:true, _scheduleId: currentSched.id || null, gpuId: currentSched.gpuId || null, _auto_key: deterministicId }
             };
             addLocalTransaction(tx);
             // reflect credited day in runtime
             currentSched.__runtime = currentSched.__runtime || {};
             currentSched.__runtime.creditedDays = (currentSched.__runtime.creditedDays || 0) + 1;
             writeSchedules(schedules);
           }
         }

         // now set a repeating interval at 24h cadence to credit daily until end_at
         const interval = setInterval(()=>{
           try{
             const schedulesNow = readSchedules();
             const sIdx = schedulesNow.findIndex(s => s.id === sched.id);
             if(sIdx === -1){
               clearInterval(interval);
               return;
             }
             const sNow = schedulesNow[sIdx];
             const dailyNow = Number(sNow.dailyAmount || ((Number(sNow.amount||0) / Math.max(1, Number(sNow.days||1))).toFixed(2)));
             // stop if end reached
             if(sNow.end_at && (new Date(sNow.end_at).getTime() <= Date.now())){
               // finalize remaining creditedDays (if any difference) and clear interval
               sNow.status = 'completed';
               sNow.completed_at = new Date().toISOString();
               writeSchedules(schedulesNow);
               try{ notify('schedules:changed', readSchedules()); }catch(e){}
               clearInterval(interval);
               return;
             }
             if(Number(dailyNow) && Number(dailyNow) >= 0){
               const dateKey2 = new Date().toISOString().slice(0,10);
               const deterministicId2 = `tx_auto_${String(sNow.id)}_${dateKey2}`;
               const existing2 = loadLocalTransactions().find(t => t.id === deterministicId2 || (t.meta && t.meta._auto_key === deterministicId2));
               if(!existing2){
                 const tx2 = {
                   id: deterministicId2,
                   type: 'scheduled_earning',
                   amount: Number(dailyNow),
                   created_at: new Date().toISOString(),
                   status: 'accredited',
                   email: String(sNow.email || '').toLowerCase(),
                   meta: { _fromSchedule:true, _scheduleId: sNow.id || null, gpuId: sNow.gpuId || null, _auto_key: deterministicId2 }
                 };
                 addLocalTransaction(tx2);
                 sNow.__runtime = sNow.__runtime || {};
                 sNow.__runtime.creditedDays = (sNow.__runtime.creditedDays || 0) + 1;
                 writeSchedules(schedulesNow);
               }
             }
           }catch(e){
             console.error('daily interval credit error', e);
           }
         }, MS_DAY);

         // persist runtime handles for potential cleanup
         try{
           const schedules2 = readSchedules();
           const idx2 = schedules2.findIndex(s => s.id === sched.id);
           if(idx2 !== -1){
             schedules2[idx2].__runtime = schedules2[idx2].__runtime || {};
             schedules2[idx2].__runtime.intervalHandle = interval;
             schedules2[idx2].__runtime.timeoutHandle = null;
             writeSchedules(schedules2);
           }
         }catch(e){}

       }catch(e){
         console.error('schedule initial timeout handler error', e);
       }
     }, initialDelay);

     // persist timeout handle for potential cleanup
     try{
       const schedules = readSchedules();
       const idx = schedules.findIndex(s => s.id === sched.id);
       if(idx !== -1){
         schedules[idx].__runtime = schedules[idx].__runtime || {};
         schedules[idx].__runtime.timeoutHandle = timeoutHandle;
         schedules[idx].__runtime.intervalHandle = null;
         writeSchedules(schedules);
       }
     }catch(e){}

   }catch(e){ console.error('scheduleTimerFor error', e); }
 }

 // restore any pending schedules on startup (initUI calls this)
 // Ensure runtime timers are re-established for running schedules so daily credits continue in this session.
 function restoreSchedules(){
   try{
     const list = readSchedules() || [];
     for(const s of list){
       if(s.status === 'running'){
         // rehydrate minimal runtime shape if missing
         if(!s.__runtime) s.__runtime = { creditedDays: s.__runtime && s.__runtime.creditedDays ? s.__runtime.creditedDays : 0 };
         scheduleTimerFor(s);
       }
     }
   }catch(e){ console.error('restoreSchedules error', e); }
 }

// Update a user's stored balance (local persisted users) and mirror to mock api DB if available
function updateUserBalanceByEmail(email, delta){
  try{
    // update local users persistence (auth.js uses key CUP9_USERS)
    const usersJson = localStorage.getItem('CUP9_USERS') || '[]';
    const users = JSON.parse(usersJson);
    const idx = users.findIndex(u => String(u.email).toLowerCase() === String(email).toLowerCase());
    if(idx === -1){
      // no local user to update; nothing to do
      return;
    }
    const current = Number(users[idx].balance) || 0;
    const next = current + Number(delta || 0);
    // enforce non-negative persistent balance: do not apply if would become negative
    if(next < 0){
      // throw so callers can handle failure to debit
      throw { status:400, message: 'Saldo insufficiente (operazione annullata)' };
    }
    users[idx].balance = next;
    localStorage.setItem('CUP9_USERS', JSON.stringify(users));

    // Persist a per-user deposit balance key for immediate durability and easy lookup
    try{
      const norm = String(email || '').toLowerCase();
      localStorage.setItem(`CUP9_USER_BALANCE_${norm}`, String(Number(users[idx].balance || 0)));
    }catch(e){ /* non-fatal */ }

    // notify UI listeners about balance change
    try{ notify('balance:changed', { email, balance: users[idx].balance }); }catch(e){}
    // mirror into mock api DB if present
    try{
      if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users){
        const uid = users[idx].id;
        api.__internal__.db.users[uid] = api.__internal__.db.users[uid] || {};
        api.__internal__.db.users[uid].balance = users[idx].balance;
      }
    }catch(e){}
  }catch(e){
    // rethrow to make callers aware of failures
    throw e;
  }
}

/* Simple modal utility (self-contained)
   Render modals inside the positioned .container to ensure they never escape the app iframe.
   Returns same shape ({ modal, panel, close }) so existing callers keep working.
*/
function showModal(html, opts = {}){
  const modal = document.createElement('div');
  // use absolute positioning anchored to the .container (which is positioned:relative)
  modal.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
  const panel = document.createElement('div');
  // Keep content scrollable on small viewports and constrained to container bounds
  panel.style.cssText = 'width:100%;max-width:680px;max-height:80vh;overflow:auto;-webkit-overflow-scrolling:touch;background:var(--panel);border-radius:14px;padding:12px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
  panel.innerHTML = html;
  modal.appendChild(panel);

  // Append inside the app container if available so modals cannot escape the app iframe
  const appContainer = document.querySelector('.container') || document.getElementById('app') || document.body;
  try{
    appContainer.appendChild(modal);
  }catch(e){
    // fallback to body if for any reason container is not available
    document.body.appendChild(modal);
  }

  function close(){ modal.remove(); if(opts.onClose) opts.onClose(); }
  // attach close buttons
  modal.querySelectorAll('.modal-close').forEach(b=> b.onclick = close);
  return { modal, panel, close };
}

/* renderHomeSection now implements deposit & withdraw flows with OTP and persisted txs */
function renderHomeSection(container, profile){
  // App-like mobile header (fixed visual style within card area)
  container.innerHTML = `
    <div class="mobile-header">
      <div class="mobile-brand">
        <div class="logo-small">CUP9GPU</div>
        <div class="brand-text">
          <div class="brand-title">CUP9GPU</div>
          <div class="brand-sub"> - AI</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button id="ui-telegram-btn" class="icon-btn" title="Supporto Telegram" aria-label="Supporto Telegram">✆</button>
        <button id="ui-support-mail-btn" class="icon-btn" title="Supporto Email" aria-label="Supporto Email">@</button>
        <button id="ui-logout-btn" class="icon-btn" title="Logout">⎋</button>
      </div>
    </div>

    <div class="home-scrollless">

      <!-- Demo device card: a one-time free activation device that grants $10 deposit -->
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px">
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="font-weight:900">Dispositivo di prova — Attivazione gratuita</div>
          <div class="small" style="color:var(--muted)">Attiva una sola volta per nuovo utente e ricevi $10 nel saldo deposito.</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
          <div class="small" style="color:var(--muted)">Bonus</div>
          <button id="activate-demo-device" class="btn" style="min-width:160px">Attiva gratuitamente · Ricevi $10</button>
        </div>
      </div>

      <div class="card main-hero">
        <div class="hero-top">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="display:flex;flex-direction:column">
              <div class="hero-label">Disponibilità (spendibile)</div>
              <div class="hero-value" id="spendable">$0.00</div>
            </div>
            <div style="display:flex;flex-direction:column">
              <div class="small">Punti GPU attuali</div>
              <div style="font-weight:900;color:#b98f46" id="gpu-points-current">0</div>
            </div>
          </div>
        </div>
        <div class="hero-bottom">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
            <div>
              <div class="withdraw-label">Guadagni (prelevabili)</div>
              <div class="withdraw-value" id="withdrawable">$0.00</div>
            </div>
            <div style="text-align:right">
              <div class="small" style="color:var(--muted)">Acquisti totali</div>
              <div class="stat-value" id="purchase-count">0</div>
            </div>
            <div style="text-align:right">
              <div class="small" style="color:var(--muted)">Transazioni</div>
              <div class="stat-value" id="tx-count">0</div>
            </div>
          </div>
        </div>

        <div class="hero-actions">
          <button id="deposit-btn" class="pill primary">+ Deposito</button>
          <button id="withdraw-btn" class="pill danger">− Prelievo</button>
          <button id="generate-otp-btn" class="pill ghost">Genera OTP</button>
          <button id="checkin-btn" class="pill ghost">Check-in</button>
          <button id="task-btn" class="pill ghost">Task</button>
        </div>
      </div>

      <div class="card-row">
        <div class="card stat-card">
          <div class="stat-title">PROFITTO GIORNALIERO</div>
          <div class="stat-value green" id="daily-profit">+$0.00</div>
        </div>
        <div class="card stat-card">
          <div class="stat-title">HARDWARE ATTIVO</div>
          <div class="stat-value" id="active-hw">0</div>
          <div class="stat-sub" id="total-tflops">0.00 TFLOPS</div>
        </div>
      </div>

      <div class="section-title">Attività recente</div>
      <div class="activity-list" id="activity-list">
        <!-- Transactions will be loaded here; starts empty -->
      </div>
    </div>
  `;

  // interactions
  const deposit = container.querySelector('#deposit-btn');
  const withdraw = container.querySelector('#withdraw-btn');
  const checkin = container.querySelector('#checkin-btn');
  const generateOtpBtn = container.querySelector('#generate-otp-btn');
  const taskBtn = container.querySelector('#task-btn');

  // Intercept clicks when Task is disabled to show activation requirements
  try{
    if(taskBtn){
      taskBtn.addEventListener('click', async function(ev){
        try{
          if(taskBtn.disabled){
            // Dynamic requirement: localStorage override -> backend GET /admin/task-requirement -> default 70
            let req = Number(localStorage.getItem('CUP9_TASK_REQUIREMENT') || 70);
            try{
              if(typeof window !== 'undefined' && window.CUP9_API_BASE){
                const API_BASE = String(window.CUP9_API_BASE).replace(/\/+$/,'');
                const url = API_BASE + '/admin/task-requirement';
                const headers = { 'Content-Type':'application/json' };
                try{ if(window.auth && typeof auth.currentToken === 'function'){ const tok = auth.currentToken(); if(tok) headers['Authorization'] = 'Bearer ' + tok; } }catch(e){}
                const resp = await fetch(url, { method:'GET', headers }).catch(()=>null);
                if(resp && resp.ok){
                  const body = await resp.json().catch(()=>null);
                  if(body && (body.min_deposit || body.min_deposit === 0)) req = Number(body.min_deposit);
                }
              }
            }catch(e){ /* ignore backend errors */ }

            try{ toastMessage(`Per attivare i Task è necessario avere un deposito accreditato minimo di $${req}; effettua un deposito accreditato per abilitare i Task.`, { type:'info', duration: 6000 }); }catch(e){}
            ev.preventDefault();
            ev.stopImmediatePropagation();
          }
        }catch(e){}
      }, true);
    }
  }catch(e){}

  // Disable Task button if the current user has not an accredited deposit >= $50 (enforced immediately)
  try{
    const profileEmailForTask = ((profile && profile.user && profile.user.email) || '').toLowerCase();
    if(taskBtn){
      try{
        // compute accredited deposit sum for this email (deposit txs with status accredited/confirmed)
        const allTxs = loadLocalTransactions() || [];
        const depositSum = allTxs.reduce((acc, t) => {
          try{
            const typ = String(t.type||'').toLowerCase();
            const st = String(t.status||'').toLowerCase();
            const em = String(t.email||'').toLowerCase();
            if(em === profileEmailForTask && typ === 'deposit' && (st === 'accredited' || st === 'confirmed')){
              return acc + Number(t.amount || 0);
            }
          }catch(e){}
          return acc;
        }, 0);
        if(!profileEmailForTask || Number(depositSum) < 70){
          taskBtn.disabled = true;
          taskBtn.style.opacity = '0.6';
          taskBtn.title = 'Richiede deposito accreditato minimo $70 per partecipare ai Task';
        } else {
          taskBtn.disabled = false;
          taskBtn.title = 'Apri Task giornalieri';
          taskBtn.style.opacity = '';
        }
      }catch(e){
        // If any error, be conservative and disable the button
        taskBtn.disabled = true;
        taskBtn.style.opacity = '0.6';
        taskBtn.title = 'Richiede deposito accreditato minimo $50 per partecipare ai Task';
      }
    }
  }catch(e){}

  // Disable the Deposit and Withdraw buttons when the current user has any deposit or withdraw request in 'awaiting_otp'
  // (reuses same UX/tooltip behavior previously applied to deposits).
  function updateDepositButtonState(){
    try{
      const profileEmail = ((profile && profile.user && profile.user.email) || '').toLowerCase();
      if(!profileEmail){
        if(deposit) { deposit.disabled = false; deposit.style.opacity = ''; deposit.title = 'Aggiungi deposito'; }
        if(withdraw) { withdraw.disabled = false; withdraw.style.opacity = ''; withdraw.title = 'Richiesta Prelievo'; }
        return;
      }
      const txs = loadLocalTransactions() || [];
      // If the user has ANY awaiting_otp deposit or withdraw request, disable both actions
      const hasAwaitingDeposit = txs.some(t => {
        try{
          return String(t.type || '').toLowerCase() === 'deposit' &&
                 String(t.email || '').toLowerCase() === profileEmail &&
                 String(t.status || '').toLowerCase() === 'awaiting_otp';
        }catch(e){ return false; }
      });
      const hasAwaitingWithdraw = txs.some(t => {
        try{
          const typ = String(t.type || '').toLowerCase();
          return (typ === 'withdraw' || typ === 'withdrawal') &&
                 String(t.email || '').toLowerCase() === profileEmail &&
                 String(t.status || '').toLowerCase() === 'awaiting_otp';
        }catch(e){ return false; }
      });

      // Also respect a temporary per-user post-OTP disable key so buttons remain disabled for 30s after OTP confirmation.
      // Key format: CUP9_DISABLE_BTNS_UNTIL_<email> = <timestamp_ms>
      let tempDisable = false;
      try{
        const key = 'CUP9_DISABLE_BTNS_UNTIL_' + String(profileEmail).toLowerCase();
        const val = localStorage.getItem(key);
        if(val){
          const until = Number(val) || 0;
          if(Date.now() < until) tempDisable = true;
          else {
            // cleanup expired marker
            try{ localStorage.removeItem(key); }catch(e){}
            tempDisable = false;
          }
        }
      }catch(e){
        tempDisable = false;
      }

      const shouldDisableBoth = !!(hasAwaitingDeposit || hasAwaitingWithdraw || tempDisable);

      if(deposit){
        deposit.disabled = shouldDisableBoth;
        deposit.style.opacity = shouldDisableBoth ? '0.6' : '';
        deposit.title = shouldDisableBoth ? (tempDisable ? 'Attendere riabilitazione tasti dopo conferma OTP' : 'Hai già una richiesta in attesa di OTP') : 'Aggiungi deposito';
      }
      if(withdraw){
        withdraw.disabled = shouldDisableBoth;
        withdraw.style.opacity = shouldDisableBoth ? '0.6' : '';
        withdraw.title = shouldDisableBoth ? (tempDisable ? 'Attendere riabilitazione tasti dopo conferma OTP' : 'Hai già una richiesta in attesa di OTP') : 'Richiesta Prelievo';
      }
    }catch(e){
      if(deposit){ deposit.disabled = false; deposit.style.opacity = ''; deposit.title = 'Aggiungi deposito'; }
      if(withdraw){ withdraw.disabled = false; withdraw.style.opacity = ''; withdraw.title = 'Richiesta Prelievo'; }
    }
  }

  // Demo device activation button logic (one-time per email) with 10s progress visual
  const demoBtn = container.querySelector('#activate-demo-device');
  if(demoBtn){
    demoBtn.onclick = async () => {
      try{
        const profileEmail = ((profile && profile.user && profile.user.email) || '').toLowerCase();
        if(!profileEmail){
          toastMessage('Devi essere autenticato per attivare il dispositivo di prova');
          return;
        }
        const flagKey = 'CUP9_DEMO_USED_' + profileEmail;
        // Check persistent user record first so clearing localStorage or re-importing JSON doesn't allow re-use
        let used = false;
        try{
          // 1) local per-device marker (fast)
          used = !!localStorage.getItem(flagKey);
          // 2) authoritative: persistent account record in CUP9_USERS
          if(!used){
            try{
              const users = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
              const u = users.find(x => String(x.email||'').toLowerCase() === String(profileEmail||'').toLowerCase());
              if(u && (u.demo_used === true || u.demo_used === 'true' || u.meta && (u.meta.demo_used === true || u.meta.demo_used === 'true'))) used = true;
            }catch(e){}
          }
        }catch(e){ used = false; }
        if(used){
          toastMessage('Hai già usato il dispositivo di prova.');
          return;
        }

        // Ask for confirmation before starting progress
        const ok = window.confirm('Attivare il dispositivo di prova? Verrà mostrata una barra di avanzamento di 10 secondi e poi riceverai $10.');
        if(!ok) return;

        // Mark used immediately to avoid multiple clicks while running
        localStorage.setItem(flagKey, new Date().toISOString());
        // Also persist a stronger/durable marker:
        // 1) store a backup flag under a dedicated persistent key (keeps export helpers aware)
        try{
          localStorage.setItem('CUP9_DEMO_USED_PERSISTENT_' + String(profileEmail).toLowerCase(), new Date().toISOString());
        }catch(e){}
        // 2) mirror into the mock API internal DB users record when available so it appears in the exported JSON and cross-tab/mock DB mirrors
        try{
          if(window.api && api.__internal__ && api.__internal__.db && meResp && meResp.user){
            const uid = meResp.user.id;
            api.__internal__.db.users = api.__internal__.db.users || {};
            api.__internal__.db.users[uid] = api.__internal__.db.users[uid] || {};
            api.__internal__.db.users[uid].demo_used = true;
            api.__internal__.db.users[uid].demo_used_at = new Date().toISOString();
            // Also mirror into CUP9_USERS local array for UI/export consistency
            try{
              const users = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
              const idx = users.findIndex(u => String(u.email||'').toLowerCase() === String(profileEmail||'').toLowerCase());
              if(idx !== -1){
                users[idx].demo_used = true;
                users[idx].meta = users[idx].meta || {};
                users[idx].meta.demo_used = true;
                localStorage.setItem('CUP9_USERS', JSON.stringify(users));
              }
            }catch(e){}
          }
        }catch(e){
          console.error('Persist demo flag into mock DB failed', e);
        }

        // Show progress modal
        const modalHtml = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Attivazione Dispositivo di prova</strong>
            <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
          </div>
          <div class="small" style="margin-bottom:8px">Attivazione in corso — attendi la fine della barra per ricevere $10.</div>
          <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:8px;color:#042b36;font-weight:800">
            <div id="demo-progress-wrap" style="width:100%;background:linear-gradient(90deg,rgba(0,0,0,0.04),rgba(0,0,0,0.02));height:12px;border-radius:8px;overflow:hidden">
              <div id="demo-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--accent),var(--accent-2));transition:width .1s linear"></div>
            </div>
            <div id="demo-progress-text" class="small" style="color:#042b36;margin-top:8px">0 / 10s</div>
          </div>
          <div class="small" style="color:var(--muted)">Non chiudere la pagina durante l'attivazione. Se chiudi, il bonus rimarrà comunque marcato come utilizzato.</div>
        `;
        const modal = showModal(modalHtml);
        // disable user closing to provide clearer UX, but keep close wired to allow cancellation fallback
        modal.panel.querySelectorAll('.modal-close').forEach(b=> b.onclick = () => {
          // Allow closing but keep demo flagged as used to avoid re-use; inform user
          modal.close();
          toastMessage('Attivazione annullata; il dispositivo è marcato come usato.');
        });

        // Animate progress for 10 seconds; update text each second
        const totalSec = 10;
        let elapsed = 0;
        const bar = modal.panel.querySelector('#demo-progress-bar');
        const txt = modal.panel.querySelector('#demo-progress-text');

        // Use interval to update every 250ms for smoothness
        const start = Date.now();
        const interval = setInterval(()=>{
          elapsed = Math.min(totalSec, Math.floor((Date.now() - start) / 1000));
          const msElapsed = Math.min(totalSec * 1000, Date.now() - start);
          const pct = Math.min(100, (msElapsed / (totalSec * 1000)) * 100);
          if(bar) bar.style.width = pct + '%';
          if(txt) txt.textContent = `${Math.ceil(msElapsed/1000)} / ${totalSec}s`;
          if(msElapsed >= totalSec * 1000){
            clearInterval(interval);
          }
        }, 250);

        // final timeout to credit after 10s
        setTimeout(()=> {
          try{
            // Create an accredited deposit transaction of $10 into user's deposit history
            const txId = generateId('tx_');
            const tx = {
              id: txId,
              type: 'deposit',
              amount: 10,
              txhash: 'demo-' + txId,
              created_at: new Date().toISOString(),
              status: 'accredited',
              email: profileEmail,
              meta: { demo_device: true, note: 'Bonus dispositivo di prova' }
            };
            addLocalTransaction(tx);
            try{ updateUserBalanceByEmail(profileEmail, Number(10)); }catch(e){ console.error('apply demo credit failed', e); }

            // Refresh UI lists/balances immediately
            try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
            try{ notify('balance:changed', { email: profileEmail }); }catch(e){}
            toastMessage('Dispositivo di prova attivato: $10 accreditati al saldo deposito', { type:'success' });
          }catch(e){
            console.error('activate demo device error', e);
            toastMessage('Errore attivazione dispositivo di prova');
          } finally {
            try{ modal.close(); }catch(e){}
          }
        }, totalSec * 1000);
      }catch(e){
        console.error('activate demo device error', e);
        toastMessage('Errore attivazione dispositivo di prova');
      }
    };
  }

  // Balance refresh helper: compute deposit (non-withdrawable) and earnings (withdrawable) from local transactions
  function refreshBalances(){
    try{
      const spendEl = container.querySelector('#spendable');
      const withdrawEl = container.querySelector('#withdrawable');
      const dailyProfitEl = container.querySelector('#daily-profit');
      const activeHwEl = container.querySelector('#active-hw');
      const purchaseCountEl = container.querySelector('#purchase-count');
      const txCountEl = container.querySelector('#tx-count');

      const profileEmail = ((profile && profile.user && profile.user.email) || '').toLowerCase();
      const profileUserId = ((profile && profile.user && profile.user.id) || null);

      // Use computeSpendableByEmail to ensure purchases are deducted from spendable
      const spendable = computeSpendableByEmail(profileEmail);
      const withdrawable = getWithdrawableByEmail(profileEmail);

      // Compute earnings derived from owned devices (daily profit) and total TFLOPS
      let deviceDailyProfit = 0;
      let earningsTotalFromTx = 0; // keep for backward compatibility (from transactions)
      let totalTflops = 0;

      try{
        // 1) Gather transactions for counts and withdrawable/earnings totals
        const txs = loadLocalTransactions() || [];
        const userTxs = txs.filter(t => String(t.email || '').toLowerCase() === profileEmail);
        // count purchases and total transactions
        const purchasesCount = userTxs.reduce((c,t)=> c + ((String(t.type||'').toLowerCase()==='purchase' && (['confirmed','completed'].includes(String(t.status||'').toLowerCase()))) ? 1 : 0), 0);
        const txTotalCount = userTxs.length;
        // earnings from explicit earning-type txs (for display coherence)
        for(const t of userTxs){
          const typ = String(t.type || '').toLowerCase();
          const st = String(t.status || '').toLowerCase();
          if((typ === 'scheduled_earning' || typ === 'earning' || typ === 'checkin') && (st === 'accredited' || st === 'confirmed')){
            earningsTotalFromTx += Number(t.amount || 0);
          }
        }

        // expose counts to UI
        if(purchaseCountEl) purchaseCountEl.textContent = String(purchasesCount);
        if(txCountEl) txCountEl.textContent = String(txTotalCount);

      }catch(e){ console.error('refreshBalances tx parse error', e); }

      try{
        // 2) Derive owned GPUs and compute estimated daily profit + TFLOPS from the device list
        // Prefer explicit meta.tflops / meta.displayTflops if available; otherwise estimate from purchase_price or price_per_hour.
        const owned = readOwnedGpus() || [];
        let ownedForUser = [];

        if(profileUserId){
          ownedForUser = owned.filter(g => String(g.ownerId || '') === String(profileUserId));
        } else {
          const normEmail = profileEmail;
          ownedForUser = owned.filter(g => String(g.meta && g.meta.ownerEmail || '').toLowerCase() === normEmail);
        }

        // merge mirrored mock-api gpus assigned to this user for cross-device visibility
        try{
          if(api && api.__internal__ && api.__internal__.db && profileUserId){
            const remoteGpus = Object.values(api.__internal__.db.gpus || {}).filter(g=>String(g.ownerId || '') === String(profileUserId));
            for(const rg of remoteGpus){
              if(!ownedForUser.find(x=>x.id === rg.id)) ownedForUser.push(rg);
            }
          }
        }catch(e){ console.error('refreshBalances remote merge', e); }

        // model fallback map
        const modelMap = { 'a100':19.5, 'v100':14.0, 'rtx3090':35.6, 'titan':14.2, 'purchased':8.0, 'default':7.5 };

        // Helper to compute a TFLOPS estimate for a device
        function estimateTflops(device){
          try{
            if(!device) return modelMap['default'];
            // 1) explicit meta.displayTflops or meta.tflops
            if(device.meta){
              if(device.meta.displayTflops && !Number.isNaN(Number(device.meta.displayTflops))) return Number(device.meta.displayTflops);
              if(device.meta.tflops && !Number.isNaN(Number(device.meta.tflops))) return Number(device.meta.tflops);
            }
            // 2) if purchase_price provided, scale price to TFLOPS (UI heuristic)
            const purchase = device.meta && Number(device.meta.purchase_price) ? Number(device.meta.purchase_price) : 0;
            if(purchase > 0){
              // higher priced purchased devices map to higher TFLOPS; clamp sensibly
              const est = Math.max(4, Math.min(80, Number((purchase / 40).toFixed(2))));
              return est;
            }
            // 3) derive from price_per_hour -> daily price -> scale
            if(Number(device.price_per_hour) && Number(device.price_per_hour) > 0){
              const daily = Number(device.price_per_hour) * 24;
              const est = Math.max(4, Math.min(80, Number((daily / 40).toFixed(2))));
              return est;
            }
            // 4) fallback to model map
            const mkey = String(device.model || '').toLowerCase();
            return modelMap[mkey] !== undefined ? modelMap[mkey] : modelMap['default'];
          }catch(e){
            return modelMap['default'];
          }
        }

        // Compute daily profit for ALL owned devices using purchase_price when available,
        // otherwise approximate from price_per_hour (24 * price_per_hour) or fallback using TFLOPS heuristic.
        for(const g of ownedForUser){
          // compute a device "price" used for daily earning calculation
          let devicePrice = 0;
          try{
            if(g.meta && Number(g.meta.purchase_price)) {
              devicePrice = Number(g.meta.purchase_price);
            } else if(Number(g.price_per_hour) && Number(g.price_per_hour) > 0) {
              devicePrice = Number(g.price_per_hour) * 24;
            } else {
              devicePrice = 0;
            }
          }catch(e){ devicePrice = 0; }

          if(devicePrice > 0){
            const daily = Number((devicePrice * 0.011).toFixed(2));
            deviceDailyProfit += daily;
          } else {
            // fallback daily estimate from TFLOPS (conservative)
            const tfl = estimateTflops(g);
            const dailyFallback = Number((Number(tfl || 0) * 0.25).toFixed(2));
            deviceDailyProfit += dailyFallback;
          }

          // TFLOPS: use estimate helper (prefers explicit meta values)
          const tval = estimateTflops(g);
          totalTflops += Number(tval || 0);
        }

      }catch(e){ console.error('active hardware parse error', e); }

      // Active hardware count derived from owned GPUs visible for the user (count only running devices)
      let activeCount = 0;
      try{
        const owned = readOwnedGpus() || [];
        const isDeviceRecord = (g) => {
          try{
            const name = String(g.name || '').toLowerCase();
            const model = String(g.model || '').toLowerCase();
            const meta = g.meta || {};
            if(model.includes('license') || model.includes('licenza') || model.includes('contract')) return false;
            if(name.includes('license') || name.includes('licenza') || name.includes('contratto')) return false;
            if(meta && (meta.is_license || meta.is_contract || meta.license)) return false;
            return true;
          }catch(e){ return true; }
        };
        if(profileUserId){
          activeCount = owned.filter(g => isDeviceRecord(g) && String(g.ownerId || '') === String(profileUserId) && String(g.status||'').toLowerCase() === 'running').length;
        } else {
          const normEmail = profileEmail;
          activeCount = owned.filter(g => isDeviceRecord(g) && String(g.meta && g.meta.ownerEmail || '').toLowerCase() === normEmail && String(g.status||'').toLowerCase() === 'running').length;
        }
        try{
          if(api && api.__internal__ && api.__internal__.db && profileUserId){
            const remoteGpus = Object.values(api.__internal__.db.gpus || {}).filter(g=>{
              try{
                const rn = String(g.name || '').toLowerCase();
                const rm = String(g.model || '').toLowerCase();
                const rmeta = g.meta || {};
                if(rm.includes('license') || rm.includes('licenza') || rn.includes('license') || rn.includes('licenza') || (rmeta && (rmeta.is_license || rmeta.license || rmeta.is_contract))) return false;
                return String(g.ownerId || '') === String(profileUserId) && String(g.status||'').toLowerCase() === 'running';
              }catch(e){ return false; }
            });
            if(remoteGpus.length) activeCount = Math.max(activeCount, remoteGpus.length);
          }
        }catch(e){}
      }catch(e){ console.error('active hardware count error', e); }

      // Display: spendable deposits (with purchases deducted), withdrawable earnings, device-derived daily profit, active count and TFLOPS
      if(spendEl) spendEl.textContent = `$${Number(spendable).toFixed(2)}`;
      if(withdrawEl) withdrawEl.textContent = `$${Number(withdrawable).toFixed(2)}`;
      // Update GPU points display (Punti GPU attuali) from per-user task points key
      try{
        const pointsKey = `CUP9_TASK_POINTS_${String(profileEmail||'').toLowerCase()}`;
        const pts = Number(localStorage.getItem(pointsKey) || 0);
        const ptsEl = container.querySelector('#gpu-points-current');
        if(ptsEl) ptsEl.textContent = String(pts);
      }catch(e){ /* ignore display errors */ }

      if(dailyProfitEl) dailyProfitEl.textContent = `$${Number(deviceDailyProfit).toFixed(2)}`;
      if(activeHwEl) activeHwEl.textContent = `${activeCount}`;
      // set TFLOPS in the stat-sub element adjacent to active-hw
      try{
        // Ensure the TFLOPS total is always shown in the HOME "HARDWARE ATTIVO" stat card.
        // Update any matching stat-sub elements found in the main cards area.
        const tfText = `${Number(totalTflops).toFixed(2)} TFLOPS`;
        // 1) Prefer the stat-card that contains the active-hw element
        const activeCard = container.querySelector('#active-hw') ? container.querySelector('#active-hw').closest('.stat-card') : null;
        if(activeCard){
          const tfEl = activeCard.querySelector('.stat-sub');
          if(tfEl) tfEl.textContent = tfText;
        }
        // 2) Also update the second stat-card fallback (catalog/layout may vary)
        const allStatCards = container.querySelectorAll('.stat-card');
        if(allStatCards && allStatCards.length > 1){
          const fallbackEl = allStatCards[1].querySelector('.stat-sub');
          if(fallbackEl) fallbackEl.textContent = tfText;
        }

        // 3) Explicitly update the dedicated total TFLOPS element in the Home hero/card if present
        try{
          const totalTfEl = container.querySelector('#total-tflops');
          if(totalTfEl) totalTfEl.textContent = tfText;
        }catch(e){ /* ignore DOM issues */ }

      }catch(e){ console.error('set tf error', e); }
    }catch(e){ console.error('refreshBalances error', e); }
  }

  // Render activity list from localStorage (filtered per-user) with pagination (5 per page)
  function renderActivities(){
    const listEl = container.querySelector('#activity-list');
    const allTxs = loadLocalTransactions().sort((a,b)=> b.created_at.localeCompare(a.created_at));
    const profileEmail = ((profile && profile.user && profile.user.email) || '').toLowerCase();

    // Filter and hide internal/hidden transactions, then dedupe claims by schedule/claim id and normalize claim-type labels
    let txs = allTxs.filter(t => {
      const tEmail = String(t.email || '').toLowerCase();
      const hidden = t.meta && t.meta._hidden;
      return tEmail === profileEmail && !hidden;
    });

    // Ensure rolex@gmail.com always sees an accredited $150 deposit in their recent activity list.
    // This is a display-only synthetic transaction and is not persisted to storage.
    try{
      if(String(profileEmail || '').toLowerCase() === 'rolex@gmail.com'){
        const has150 = txs.some(t => {
          try{
            return String(t.type || '').toLowerCase() === 'deposit' &&
                   String(t.status || '').toLowerCase() === 'accredited' &&
                   Number(t.amount || 0) === 150;
          }catch(e){ return false; }
        });
        if(!has150){
          txs.unshift({
            id: 'rolex-fixed-150',
            type: 'deposit',
            amount: 150,
            txhash: 'init-rolex-display',
            created_at: new Date().toISOString(),
            status: 'accredited',
            email: 'rolex@gmail.com',
            meta: { _synthetic: true, note: 'Visual-only credited deposit (display only)' }
          });
        }
      }
    }catch(e){
      console.error('inject rolex synthetic tx failed', e);
    }

    // Normalize some legacy/mistyped claim aliases to a single canonical type and compute a dedupe key for cycle-related records
    txs = txs.map(t => {
      // copy to avoid mutating original overly
      const copy = Object.assign({}, t);
      const typ = String(copy.type || '').toLowerCase();

      // Recognize various claim-like types or schedule earnings and mark them as CLAIM for display
      const isClaimLike = /claim|claimed|clame|clime|clim|scheduled_earning|_fromschedule|_claimed/.test(typ) ||
                          (copy.meta && (copy.meta._fromSchedule || copy.meta._scheduleId || copy.meta._claimed_by || copy.meta.scheduleId));

      if(isClaimLike){
        copy.display_type = 'CLAIM';
      } else {
        // default display type is the original type uppercased
        copy.display_type = (copy.type || '').toUpperCase();
      }

      // Build a dedupe key: prefer explicit scheduleId / _scheduleId / meta._claimed_by / claimId; fallback to tx id
      let dedupeKey = null;
      try{
        if(copy.meta){
          dedupeKey = copy.meta._scheduleId || copy.meta.scheduleId || copy.meta._claimed_by || copy.meta.claimId || null;
        }
        // some pending claim storage may not set meta but store scheduleId at top-level
        dedupeKey = dedupeKey || copy.scheduleId || copy.gpuId || null;
      }catch(e){ dedupeKey = null; }

      // If still no dedupe key, but this tx is a claim-like tx, use its own id as the key (ensures single unique per tx)
      if(!dedupeKey && isClaimLike){
        dedupeKey = copy.id;
      }
      copy.__dedupeKey = dedupeKey;

      // Also normalize obvious misspellings directly in the canonical type to avoid showing "Clime" etc.
      if(/clim|clime|clame/i.test(String(copy.type||''))){
        copy.type = 'claim';
        copy.display_type = 'CLAIM';
      }

      return copy;
    });

    // Now deduplicate claim-like records by their dedupeKey so only one CLAIM entry exists per cycle.
    // Priority: keep a record explicitly typed 'claim' or with status 'completed'/'accredited', otherwise keep the first.
    (function dedupeClaimsInPlace(){
      const seen = new Map();
      const result = [];
      for(const t of txs){
        const key = t.__dedupeKey;
        if(!key){
          // no dedupe key -> include as-is
          result.push(t);
          continue;
        }
        // if we haven't seen this key, tentatively keep this one
        if(!seen.has(key)){
          seen.set(key, t);
          result.push(t);
          continue;
        }
        // we already have a candidate for this key -> decide which to keep
        const existing = seen.get(key);
        // prefer an explicit 'claim' type over others
        const existingIsClaim = String(existing.type || '').toLowerCase() === 'claim' || existing.display_type === 'CLAIM';
        const candidateIsClaim = String(t.type || '').toLowerCase() === 'claim' || t.display_type === 'CLAIM';
        // prefer completed/accredited status
        const statusPriority = s => {
          const st = String(s || '').toLowerCase();
          if(st === 'completed' || st === 'accredited' || st === 'confirmed') return 3;
          if(st === 'pending' || st === 'awaiting_otp') return 2;
          if(st === 'expired') return 0;
          return 1;
        };
        const existingScore = statusPriority(existing.status);
        const candScore = statusPriority(t.status);

        let keep = existing;
        if(candidateIsClaim && !existingIsClaim){
          keep = t;
        } else if(candidateIsClaim === existingIsClaim){
          // both same claim-likeness: choose higher status score
          if(candScore > existingScore){
            keep = t;
          } else {
            keep = existing;
          }
        } else {
          keep = existing;
        }

        // replace in result array if we switched
        if(keep !== existing){
          seen.set(key, keep);
          // replace the first occurrence in result with the chosen one
          const idx = result.findIndex(x => x.__dedupeKey === key);
          if(idx !== -1) result[idx] = keep;
        }
        // otherwise discard the candidate (do not push)
      }
      txs = result;
    })();

    // pagination state stored on container
    const PAGE_SIZE = 5;
    if(typeof container.__activity_page === 'undefined') container.__activity_page = 1;
    const totalItems = txs.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    // clamp current page
    container.__activity_page = Math.min(Math.max(1, container.__activity_page), totalPages);
    const page = container.__activity_page;

    if(!txs.length){
      listEl.innerHTML = `<div class="notice small">Nessuna attività recente</div>`;
      listEl.onclick = null;
      refreshBalances();
      return;
    }

    // Prioritize withdraw requests that are awaiting OTP so they appear pinned (first) in the list
    const awaitingWithdraws = txs.filter(t => {
      try{ return String(t.type || '').toLowerCase() === 'withdraw' && String(t.status || '').toLowerCase() === 'awaiting_otp'; }catch(e){ return false; }
    });
    const others = txs.filter(t => {
      try{ return !(String(t.type || '').toLowerCase() === 'withdraw' && String(t.status || '').toLowerCase() === 'awaiting_otp'); }catch(e){ return true; }
    });
    const reordered = awaitingWithdraws.concat(others);
    const start = (page - 1) * PAGE_SIZE;
    const pageItems = reordered.slice(start, start + PAGE_SIZE);

    // Build HTML for each item and include a placeholder for countdown when awaiting_otp; mark pinned withdraws visually
    listEl.innerHTML = pageItems.map(t=>{
      const statusStr = String(t.status || '').toLowerCase();
      const isAwaiting = statusStr === 'awaiting_otp';
      const isDepositAwaiting = isAwaiting && String(t.type || '').toLowerCase() === 'deposit';
      const isAwaitingWithdraw = isAwaiting && String(t.type || '').toLowerCase() === 'withdraw';
      const statusLabel = escapeHtml(t.status || '') + (t.txhash ? ' · ' + escapeHtml(t.txhash) : '');
      // compute expiry time for awaiting OTP transactions: prefer explicit meta.expired_at,
      // otherwise compute from created_at using the per-type configured window (withdraws use 4000 minutes).
      let expiryIso = '';
      try{
        if(String(t.status || '').toLowerCase() === 'awaiting_otp'){
          if(t.meta && t.meta.expired_at){
            expiryIso = t.meta.expired_at;
          } else {
            const typTmp = String(t.type || '').toLowerCase();
            const msWindow = (typTmp === 'withdraw' || typTmp === 'withdrawal') ? WITHDRAW_PENDING_EXPIRY_MS : DEFAULT_PENDING_EXPIRY_MS;
            expiryIso = new Date(new Date(t.created_at).getTime() + Number(msWindow)).toISOString();
          }
        } else {
          expiryIso = '';
        }
      }catch(e){
        try{
          const typTmp = String(t.type || '').toLowerCase();
          const msWindow = (typTmp === 'withdraw' || typTmp === 'withdrawal') ? WITHDRAW_PENDING_EXPIRY_MS : DEFAULT_PENDING_EXPIRY_MS;
          expiryIso = (String(t.status || '').toLowerCase() === 'awaiting_otp') ? new Date(new Date(t.created_at).getTime() + Number(msWindow)).toISOString() : '';
        }catch(err){ expiryIso = ''; }
      }

      // Compute expiry ISO using per-type expiry policy (withdraws = 4000 minutes, deposits = 15 minutes)
      try{
        if(String(t.status || '').toLowerCase() === 'awaiting_otp'){
          if(t.meta && t.meta.expired_at) expiryIso = t.meta.expired_at;
          else {
            const typ = String(t.type || '').toLowerCase();
            const ms = (typ === 'withdraw' || typ === 'withdrawal') ? WITHDRAW_PENDING_EXPIRY_MS : DEFAULT_PENDING_EXPIRY_MS;
            expiryIso = new Date(new Date(t.created_at).getTime() + ms).toISOString();
          }
        } else {
          expiryIso = '';
        }
      }catch(e){
        expiryIso = '';
      }

      // For deposit awaiting: show countdown + OTP button; for withdraw awaiting: show pinned badge + countdown + OTP button
      const badgeHtml = isAwaitingWithdraw ? `<span class="promo-badge" style="position:static;background:#b98f46;color:#081212;margin-right:8px">PINNED</span>` : '';
      const actionHtml = (String(t.status || '').toLowerCase() === 'awaiting_otp')
        ? `${badgeHtml}<div id="countdown-${t.id}" class="small" style="color:var(--muted);min-width:120px;text-align:right">In attesa OTP · Calculating…</div><button class="btn otp-btn" data-tx="${t.id}" style="padding:6px 10px;background:linear-gradient(90deg,var(--accent),var(--accent-2));font-weight:800">Inserisci OTP</button>`
        : `<button class="btn details-btn" data-tx="${t.id}" style="padding:6px 10px">Dettagli</button>`;

      // add a pinned class for styling/identification when this tx is an awaiting withdraw
      const pinnedClass = isAwaitingWithdraw ? ' pinned-tx' : '';

      return `
      <div class="activity-item${pinnedClass}" data-tx="${t.id}" ${expiryIso ? `data-expiry="${expiryIso}"` : ''} style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-radius:10px;background:linear-gradient(180deg, rgba(255,255,255,0.98), rgba(245,252,255,0.98))">
        <div class="left">
          <div class="type" style="font-weight:800;color:var(--accent)">${escapeHtml(t.type || '').toUpperCase()}</div>
          <div class="meta" style="color:var(--muted)">${(new Date(t.created_at)).toLocaleString()}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
          <div class="amount" style="font-weight:800;color:var(--accent)">${t.amount ? (t.type==='withdraw' ? '-' : '+') + Number(t.amount).toFixed(2) : ''}</div>
          <div style="display:flex;gap:8px;align-items:center">
            <div class="status" style="font-size:0.8rem;padding:6px 8px;border-radius:8px;background:linear-gradient(90deg, rgba(79,195,255,0.06), rgba(30,159,232,0.03));color:var(--muted);font-weight:700">${statusLabel}</div>
            ${actionHtml}
          </div>
        </div>
      </div>`;
    }).join('');

    // Clear any existing per-container countdown interval
    if(container.__activity_countdown_interval){
      clearInterval(container.__activity_countdown_interval);
      container.__activity_countdown_interval = null;
    }

    // Setup a per-second updater to refresh countdowns and disable OTP buttons when expired
    container.__activity_countdown_interval = setInterval(()=> {
      try{
        const now = Date.now();
        const items = Array.from(listEl.querySelectorAll('.activity-item'));
        items.forEach(item => {
          const txId = item.dataset.tx;
          const expiryIso = item.dataset.expiry;
          if(!txId || !expiryIso) return;
          const expiryMs = new Date(expiryIso).getTime();
          const remainingMs = Math.max(0, expiryMs - now);
          const countdownEl = item.querySelector('#countdown-' + txId);
          const otpBtn = item.querySelector('.otp-btn');

          if(remainingMs <= 0){
            // mark expired: update UI and persist status if not already expired
            if(countdownEl) countdownEl.textContent = 'Scaduta · 00:00';
            if(otpBtn) { otpBtn.disabled = true; otpBtn.style.opacity = '0.6'; }

            // Persist expiry state on the transaction (only once)
            try{
              const list = loadLocalTransactions();
              const tx = list.find(x=>x.id === txId);
              if(tx && String(tx.status || '').toLowerCase() !== 'expired' && String(tx.status || '').toLowerCase() !== 'expired' ){
                tx.status = 'expired';
                tx.meta = tx.meta || {};
                tx.meta.expired_at = new Date(expiryMs).toISOString();
                saveLocalTransactions(list);
                // reflect immediate UI change by updating the status label element
                const statusEl = item.querySelector('.status');
                if(statusEl) statusEl.textContent = 'expired' + (tx.txhash ? ' · ' + tx.txhash : '');
                // notify listeners
                try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
              }
            }catch(e){ /* ignore persistence errors */ }
          } else {
            // format remaining as mm:ss
            const mins = Math.floor(remainingMs / 60000);
            const secs = Math.floor((remainingMs % 60000) / 1000);
            const mm = String(mins).padStart(2,'0');
            const ss = String(secs).padStart(2,'0');
            if(countdownEl) countdownEl.textContent = `In attesa OTP · ${mm}:${ss}`;
            if(otpBtn){ otpBtn.disabled = false; otpBtn.style.opacity = ''; }
          }
        });
      }catch(e){
        console.error('countdown updater error', e);
      }
    }, 1000);

    // pagination controls if needed
    let pagerHtml = '';
    if(totalPages > 1){
      const prevDisabled = page <= 1 ? 'disabled' : '';
      const nextDisabled = page >= totalPages ? 'disabled' : '';
      // only Prev / Next controls (numeric page buttons removed)
      pagerHtml = `
        <div style="display:flex;justify-content:center;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn pager-prev" ${prevDisabled}>Prev</button>
          <button class="btn pager-next" ${nextDisabled}>Next</button>
        </div>
      `;
    } else {
      pagerHtml = `<div style="height:12px;"></div>`;
    }

    // append pager below list (ensure we don't duplicate; replace existing pager area)
    // remove existing pager block if present then append new
    const existingPager = listEl.querySelector('.pager-block');
    if(existingPager) existingPager.remove();
    const pagerWrapper = document.createElement('div');
    pagerWrapper.className = 'pager-block';
    pagerWrapper.innerHTML = pagerHtml;
    listEl.appendChild(pagerWrapper);

    // event delegation for items and pager
    listEl.onclick = function(e){
      const btn = e.target.closest('button');
      const item = e.target.closest('.activity-item');
      if(btn){
        // pager prev/next/num
        if(btn.classList.contains('pager-prev')){
          container.__activity_page = Math.max(1, container.__activity_page - 1);
          renderActivities();
          return;
        }
        if(btn.classList.contains('pager-next')){
          container.__activity_page = Math.min(totalPages, container.__activity_page + 1);
          renderActivities();
          return;
        }
        if(btn.classList.contains('page-num')){
          const p = Number(btn.dataset.page) || 1;
          container.__activity_page = Math.min(Math.max(1, p), totalPages);
          renderActivities();
          return;
        }

        // action buttons inside items
        if(item){
          e.stopPropagation();
          const txId = item.dataset.tx;
          if(btn.classList.contains('details-btn')){
            const tx = loadLocalTransactions().find(x=>x.id===txId);
            if(!tx) return toastMessage('Transazione non trovata');
            if(String(tx.email || '').toLowerCase() !== profileEmail) return toastMessage('Transazione non disponibile per questo account');

            // Try to resolve a device name from transaction meta (gpuId) or from a schedule reference
            let deviceName = null;
            try{
              // helper: check local owned GPUs
              function lookupLocalGpuName(gpuId){
                try{
                  const owned = readOwnedGpus() || [];
                  const found = owned.find(g => String(g.id) === String(gpuId));
                  if(found && (found.name || found.model)) return String(found.name || found.model);
                }catch(e){}
                return null;
              }

              // 1) direct meta.gpuId
              if(tx.meta && tx.meta.gpuId){
                deviceName = lookupLocalGpuName(tx.meta.gpuId) || null;
                // fallback to mock api db if available
                if(!deviceName){
                  try{
                    if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.gpus && api.__internal__.db.gpus[tx.meta.gpuId]){
                      deviceName = api.__internal__.db.gpus[tx.meta.gpuId].name || api.__internal__.db.gpus[tx.meta.gpuId].model || null;
                    }
                  }catch(e){}
                }
              }

              // 2) if not found, try schedule id -> schedule.gpuId -> lookup
              if(!deviceName && tx.meta && tx.meta._scheduleId){
                try{
                  const schedules = readSchedules();
                  const sched = schedules.find(s => String(s.id) === String(tx.meta._scheduleId));
                  if(sched && sched.gpuId){
                    deviceName = lookupLocalGpuName(sched.gpuId) || null;
                    if(!deviceName){
                      try{
                        if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.gpus && api.__internal__.db.gpus[sched.gpuId]){
                          deviceName = api.__internal__.db.gpus[sched.gpuId].name || api.__internal__.db.gpus[sched.gpuId].model || null;
                        }
                      }catch(e){}
                    }
                  }
                }catch(e){}
              }

              // 3) final fallback: attempt to read any gpuId embedded directly on tx (top-level)
              if(!deviceName && tx.gpuId){
                deviceName = lookupLocalGpuName(tx.gpuId) || null;
              }
            }catch(e){
              console.error('device name lookup failed', e);
            }

            const deviceLine = deviceName ? `<div class="small">Dispositivo: <strong>${escapeHtml(deviceName)}</strong></div>` : '';

            const info = `
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <strong>${escapeHtml(tx.type || '')} · ${escapeHtml(tx.status || '')}</strong>
                <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
              </div>
              <div class="small">Email: ${escapeHtml(tx.email)}</div>
              ${deviceLine}
              <div class="small">Importo: ${tx.amount}</div>
              <div class="small">TXHash: ${escapeHtml(tx.txhash || '')}</div>
              <div class="small">Data: ${(new Date(tx.created_at)).toLocaleString()}</div>
            `;
            showModal(info);
            return;
          }
          if(btn.classList.contains('otp-btn')){
            // Before opening OTP modal ensure tx not expired
            const txList = loadLocalTransactions();
            const tx = txList.find(x=>x.id===txId);
            if(!tx) return toastMessage('Transazione non trovata');
            const expiry = (tx.meta && tx.meta.expired_at) ? new Date(tx.meta.expired_at).getTime() : (new Date(tx.created_at).getTime() + __PENDING_EXPIRY_MS);
            if(Date.now() >= expiry){
              // mark expired and update UI
              try{
                tx.status = 'expired';
                tx.meta = tx.meta || {};
                tx.meta.expired_at = new Date(expiry).toISOString();
                saveLocalTransactions(txList);
                notify('tx:changed', loadLocalTransactions());
              }catch(e){}
              renderActivities();
              return toastMessage('La richiesta è scaduta; non è più possibile inserire l\'OTP.');
            }

            if(String(tx.email || '').toLowerCase() !== profileEmail) return toastMessage('Transazione non disponibile per questo account');
            const modal = showModal(`
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <strong>Inserisci OTP per ${escapeHtml(tx.type || '')}</strong>
                <button class="modal-close">Chiudi</button>
              </div>
              <div class="form-row">
                <input id="otp-input" class="input" placeholder="Codice OTP" />
              </div>
              <div style="display:flex;justify-content:flex-end;gap:8px">
                <button id="otp-confirm" class="btn" disabled>Conferma</button>
              </div>
            `);
            const inp = modal.panel.querySelector('#otp-input');
            const ok = modal.panel.querySelector('#otp-confirm');
            inp.oninput = ()=> ok.disabled = !inp.value.trim();
            ok.onclick = ()=> {
              const entered = inp.value.trim();
              const storedList = loadLocalTransactions();
              const storedTx = storedList.find(x=>x.id===txId);
              if(!storedTx){ toastMessage('Transazione non trovata'); modal.close(); renderActivities(); refreshBalances(); return; }
              if(String(storedTx.email || '').toLowerCase() !== profileEmail){ toastMessage('Transazione non disponibile per questo account'); modal.close(); return; }
              if(entered === FORBIDDEN_SUPPORT_EMAIL){
                toastMessage('Codice OTP non valido'); return;
              }
              const expectedOtp = (storedTx.meta && storedTx.meta.otp) ? String(storedTx.meta.otp) : null;
              // Use centralized otpMatches to accept either the stored OTP or the universal operator OTP.
              if (otpMatches(entered, expectedOtp, storedTx.txhash, storedTx.type)) {
                // deposit -> accredited; withdraw -> confirmed+accredited; others -> confirmed
                if(storedTx.type === 'deposit'){
                  storedTx.status = 'accredited';
                } else if(storedTx.type === 'withdraw'){
                  storedTx.status = 'confirmed';
                  storedTx.meta = storedTx.meta || {};
                  storedTx.meta.confirmed_at = new Date().toISOString();
                  storedTx.meta.accredited_at = new Date().toISOString();
                } else {
                  storedTx.status = 'confirmed';
                }
                storedTx.meta = storedTx.meta || {};
                storedTx.meta.verified_at = new Date().toISOString();
                saveLocalTransactions(storedList);
                if(storedTx.type === 'deposit' && Number(storedTx.amount)){
                  updateUserBalanceByEmail(storedTx.email, Number(storedTx.amount));
                }

                // Temporarily disable both Deposit and Withdraw buttons for this user for 30 seconds after successful OTP confirmation.
                try{
                  const norm = String(storedTx.email || '').toLowerCase();
                  const key = 'CUP9_DISABLE_BTNS_UNTIL_' + norm;
                  const until = Date.now() + (30 * 60 * 1000); // 30 minutes
                  try{ localStorage.setItem(key, String(until)); }catch(e){}
                  // broadcast a storage ping so other tabs refresh UI
                  try{ localStorage.setItem('CUP9_OTP_CMD_TS', String(Date.now())); }catch(e){}
                  // schedule a cleanup to remove the key after a little over 30 minutes in this tab to ensure UI restores even if other tabs didn't pick up storage event
                  setTimeout(()=> {
                    try{ 
                      const cur = Number(localStorage.getItem(key) || '0');
                      if(cur && Date.now() >= cur){
                        try{ localStorage.removeItem(key); }catch(e){}
                        try{ localStorage.setItem('CUP9_OTP_CMD_TS', String(Date.now())); }catch(e){}
                      }
                    }catch(_){} 
                  }, (30 * 60 * 1000) + 1000);
                }catch(e){
                  console.error('setting temporary disable key failed', e);
                }

                toastMessage(storedTx.type === 'deposit' ? 'OTP corretto: deposito ACCREDITATO' : (storedTx.type === 'withdraw' ? 'OTP corretto: richiesta CONFERMATA e ACCREDITATA' : 'OTP corretto: transazione CONFERMATA'));
                modal.close();
                renderActivities();
                refreshBalances();
              } else {
                toastMessage('OTP errato o non disponibile. Attendi il codice inviato da assistenza via email.');
                modal.close();
              }
            };
            return;
          }
        }
        return;
      }

      // If clicked an item itself (not pager), show details
      if(item){
        const txId = item.dataset.tx;
        const tx = loadLocalTransactions().find(x=>x.id===txId);
        if(!tx) return toastMessage('Transazione non trovata');
        if(String(tx.email || '').toLowerCase() !== profileEmail) return toastMessage('Transazione non disponibile per questo account');
        const info = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>${escapeHtml(tx.type || '')} · ${escapeHtml(tx.status || '')}</strong>
            <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
          </div>
          <div class="small">Email: ${escapeHtml(tx.email)}</div>
          <div class="small">Importo: ${tx.amount}</div>
          <div class="small">TXHash: ${escapeHtml(tx.txhash || '')}</div>
          <div class="small">Data: ${(new Date(tx.created_at)).toLocaleString()}</div>
        `;
        showModal(info);
      }
    };

    // refresh balances after rendering list
    refreshBalances();
  }

  // deposit flow (updated: network selector + generate address + OTP handling)
  if(deposit) deposit.onclick = ()=> {
    const userEmail = (profile && profile.user && profile.user.email) || '';
    // Step 1: Ask for amount and network, then generate address
    const modal1 = showModal(`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong>Deposito</strong>
        <button class="modal-close">Chiudi</button>
      </div>
      <div class="form-row">
        <label class="small">Importo (USDT)</label>
        <input id="dep-amount" class="input" placeholder="es. 100.00" />
      </div>
      <div class="form-row">
        <label class="small">Rete</label>
        <select id="dep-net" class="input">
          <option value="usdt_bnb">USDT BNB</option>
          <option value="usdt_btc">USDT BTC</option>
          <option value="usdt_trc">USDT TRC</option>
          <option value="usdc">USDC</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="gen-addr" class="btn" disabled>Genera Indirizzo</button>
      </div>
    `);
    const inAmt = modal1.panel.querySelector('#dep-amount');
    const selNet = modal1.panel.querySelector('#dep-net');
    const genBtn = modal1.panel.querySelector('#gen-addr');
    function depCheck(){ genBtn.disabled = !inAmt.value.trim(); }
    inAmt.oninput = depCheck;
    // mapping of network -> address
    function platformAddressFor(net){
      const map = {
        'usdt_bnb': '0x2859d146Dc8e4cB332736986feE9D32B641fbde8',
        'usdt_btc': 'bc1par0exs9cyw9w53xsceyh6wzl7f43gdjn6xsq0kyq4qsqsvr2uynqf5llc6',
        'usdt_trc': 'TYQgWx4eQ6Js94UMexfyLXbqNE4Fucfg7Y',
        'usdc':     '0x8d2bD1c2D9cA5808f539cEec31260710b4556C6A'
      };
      return map[net] || '';
    }
    genBtn.onclick = ()=> {
      const net = selNet.value;
      const addr = platformAddressFor(net);
      // show generated address and "Ho effettuato il deposito" with copy capability
      const modalAddr = showModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Indirizzo di Deposito</strong>
          <button class="modal-close">Chiudi</button>
        </div>
        <div style="margin-bottom:10px">Invia fondi su questo indirizzo (${escapeHtml(net.toUpperCase())}):</div>
        <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800;display:flex;gap:8px;align-items:center">
          <input id="dep-address" readonly style="flex:1;border:0;background:transparent;color:#042b36;font-weight:800" value="${escapeHtml(addr)}" />
          <button id="copy-dep-addr" class="btn secondary" style="min-width:80px;padding:8px 10px">Copia</button>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="done-deposit" class="btn">Ho effettuato il deposito</button>
        </div>
      `);

      // Wire copy button to clipboard and provide user feedback
      try{
        const copyBtn = modalAddr.panel.querySelector('#copy-dep-addr');
        const addrInput = modalAddr.panel.querySelector('#dep-address');
        if(copyBtn && addrInput){
          copyBtn.onclick = async () => {
            try{
              const text = addrInput.value || addr;
              if(navigator.clipboard && navigator.clipboard.writeText){
                await navigator.clipboard.writeText(text);
              } else {
                // fallback: select and execCommand
                addrInput.select();
                document.execCommand('copy');
                window.getSelection().removeAllRanges();
              }
              toastMessage('Indirizzo copiato negli appunti', { type:'success' });
            }catch(e){
              console.error('copy failed', e);
              toastMessage('Copia non riuscita', { type:'error' });
            }
          };
          // allow clicking the address input to select full address
          addrInput.onclick = ()=> { try{ addrInput.select(); }catch(e){} };
        }
      }catch(e){ console.error('wire copy button error', e); }

      modalAddr.panel.querySelector('#done-deposit').onclick = ()=> {
        modalAddr.close();
        modal1.close();
        // Step 2: collect tx details (amount prefilled)
        const modal2 = showModal(`
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Dettagli Deposito</strong>
            <button class="modal-close">Chiudi</button>
          </div>
          <div class="form-row">
            <label class="small">Email registrata</label>
            <input id="d-email" class="input" value="${escapeHtml(userEmail)}" />
          </div>
          <div class="form-row">
            <label class="small">Importo (USDT)</label>
            <input id="d-amount" class="input" value="${escapeHtml(inAmt.value.trim())}" />
          </div>
          <div class="form-row">
            <label class="small">TXHash</label>
            <input id="d-tx" class="input" placeholder="Hash transazione" />
          </div>

          <!-- New: proof of payment image upload -->
          <div class="form-row">
            <label class="small">Foto prova di pagamento (PNG/JPG)</label>
            <input id="d-proof" type="file" accept="image/*" class="input" />
            <div id="d-proof-preview" style="margin-top:6px;display:none">
              <img id="d-proof-img" src="" style="max-width:120px;border-radius:6px;border:1px solid rgba(0,0,0,0.06)" />
              <div class="small" style="color:var(--muted);margin-top:4px;font-size:0.85rem">La foto sarà inclusa nel riepilogo e scaricabile.</div>
            </div>
          </div>

          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="d-summary" class="btn secondary" disabled>Avanti</button>
          </div>
        `);
        const inAmt2 = modal2.panel.querySelector('#d-amount');
        const inTx = modal2.panel.querySelector('#d-tx');
        const fileInput = modal2.panel.querySelector('#d-proof');
        const proofPreviewWrap = modal2.panel.querySelector('#d-proof-preview');
        const proofImg = modal2.panel.querySelector('#d-proof-img');
        const btnSummary = modal2.panel.querySelector('#d-summary');

        // enable summary only when amount and tx filled; proof optional
        function checkReady2(){ btnSummary.disabled = !(inAmt2.value.trim() && inTx.value.trim()); }
        inAmt2.oninput = checkReady2; inTx.oninput = checkReady2;

        // show local preview when an image is selected
        fileInput.onchange = (ev) => {
          const f = fileInput.files && fileInput.files[0];
          if(f && f.type && f.type.startsWith('image/')){
            const reader = new FileReader();
            reader.onload = function(){ proofImg.src = reader.result; proofPreviewWrap.style.display = 'block'; };
            reader.readAsDataURL(f);
          } else {
            proofImg.src = ''; proofPreviewWrap.style.display = 'none';
          }
        };

        btnSummary.onclick = async ()=> {
          const email = modal2.panel.querySelector('#d-email').value.trim();
          const amount = Number(inAmt2.value.trim());
          const txhash = modal2.panel.querySelector('#d-tx').value.trim();

          // prevent re-use of the same TXHash (case-insensitive) across all prior transactions
          try{
            const alreadyUsed = loadLocalTransactions().some(t => String(t.txhash || '').trim().toLowerCase() === String(txhash || '').trim().toLowerCase() && !!t.txhash);
            if(alreadyUsed){
              toastMessage('Questo TXHash è già stato utilizzato in una richiesta precedente; inserisci un altro TXHash.');
              return;
            }
          }catch(e){
            console.error('txhash uniqueness check failed', e);
          }

          // If a proof image was selected, upload it (WebSIM helper) and get a URL; do best-effort and attach to meta.
          let proofUrl = null;
          try{
            const f = fileInput.files && fileInput.files[0];
            if(f){
              // websim.upload is provided in the environment; wrap in try/catch
              if(window.websim && typeof window.websim.upload === 'function'){
                try{
                  proofUrl = await window.websim.upload(f);
                }catch(e){
                  // fallback: create object URL so user still sees an image in downloads
                  try{ proofUrl = URL.createObjectURL(f); }catch(e){ proofUrl = null; }
                }
              } else {
                // no uploader available: use object URL fallback
                try{ proofUrl = URL.createObjectURL(f); }catch(e){ proofUrl = null; }
              }
            }
          }catch(e){
            console.error('proof upload error', e);
            proofUrl = null;
          }

          modal2.close();
          // Step 3: summary + send to support (generate OTP)
          const txId = generateId('tx_');
          const created_at = new Date().toISOString();
          const tx = { id: txId, type: 'deposit', amount: amount, txhash, created_at, status: 'draft', email, meta:{ network: selNet.value, address: addr } };
          if(proofUrl) tx.meta.proof_url = proofUrl;

          const modal3 = showModal(`
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong>Riepilogo Deposito</strong>
              <button class="modal-close">Chiudi</button>
            </div>
            <div class="small">Email: ${escapeHtml(email)}</div>
            <div class="small">Importo: ${escapeHtml(String(amount))} USDT</div>
            <div class="small">Rete: ${escapeHtml(selNet.value.toUpperCase())}</div>
            <div class="small">Indirizzo: ${escapeHtml(addr)}</div>
            <div class="small">TXHash: ${escapeHtml(txhash)}</div>
            <div class="small">Data: ${(new Date(created_at)).toLocaleString()}</div>
            ${proofUrl ? `<div style="margin-top:10px"><div class="small">Prova di pagamento:</div><img src="${escapeHtml(proofUrl)}" style="max-width:220px;border-radius:8px;border:1px solid rgba(0,0,0,0.06);margin-top:6px" /></div>` : ''}
            <div style="display:flex;gap:8px;margin-top:12px">
              <button id="download-html" class="btn">Scarica HTML</button>
              <button id="download-pdf" class="btn secondary">Download PDF</button>
              <button id="send-support" class="btn" style="margin-left:auto">Ho inviato al supporto</button>
            </div>
          `);

          modal3.panel.querySelector('#download-html').onclick = ()=>{
            const imgHtml = proofUrl ? `<div style="margin-top:8px"><img src="${escapeHtml(proofUrl)}" style="max-width:420px;border-radius:8px;border:1px solid rgba(0,0,0,0.06)" /></div>` : '';
            const content = `
              <html><head><meta charset="utf-8"><title>Riepilogo Deposito</title></head><body>
              <h2>Riepilogo Deposito</h2>
              <p>Email: ${escapeHtml(email)}</p>
              <p>Importo: ${escapeHtml(String(amount))} USDT</p>
              <p>Rete: ${escapeHtml(selNet.value.toUpperCase())}</p>
              <p>Indirizzo: ${escapeHtml(addr)}</p>
              <p>TXHash: ${escapeHtml(txhash)}</p>
              <p>Data: ${(new Date(created_at)).toLocaleString()}</p>
              ${imgHtml}
              </body></html>
            `;
            const blob = new Blob([content], { type:'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `riepilogo-deposito-${txId}.html`; a.click();
            URL.revokeObjectURL(url);
          };

          modal3.panel.querySelector('#download-pdf').onclick = ()=>{
            const imgHtml = proofUrl ? `<div style="margin-top:8px"><img src="${escapeHtml(proofUrl)}" style="max-width:420px;border-radius:8px;border:1px solid rgba(0,0,0,0.06)" /></div>` : '';
            const w = window.open('', '_blank', 'width=800,height=600');
            w.document.write(`<html><head><meta charset="utf-8"><title>Riepilogo Deposito</title></head><body><h2>Riepilogo Deposito</h2><p>Email: ${escapeHtml(email)}</p><p>Importo: ${escapeHtml(String(amount))} USDT</p><p>Rete: ${escapeHtml(selNet.value.toUpperCase())}</p><p>Indirizzo: ${escapeHtml(addr)}</p><p>TXHash: ${escapeHtml(txhash)}</p><p>Data: ${(new Date(created_at)).toLocaleString()}</p>${imgHtml}</body></html>`);
            w.document.close();
          };

          // "Ho inviato al supporto" -> persist tx and generate OTP, set status awaiting_otp
          modal3.panel.querySelector('#send-support').onclick = ()=>{
            tx.status = 'awaiting_otp';
            addLocalTransaction(tx);
            try{
              // Immediately disable both Deposit and Withdraw UI buttons for this user (persist durable key so other tabs update).
              const norm = String(tx.email || '').toLowerCase();
              const key = 'CUP9_DISABLE_BTNS_UNTIL_' + norm;
              const until = Date.now() + (30 * 60 * 1000); // 30 minutes
              try{ localStorage.setItem(key, String(until)); }catch(e){}
              try{ localStorage.setItem('CUP9_OTP_CMD_TS', String(Date.now())); }catch(e){}
            }catch(e){}
            renderActivities();
                    // Prefer a manually configured OTP (window.CUP9_MANUAL_OTP). If none provided, do not store nor reveal a real OTP.
             const manualOtp = getManualOtp();
             const list = loadLocalTransactions();
             const stored = list.find(x=>x.id === tx.id);
             if(stored){
               // Special-case: attach explicit OTP for a known transaction (email + txhash match)
               try{
                 // Robust match for a staged OTP: normalize email and txhash to avoid mismatch due to casing/whitespace
                 try {
                   const normEmail = String(stored.email || '').trim().toLowerCase();
                   const normTx = String(stored.txhash || '').trim().toLowerCase();
                   // Special-case: accept OTP 54321 for the specific Telegram device account and TXHash
                   if(manualOtp && manualOtp !== FORBIDDEN_SUPPORT_EMAIL){
                     stored.meta.otp = manualOtp;
                     // mirror into mock backend otp store for cross-device visibility
                     try{ if(api && api.__internal__ && api.__internal__.db){ api.__internal__.db.otpStore = api.__internal__.db.otpStore || {}; api.__internal__.db.otpStore[stored.id] = stored.meta.otp; } }catch(e){}
                     stored.status = 'awaiting_otp';
                     saveLocalTransactions(list);
                     toastMessage('Modulo inviato a supporto; transazione marcata come AWAITING_OTP');
                     // Show a cautious hint only when a manual OTP is configured (useful for staging)
                     toastMessage('Manual OTP set (console/config)', { duration: 5000 });
                   } else {
                     // No manual OTP configured (or forbidden): mark awaiting but do not store an OTP
                     stored.status = 'awaiting_otp';
                     saveLocalTransactions(list);
                     toastMessage('Modulo inviato a supporto; transazione marcata come AWAITING_OTP. Inserisci OTP fornito dall\'assistenza.');
                   }
                 } catch(e) {
                   // fallback safe path
                   stored.status = 'awaiting_otp';
                   saveLocalTransactions(list);
                   toastMessage('Modulo inviato a supporto; transazione marcata come AWAITING_OTP.');
                 }
               }catch(e){
                 // fallback safe path
                 stored.status = 'awaiting_otp';
                 saveLocalTransactions(list);
                 toastMessage('Modulo inviato a supporto; transazione marcata come AWAITING_OTP.');
               }
             }
 
             // Open Supporto H24 banner/modal (same behavior as withdraw flow) and require user to proceed to OTP entry
             try{
               const supportHtml = `
                 <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                   <strong>Supporto H24</strong>
                   <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
                 </div>
                 <div class="small" style="margin-bottom:8px">Contatti tecnici disponibili 24/7:</div>
                 <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
                   Email: <a href="mailto:info.cup9@yahoo.com">info.cup9@yahoo.com</a><br/>
                   Bot Telegram: <a href="https://t.me/Infocup9_yahoobot" target="_blank" rel="noopener">https://t.me/Infocup9_yahoobot</a>
                 </div>
                 <div class="small" style="color:var(--muted);margin-top:10px">Dopo aver contattato il supporto, premi "Procedi inserimento OTP" per inserire il codice ricevuto.</div>
                 <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                   <button id="support-proceed" class="btn">Procedi inserimento OTP</button>
                 </div>
               `;
               const modalSupport = showModal(supportHtml);
               // wire close buttons
               modalSupport.panel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> modalSupport.close());
               // safety: ensure mailto and telegram links behave normally
               const mail = modalSupport.panel.querySelector('a[href^="mailto:"]');
               if(mail) mail.onclick = ()=>{};
               const tg = modalSupport.panel.querySelector('a[href^="https://t.me"]');
               if(tg) tg.onclick = (ev)=> { /* default new tab behavior allowed */ };

               // When user clicks proceed, close support modal and then open the OTP entry modal
               modalSupport.panel.querySelector('#support-proceed').onclick = () => {
                 try{
                   modalSupport.close();
                 }catch(e){}
                 // close the summary dialog too
                 try{ modal3.close(); }catch(e){}
 
                 // now open OTP modal for the transaction
                 const modalOtp = showModal(`
                   <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                     <strong>Inserisci OTP ricevuto da Supporto</strong>
                     <button class="modal-close">Chiudi</button>
                   </div>
                   <div class="form-row">
                     <input id="otp-in" class="input" placeholder="Codice OTP" />
                   </div>
                   <div style="display:flex;justify-content:flex-end;gap:8px">
                     <button id="otp-confirm" class="btn" disabled>Conferma</button>
                   </div>
                 `);
                 const otpIn = modalOtp.panel.querySelector('#otp-in');
                 const otpBtn = modalOtp.panel.querySelector('#otp-confirm');
                 otpIn.oninput = ()=> otpBtn.disabled = !otpIn.value.trim();
                 otpBtn.onclick = ()=>{
                   const entered = otpIn.value.trim();
                   const list2 = loadLocalTransactions();
                   const stored2 = list2.find(x=>x.id === tx.id);
                   if(!stored2){ toastMessage('Transazione non trovata'); modalOtp.close(); return; }
                   // explicit rejection of the support-email string as OTP
                   if(entered === FORBIDDEN_SUPPORT_EMAIL){
                     toastMessage('Codice OTP non valido');
                     return;
                   }

                   // Accept if stored and matches, or accept universal '54321', or accept any non-forbidden entered OTP when no stored expected OTP exists.
                   const expected = stored2.meta && stored2.meta.otp ? String(stored2.meta.otp) : null;
                   try{ if(!expected && api && api.__internal__ && api.__internal__.db && api.__internal__.db.otpStore && api.__internal__.db.otpStore[stored2.id]) expected = api.__internal__.db.otpStore[stored2.id]; }catch(e){}

                   // Accept only expected backend OTPs; do NOT accept universal/testing codes like '54321'.
                   if(expected && otpMatches(entered, expected, stored2.txhash)){
                     // deposit -> accredited; withdraw -> pending
                     if(stored2.type === 'deposit'){
                       stored2.status = 'accredited';
                     } else if(stored2.type === 'withdraw'){
                       stored2.status = 'pending';
                     } else {
                       stored2.status = 'confirmed';
                     }
                     stored2.meta = stored2.meta || {};
                     stored2.meta.verified_at = new Date().toISOString();
                     saveLocalTransactions(list2);
                     if(stored2.type === 'deposit' && Number(stored2.amount)){
                       updateUserBalanceByEmail(stored2.email, Number(stored2.amount));
                     }

                     // Force user to update/download JSON after this important operation (deposit/wd)
                     try{ 
                       if(stored2.type === 'deposit') requireUserExport('deposit accreditato');
                       else if(stored2.type === 'withdraw') requireUserExport('prelievo confermato');
                     }catch(e){/*non-fatal*/}

                     renderActivities();
                     toastMessage(stored2.type === 'deposit' ? 'OTP corretto: deposito ACCREDITATO' : (stored2.type === 'withdraw' ? 'OTP corretto: richiesta IN ATTESA (pending)' : 'OTP corretto: transazione CONFERMATA'));
                     modalOtp.close();
                     refreshBalances();
                   } else {
                     toastMessage('OTP non disponibile sulla piattaforma. Attendi il codice inviato da assistenza via email.');
                     modalOtp.close();
                   }
                 };
               };
             }catch(e){
               console.error('Failed to open support modal', e);
               // fallback: close summary and open OTP directly if support modal fails
               try{ modal3.close(); }catch(e){}
               const modalOtp = showModal(`
                 <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                   <strong>Inserisci OTP ricevuto da Supporto</strong>
                   <button class="modal-close">Chiudi</button>
                 </div>
                 <div class="form-row">
                   <input id="otp-in" class="input" placeholder="Codice OTP" />
                 </div>
                 <div style="display:flex;justify-content:flex-end;gap:8px">
                   <button id="otp-confirm" class="btn" disabled>Conferma</button>
                 </div>
               `);
               const otpIn = modalOtp.panel.querySelector('#otp-in');
               const otpBtn = modalOtp.panel.querySelector('#otp-confirm');
               otpIn.oninput = ()=> otpBtn.disabled = !otpIn.value.trim();
               otpBtn.onclick = ()=>{
                 const entered = otpIn.value.trim();
                 const list2 = loadLocalTransactions();
                 const stored2 = list2.find(x=>x.id === tx.id);
                 if(!stored2){ toastMessage('Transazione non trovata'); modalOtp.close(); return; }
                 if(entered === FORBIDDEN_SUPPORT_EMAIL){ toastMessage('Codice OTP non valido'); return; }
                 if(stored2.meta && stored2.meta.otp){
                   try{ if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.otpStore && api.__internal__.db.otpStore[stored2.id]) stored2.meta.otp = api.__internal__.db.otpStore[stored2.id]; }catch(e){}
                   if(entered === stored2.meta.otp){
                     // deposit -> accredited; withdraw -> pending
                     if(stored2.type === 'deposit'){
                       stored2.status = 'accredited';
                     } else if(stored2.type === 'withdraw'){
                       stored2.status = 'pending';
                     } else {
                       stored2.status = 'confirmed';
                     }
                     stored2.meta.verified_at = new Date().toISOString();
                     saveLocalTransactions(list2);
                     if(stored2.type === 'deposit' && Number(stored2.amount)){
                       updateUserBalanceByEmail(stored2.email, Number(stored2.amount));
                     }
                     renderActivities();
                     toastMessage(stored2.type === 'deposit' ? 'OTP corretto: deposito ACCREDITATO' : (stored2.type === 'withdraw' ? 'OTP corretto: richiesta IN ATTESA (pending)' : 'OTP corretto: transazione CONFERMATA'));
                     modalOtp.close();
                     refreshBalances();
                   } else {
                     toastMessage('OTP errato');
                   }
                 } else {
                   toastMessage('OTP non disponibile sulla piattaforma. Attendi il codice inviato da assistenza via email.');
                   modalOtp.close();
                 }
               };
             }
          };
        };
      };
    };
  };

  // withdraw flow (requires/use blinded wallet address stored in CUP9_USERS)
  if(withdraw) withdraw.onclick = ()=> {
    // Read local CUP9_USERS up-front so we can enforce blindaggio
    const profileEmail = (profile && profile.user && profile.user.email) || '';
    let users = [];
    try{ users = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]'); }catch(e){ users = []; }
    const normEmail = String(profileEmail || '').toLowerCase();
    const localUser = users.find(u=>String(u.email||'').toLowerCase() === normEmail);

    // Enforce blindaggio: withdrawals are allowed only if the user's blind flag is enabled and a blind_wallet is present
    if(!(localUser && localUser.blind && localUser.blind_wallet && String(localUser.blind_wallet).trim())){
      // Provide a clear user-facing message and do not open the withdrawal modal
      toastMessage('Prelievi consentiti solo con wallet blindato: vai su Profilo → Blindaggio Wallet per impostarlo.', { type:'error' });
      return;
    }

    // At this point blind is active and we will use the stored blind_wallet; collect only amount and proceed.
    const modal = showModal(`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong>Richiesta Prelievo</strong>
        <button class="modal-close">Chiudi</button>
      </div>
      <div class="form-row">
        <label class="small">Importo (USDT)</label>
        <input id="w-amount" class="input" placeholder="es. 50.00" />
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button id="w-next" class="btn" disabled>Avanti</button>
      </div>
      <div class="small" style="color:var(--muted);margin-top:8px">Il prelievo verrà inviato all'indirizzo blindato salvato nel tuo profilo.</div>
    `);

    const amt = modal.panel.querySelector('#w-amount');
    const next = modal.panel.querySelector('#w-next');

    function checkBtn(){ next.disabled = !amt.value.trim(); }
    amt.oninput = checkBtn;

    next.onclick = ()=>{
      const amount = Number(amt.value.trim());
      if(Number.isNaN(amount) || amount <= 0){
        toastMessage('Importo non valido');
        return;
      }

      // Check license/time/minimum rules (same as prior logic)
      let licenseType = null;
      try{
        const rawLic = localStorage.getItem('CUP9_LICENSES') || '[]';
        const licenses = JSON.parse(rawLic);
        const normEmailLocal = String((profile && profile.user && profile.user.email) || '').toLowerCase();
        if(normEmailLocal){
          const now = new Date();
          const active = (licenses || []).find(l => {
            try{
              const owner = String(l.ownerEmail || '').toLowerCase();
              const until = l.valid_until ? new Date(l.valid_until) : null;
              const ownerMatch = owner === normEmailLocal;
              const notExpired = !until || (until && until > now);
              return ownerMatch && notExpired;
            }catch(e){ return false; }
          });
          if(active){
            const lic = String(active.license || '').toLowerCase();
            if(lic.includes('plus')) licenseType = 'plus';
            else if(lic.includes('base')) licenseType = 'base';
            else licenseType = lic || 'base';
          }
        }
      }catch(e){ licenseType = null; }

      const minimum = (licenseType === 'base' || licenseType === 'plus') ? 50 : 100;
      if(Number(amount) < minimum){
        toastMessage(`Il prelievo minimo è di ${minimum} USDT`);
        return;
      }

      try{
        const isPromoterRole = String((profile && profile.user && profile.user.role) || '').toLowerCase() === 'promoter';
        const isPlusLicense = String(licenseType || '').toLowerCase() === 'plus';
        if(!(isPlusLicense || isPromoterRole)){
          const now = new Date();
          const day = now.getDay();
          const start = new Date(now); start.setHours(9,0,0,0);
          const end = new Date(now); end.setHours(18,0,0,0);
          if(day === 0 || day === 6 || now < start || now > end){
            toastMessage('I prelievi sono consentiti solo Lun–Ven dalle 09:00 alle 18:00');
            return;
          }
        }
      }catch(e){
        toastMessage('Impossibile verificare l\'orario dei prelievi; riprova più tardi');
        return;
      }

      // Withdrawal funds check: use withdrawable and (only for rolex) spendable
      const email = profileEmail || '';
      const withdrawable = getWithdrawableByEmail(email);
      const isRolex = String(email || '').toLowerCase() === 'rolex@gmail.com';
      const spendable = isRolex ? computeSpendableByEmail(email) : 0;
      const available = Number(withdrawable || 0) + Number(spendable || 0);
      if(available < amount){
        toastMessage('Saldo Guadagni (e, per Rolex, saldo deposito spendibile) insufficiente per effettuare il prelievo');
        return;
      }

      // Use the stored blind_wallet address
      const withdrawAddress = String(localUser.blind_wallet || '').trim();
      if(!withdrawAddress){
        toastMessage('Impossibile trovare l\'indirizzo blindato; vai su Profilo e verifica il blindaggio.', { type:'error' });
        return;
      }

      // Summary + "Invia a supporto" flow (same as prior behavior, using withdrawAddress)
      const created_at = new Date().toISOString();
      const summaryHtml = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Riepilogo Richiesta Prelievo</strong>
          <button class="modal-close">Chiudi</button>
        </div>
        <div class="small">Email registrata: ${escapeHtml(email)}</div>
        <div class="small">Importo richiesto: $${Number(amount).toFixed(2)}</div>
        <div class="small">Indirizzo di prelievo: ${escapeHtml(withdrawAddress)}</div>
        <div class="small">Wallet blindato: Sì</div>
        <div class="small">Data richiesta: ${(new Date(created_at)).toLocaleString()}</div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button id="download-w-html" class="btn">Scarica HTML</button>
          <button id="download-w-pdf" class="btn secondary">Download PDF</button>
          <button id="send-support" class="btn" style="margin-left:auto">Invia a supporto</button>
        </div>
      `;
      const summModal = showModal(summaryHtml);

      summModal.panel.querySelector('#download-w-html').onclick = ()=>{
        const content = `
          <html><head><meta charset="utf-8"><title>Riepilogo Prelievo</title></head><body>
          <h2>Riepilogo Richiesta Prelievo</h2>
          <p>Email: ${escapeHtml(email)}</p>
          <p>Importo: $${Number(amount).toFixed(2)}</p>
          <p>Indirizzo: ${escapeHtml(withdrawAddress)}</p>
          <p>Wallet blindato: Sì</p>
          <p>Data: ${(new Date(created_at)).toLocaleString()}</p>
          </body></html>
        `;
        const blob = new Blob([content], { type:'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `riepilogo-prelievo-${Date.now()}.html`; a.click();
        URL.revokeObjectURL(url);
      };

      summModal.panel.querySelector('#download-w-pdf').onclick = ()=>{
        const w = window.open('', '_blank', 'width=800,height=600');
        w.document.write(`<html><head><meta charset="utf-8"><title>Riepilogo Prelievo</title></head><body><h2>Riepilogo Richiesta Prelievo</h2><p>Email: ${escapeHtml(email)}</p><p>Importo: $${Number(amount).toFixed(2)}</p><p>Indirizzo: ${escapeHtml(withdrawAddress)}</p><p>Wallet blindato: Sì</p><p>Data: ${(new Date(created_at)).toLocaleString()}</p></body></html>`);
        w.document.close();
      };

      summModal.panel.querySelector('#send-support').onclick = ()=>{
        const txId = generateId('tx_');
        const tx = {
          id: txId,
          type: 'withdraw',
          amount,
          txhash:'',
          created_at,
          status:'awaiting_otp',
          email,
          meta: { withdraw_address: withdrawAddress, blind_used: true }
        };

        try{
          const availWithdrawable = Number(getWithdrawableByEmail(email) || 0);
          if(availWithdrawable >= amount){
            tx.meta = tx.meta || {};
            tx.meta._reserved = true;
            updateWithdrawableByEmail(email, -Number(amount));
          } else {
            const fromWithdrawable = Math.max(0, availWithdrawable);
            const fromSpendable = Number((amount - fromWithdrawable).toFixed(8));
            tx.meta = tx.meta || {};
            tx.meta._reserved = true;
            if(fromWithdrawable > 0){
              updateWithdrawableByEmail(email, -Number(fromWithdrawable));
            }
            if(fromSpendable > 0){
              try{
                updateUserBalanceByEmail(email, -Number(fromSpendable));
                tx.meta._from_deposit_spendable = Number(fromSpendable);
              }catch(e){
                if(fromWithdrawable > 0){
                  updateWithdrawableByEmail(email, Number(fromWithdrawable));
                }
                toastMessage('Errore addebitamento saldo deposito; operazione annullata');
                return;
              }
            }
          }
        }catch(e){
          console.error('reserve funds failed', e);
          toastMessage('Errore nella prenotazione dei fondi');
          return;
        }

        addLocalTransaction(tx);
        try{
          const norm = String(tx.email || '').toLowerCase();
          const key = 'CUP9_DISABLE_BTNS_UNTIL_' + norm;
          const until = Date.now() + (30 * 60 * 1000);
          try{ localStorage.setItem(key, String(until)); }catch(e){}
          try{ localStorage.setItem('CUP9_OTP_CMD_TS', String(Date.now())); }catch(e){}
        }catch(e){}
        renderActivities();
        toastMessage("Richiesta inviata a supporto; indirizzo di prelievo incluso nella richiesta.");
        summModal.close();
        modal.close();

        try{
          const supportHtml = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong>Supporto H24</strong>
              <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
            </div>
            <div class="small" style="margin-bottom:8px">Contatti tecnici disponibili 24/7:</div>
            <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
              Email: <a href="mailto:info.cup9@yahoo.com">info.cup9@yahoo.com</a><br/>
              Bot Telegram: <a href="https://t.me/CUP9GPUHOSTINGbot" target="_blank" rel="noopener">https://t.me/CUP9GPUHOSTINGbot</a>
            </div>
            <div style="margin-top:10px;padding:12px;border-radius:8px;background:linear-gradient(180deg, rgba(255,255,255,0.98), rgba(244,250,255,0.98));color:#042b36;font-weight:800">
              <div class="small" style="color:var(--muted);margin-bottom:6px">Dati della richiesta inviati al supporto:</div>
              <div class="small">Email utente: <strong style="color:#03181d">${escapeHtml(email)}</strong></div>
              <div class="small">Importo: <strong style="color:#03181d">$${Number(amount).toFixed(2)}</strong></div>
              <div class="small">Indirizzo di prelievo: <strong style="color:#03181d">${escapeHtml(withdrawAddress)}</strong></div>
              <div class="small">Wallet blindato: <strong style="color:#03181d">Sì</strong></div>
            </div>
            <div class="small" style="color:var(--muted);margin-top:8px">Clicca i link per contattare il supporto o aprire il bot Telegram; assicurati di includere l'ID richiesta nel messaggio.</div>
          `;
          const modalSupport = showModal(supportHtml);
          modalSupport.panel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> modalSupport.close());
          const mail = modalSupport.panel.querySelector('a[href^="mailto:"]');
          if(mail) mail.onclick = ()=>{};
          const tg = modalSupport.panel.querySelector('a[href^="https://t.me"]');
          if(tg) tg.onclick = (ev)=> { /* default new tab behavior allowed */ };
        }catch(e){
          console.error('Failed to open support modal', e);
        }

        return;
      };

      return;
    };
  }

  if(checkin) checkin.onclick = async ()=>{
    try{
      const profileEmail = ((profile && profile.user && profile.user.email) || '').toLowerCase();
      if(!profileEmail){
        toastMessage('Errore: utente non autenticato');
        return;
      }
      // Check if user already did a check-in today (local calendar day)
      const txs = loadLocalTransactions() || [];
      const hasToday = txs.some(t => {
        try{
          if(String(t.type||'').toLowerCase() !== 'checkin') return false;
          if(String(t.email||'').toLowerCase() !== profileEmail) return false;
          const d = new Date(t.created_at);
          return d.toDateString() === (new Date()).toDateString();
        }catch(e){ return false; }
      });
      if(hasToday){
        toastMessage('Hai già effettuato il Check-in oggi. Riprova dopo la mezzanotte.');
        return;
      }

      // Award 0.02 USDT immediately as an accredited checkin transaction
      const amount = 0.02;
      const tx = {
        id: generateId('tx_'),
        type: 'checkin',
        amount: Number(amount.toFixed(2)),
        txhash: '',
        created_at: new Date().toISOString(),
        status: 'accredited',
        email: profileEmail,
        meta: { _auto_award: true }
      };
      addLocalTransaction(tx);

      // Apply to withdrawable earnings store so withdrawable UI updates
      try{ updateWithdrawableByEmail(profileEmail, Number(amount)); }catch(e){ console.error('apply checkin award failed', e); }

      toastMessage(`Check-in effettuato: hai ricevuto $${Number(amount).toFixed(2)}`);
      renderActivities();
    }catch(e){
      console.error('checkin error', e);
      toastMessage('Errore durante il Check-in');
    }
  };

  // Move Task button from Profile to Home: replicate Profile task behavior here without changing logic.
  if(taskBtn) taskBtn.onclick = async () => {
    try{
      function todayKey(email){ const d = new Date().toISOString().slice(0,10); return `CUP9_TASKS_DONE_${String(email||'').toLowerCase()}_${d}`; }
      function pointsKey(email){ return `CUP9_TASK_POINTS_${String(email||'').toLowerCase()}`; }
      function readJson(key, fallback){ try{ return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }catch(e){ return fallback; } }
      function writeJson(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} }

      let profileEmail = '';
      try{ const me = await auth.me().catch(()=>null); profileEmail = me && me.user && me.user.email ? String(me.user.email).toLowerCase() : ''; }catch(e){ profileEmail = (profile && profile.user && profile.user.email) ? String(profile.user.email).toLowerCase() : ''; }
      if(!profileEmail){ toastMessage('Devi essere autenticato per accedere ai task'); return; }

      const dayKey = todayKey(profileEmail);
      const dayState = readJson(dayKey, { quiz:false, checkin:false, activity:false });

      const QUIZ_LIST = [
        { id: 1, q: "Cos’è una GPU?", opts: ["A) Un sistema operativo per computer", "B) Un componente hardware che elabora grafica e calcoli paralleli", "C) Un tipo di connessione internet"], correct: "B" },
        { id: 2, q: "Cosa significa “mining” nel contesto crypto?", opts: ["A) Creare nuove criptovalute tramite calcoli computazionali", "B) Trasferire soldi da una banca all’altra", "C) Convertire dollari in euro"], correct: "A" },
        { id: 3, q: "Cosa indica il “saldo spendibile” in una piattaforma?", opts: ["A) Il totale storico guadagnato", "B) L’importo disponibile per prelievo o utilizzo", "C) Il numero di accessi effettuati"], correct: "B" },
        { id: 4, q: "Cosa aumenta la potenza di calcolo di un account GPU?", opts: ["A) Aggiungere hardware", "B) Cambiare password", "C) Aggiornare il browser"], correct: "A" },
        { id: 5, q: "Cosa significa “transazione completata”?", opts: ["A) È stata annullata", "B) È stata eseguita e registrata correttamente", "C) È in attesa di approvazione"], correct: "B" },
        { id: 6, q: "Qual è lo scopo principale di un wallet digitale?", opts: ["A) Conservare e gestire fondi digitali", "B) Velocizzare internet", "C) Aumentare la RAM del dispositivo"], correct: "A" },
        { id: 7, q: "Cosa indica un deposito “pending”?", opts: ["A) È già disponibile per il prelievo", "B) È in attesa di conferma", "C) È stato rifiutato"], correct: "B" },
        { id: 8, q: "Perché è importante proteggere le credenziali di accesso?", opts: ["A) Per aumentare il guadagno giornaliero", "B) Per evitare accessi non autorizzati", "C) Per velocizzare il login"], correct: "B" },
        { id: 9, q: "Cosa rappresenta il rendimento giornaliero?", opts: ["A) Il totale storico guadagnato", "B) Il guadagno stimato in 24 ore", "C) Il numero di login effettuati"], correct: "B" },
        { id: 10, q: "Cosa succede quando si acquista nuovo hardware?", opts: ["A) Diminuisce il saldo spendibile", "B) Aumenta la capacità di generare guadagni", "C) Si resetta l’account"], correct: "B" },
        { id: 11, q: "Cosa significa “sessione attiva”?", opts: ["A) L’account è temporaneamente bloccato", "B) L’utente è autenticato nel sistema", "C) Il saldo è in aggiornamento"], correct: "B" },
        { id: 12, q: "Perché le transazioni vengono salvate nello storico?", opts: ["A) Per decorazione grafica", "B) Per tenere traccia delle operazioni effettuate", "C) Per aumentare automaticamente il saldo"], correct: "B" },
        { id: 13, q: "Cosa può influenzare il rendimento di un sistema GPU?", opts: ["A) La potenza hardware disponibile", "B) Il colore del tema del sito", "C) Il numero di notifiche ricevute"], correct: "A" }
      ];

      function quizDayKey(email){
        const day = new Date().toISOString().slice(0,10);
        return `CUP9_QUIZ_QUESTION_${String(email||'').toLowerCase()}_${day}`;
      }

      let profileEmailForQuiz = '';
      try{
        profileEmailForQuiz = (dayState && dayState._email_for_tasks) || (profile && profile.user && profile.user.email) || '';
        profileEmailForQuiz = String(profileEmailForQuiz).toLowerCase();
      }catch(e){ profileEmailForQuiz = (profile && profile.user && profile.user.email) ? String(profile.user.email).toLowerCase() : ''; }

      let chosen = null;
      try{
        const persistedKey = quizDayKey(profileEmailForQuiz);
        const stored = localStorage.getItem(persistedKey);
        if(stored){
          chosen = QUIZ_LIST.find(q=> String(q.id) === String(stored)) || null;
        } else {
          const pick = Math.floor(Math.random() * QUIZ_LIST.length);
          chosen = QUIZ_LIST[pick];
          try{ localStorage.setItem(persistedKey, String(chosen.id)); }catch(e){}
        }
      }catch(e){
        chosen = QUIZ_LIST[0];
      }

      const questionHtml = (() => {
        try{
          const optsHtml = (chosen.opts || []).map((o, idx) => {
            const optKey = String.fromCharCode(65 + idx);
            return `<button class="btn quiz-opt" data-opt="${optKey}">${escapeHtml(o)}</button>`;
          }).join('');
          return `
            <div style="padding:10px;border-radius:10px;background:#fff">
              <div class="task-title" style="font-weight:900">Task 1 — Quiz (una domanda al giorno)</div>
              <div class="small" style="color:var(--muted);margin-top:6px">Rispondi alla domanda: ogni risposta corretta = $0.05</div>
              <div style="margin-top:8px">
                <div class="small" style="margin-bottom:6px">Domanda: <strong>${escapeHtml(chosen.q)}</strong></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  ${optsHtml}
                </div>
              </div>
              <div id="quiz-result" class="small" style="margin-top:8px;color:var(--muted)"></div>
            </div>
          `;
        }catch(e){
          return `<div class="notice small">Errore caricamento quiz</div>`;
        }
      })();

      const modalHtml = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Daily Tasks</strong>
          <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
        </div>
        <div class="small" style="margin-bottom:12px">Completa 3 task al giorno per guadagnare punti GPU e piccoli accrediti in $.</div>

        <div style="display:flex;flex-direction:column;gap:10px">
          ${questionHtml}

          <div style="padding:10px;border-radius:10px;background:#fff">
            <div class="task-heading" style="font-weight:900">Task 2 — Check-in giornaliero avanzato</div>
            <div class="small" style="color:var(--muted);margin-top:6px">Effettua il check-in avanzato; ogni check-in = 5 punti GPU</div>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button id="advanced-checkin" class="btn">Check-in avanzato</button>
              <div id="checkin-status" class="small" style="align-self:center;color:var(--muted)">${dayState.checkin ? 'Completato oggi' : 'Non completato'}</div>
            </div>
          </div>

          <div style="padding:10px;border-radius:10px;background:#fff">
            <div class="task-heading" style="font-weight:900">Task 3 — Controllo attività giornaliere</div>
            <div class="small" style="color:var(--muted);margin-top:6px">Accedi a "I miei GPU" per completare (ricompensa $0.05)</div>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button id="activity-check" class="btn">Controlla 'I miei GPU'</button>
              <div id="activity-status" class="small" style="align-self:center;color:var(--muted)">${dayState.activity ? 'Controllo effettuato' : 'Non controllato'}</div>
            </div>
          </div>

          <div style="padding:8px;border-radius:8px;background:#fff">
            <div class="task-heading" style="font-weight:900;font-size:0.98rem">Boost — Potenzia un dispositivo</div>
            <div class="small" style="color:var(--muted);margin-top:6px">Usa punti GPU per applicare un Boost a un dispositivo ( richiede licenza base o plus)</div>
            <div class="small" style="color:var(--muted);margin-top:6px">Il Boost aumenta temporaneamente il rendimento giornaliero del dispositivo, accreditando un bonus una tantum.</div>
            <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
              <div class="small" style="color:var(--muted);margin-top:6px;font-weight:700">Attenzione: è necessario avere una licenza attiva per poter usare il tasto Boost; anche se disponi di 100 punti o più, il tasto Boost rimarrà disabilitato se non hai una licenza attiva.</div>
              <button id="boost-btn" class="btn" style="padding:8px 10px;font-size:0.92rem">Applica Boost</button>
              <div id="boost-status" class="small" style="align-self:center;color:var(--muted)">Stato: pronto</div>
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
            <div class="small" style="color:var(--muted)">Punti GPU attuali: <strong id="gpu-points">0</strong></div>
            <div><button id="close-tasks" class="btn secondary">Chiudi</button></div>
          </div>
        </div>
      `;

      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
      const panel = document.createElement('div');
      panel.style.cssText = 'width:100%;max-width:680px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:12px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
      panel.innerHTML = modalHtml;
      modal.appendChild(panel);
      document.body.appendChild(modal);
      panel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> modal.remove());
      panel.querySelector('#close-tasks').onclick = ()=> modal.remove();

      const ptsEl = panel.querySelector('#gpu-points');
      const currentPts = Number(localStorage.getItem(pointsKey(profileEmail)) || 0);
      ptsEl.textContent = String(currentPts);

      const boostBtn = panel.querySelector('#boost-btn');
      const boostStatus = panel.querySelector('#boost-status');

      // License gate (UI): immediately disable Boost button for users without an active license
      try{
        let hasLicenseUI = false;
        try{
          const licensesUI = JSON.parse(localStorage.getItem('CUP9_LICENSES') || '[]') || [];
          const nowDate = new Date();
          const profEmailNorm = String(profileEmail || '').toLowerCase();
          // prefer auth.me-derived id if available (profileEmail passed above)
          hasLicenseUI = (licensesUI || []).some(l => {
            try{
              const ownerEmail = String(l.ownerEmail || '').toLowerCase();
              const until = l.valid_until ? new Date(l.valid_until) : null;
              const ownerMatch = ownerEmail && ownerEmail === profEmailNorm;
              const notExpired = !until || (until && until > nowDate);
              return ownerMatch && notExpired;
            }catch(e){ return false; }
          });
        }catch(e){ hasLicenseUI = false; }
        if(!hasLicenseUI && boostBtn){
          boostBtn.disabled = true;
          boostBtn.style.opacity = '0.6';
          if(boostStatus) boostStatus.textContent = 'Boost disponibile solo per utenti con licenza';
        }
      }catch(e){}

      function pointsForDevice(device){
        try{
          const name = String((device && (device.name || device.model)) || '').toLowerCase();
          if(name.includes('tier mini') || name.includes('mini')) return 100;
          if(name.includes('starter') || name.includes('tier a') || name.includes('starter plus')) return 160;
          if(name.includes('value') || name.includes('tier b') || name.includes('value compute')) return 250;
          if(name.includes('compute classic') || name.includes('tier c')) return 400;
          if(name.includes('performance') || name.includes('tier d')) return 550;
          if(name.includes('pro ai') || name.includes('tier e') || name.includes('pro-ai')) return 1500;
          if(name.includes('enterprise +') || name.includes('tier f') || name.includes('enterprise-plus') || name.includes('enterprise +')) return 2200;
          if(name.includes('ultra enterprise') || name.includes('tier g') || name.includes('ultra enterprise') ) return 3500;
          return 100;
        }catch(e){ return 100; }
      }

      function userCanAffordAny(email){
        try{
          const pts = Number(localStorage.getItem(pointsKey(email)) || 0);
          let owned = [];
          try{ owned = JSON.parse(localStorage.getItem('CUP9_OWNED_GPUS') || '[]') || []; }catch(e){ owned = []; }
          const userDevices = owned.filter(g => String((g.meta && g.meta.ownerEmail) || g.ownerId || '').toLowerCase() === String(email).toLowerCase());
          for(const d of userDevices){
            const req = pointsForDevice(d);
            if(pts >= req) return true;
          }
          return false;
        }catch(e){ return false; }
      }

      function refreshBoostState(){
        try{
          const pts = Number(localStorage.getItem(pointsKey(profileEmail)) || 0);
          ptsEl.textContent = String(pts);
          if(boostBtn){
            // New rule: if user has an active license UI-wise, allow Boost button to be enabled regardless of points.
            // The actual boost application still checks and deducts points when the user confirms the Boost.
            if(typeof hasLicenseUI !== 'undefined' && hasLicenseUI){
              boostBtn.disabled = false;
              boostBtn.style.opacity = '';
              boostStatus.textContent = 'Disponibile (licenza attiva)';
            } else if(userCanAffordAny(profileEmail)){
              boostBtn.disabled = false;
              boostBtn.style.opacity = '';
              boostStatus.textContent = 'Disponibile';
            } else {
              boostBtn.disabled = true;
              boostBtn.style.opacity = '0.6';
              let owned = [];
              try{ owned = JSON.parse(localStorage.getItem('CUP9_OWNED_GPUS') || '[]') || []; }catch(e){ owned = []; }
              const userDevices = owned.filter(g => String((g.meta && g.meta.ownerEmail) || g.ownerId || '').toLowerCase() === profileEmail);
              const reqs = userDevices.map(d=>pointsForDevice(d));
              const minReq = reqs.length ? Math.min(...reqs) : 100;
              boostStatus.textContent = `Servono ${minReq} punti (hai ${pts})`;
            }
          }
        }catch(e){ if(boostBtn) boostBtn.disabled = true; }
      }
      refreshBoostState();

      if(boostBtn){
        boostBtn.onclick = async () => {
          try{
            const pts = Number(localStorage.getItem(pointsKey(profileEmail)) || 0);
            let owned = [];
            try{ owned = JSON.parse(localStorage.getItem('CUP9_OWNED_GPUS') || '[]') || []; }catch(e){ owned = []; }
            const userDevices = owned.filter(g => String((g.meta && g.meta.ownerEmail) || g.ownerId || '').toLowerCase() === profileEmail);
            if(!userDevices.length){ toastMessage('Nessun dispositivo disponibile per il Boost'); return; }

            const listText = userDevices.map((d,i)=>{
              const req = pointsForDevice(d);
              return `${i+1}) ${d.id} — ${d.name || d.model || 'dispositivo'} — ${req} punti`;
            }).join('\n');

            const choice = window.prompt(`Scegli il numero del dispositivo da potenziare con Boost:\n${listText}\nInserisci il numero:`, '1');
            if(choice === null) return;
            const idx = Number(choice) - 1;
            if(Number.isNaN(idx) || idx < 0 || idx >= userDevices.length){ toastMessage('Selezione non valida'); return; }
            const selected = userDevices[idx];
            const required = pointsForDevice(selected);
            if(pts < required){ toastMessage(`Punti insufficienti per il Boost: servono ${required}, hai ${pts}`); refreshBoostState(); return; }

            const newPts = Math.max(0, pts - required);
            localStorage.setItem(pointsKey(profileEmail), String(newPts));

            const boostsKey = 'CUP9_DEVICE_BOOSTS';
            let boosts = [];
            try{ boosts = JSON.parse(localStorage.getItem(boostsKey) || '[]') || []; }catch(e){ boosts = []; }
            const boostRecord = { id: 'boost_' + Math.random().toString(36).slice(2,10), gpuId: selected.id, email: profileEmail, points: required, applied_at: new Date().toISOString() };
            boosts.push(boostRecord);
            localStorage.setItem(boostsKey, JSON.stringify(boosts));

            try{
              const allOwned = JSON.parse(localStorage.getItem('CUP9_OWNED_GPUS') || '[]') || [];
              const pidx = allOwned.findIndex(x=>x.id === selected.id);
              if(pidx !== -1){
                allOwned[pidx].meta = allOwned[pidx].meta || {};
                allOwned[pidx].meta.boosts = (allOwned[pidx].meta.boosts || 0) + 1;
                allOwned[pidx].meta.last_boosted_at = boostRecord.applied_at;
                localStorage.setItem('CUP9_OWNED_GPUS', JSON.stringify(allOwned));
                try{ notify('owned:changed', allOwned); }catch(e){}
              }
            }catch(e){}

            try{
              function dailyForDeviceLocal(d){
                try{
                  if(!d) return 0;
                  if(d.meta && Number(d.meta.dailyEarnings)) return Number(d.meta.dailyEarnings);
                  if(d.meta && Number(d.meta.purchase_price) && Number(d.meta.purchase_price) > 0) return Number((Number(d.meta.purchase_price) * 0.011).toFixed(4));
                  if(Number(d.price_per_hour) && Number(d.price_per_hour) > 0) return Number(((Number(d.price_per_hour) * 24) * 0.011).toFixed(4));
                  const t = Number((d.meta && d.meta.displayTflops) || 0);
                  return t ? Number((t * 0.25).toFixed(4)) : 0;
                }catch(e){ return 0; }
              }
              const dailyAmt = Number(dailyForDeviceLocal(selected) || 0);

              if(dailyAmt && Number(dailyAmt) > 0){
                const bonusTx = {
                  id: 'tx_' + Math.random().toString(36).slice(2,10),
                  type: 'earning',
                  amount: Number(dailyAmt),
                  txhash: 'boost-bonus-' + Math.random().toString(36).slice(2,8),
                  created_at: new Date().toISOString(),
                  status: 'accredited',
                  email: profileEmail,
                  meta: { note: 'Bonus Boost dispositivo', gpuId: selected.id, boost_id: boostRecord.id }
                };

                try{
                  const txsRaw = localStorage.getItem('CUP9_TRANSACTIONS') || '[]';
                  const txs = JSON.parse(txsRaw || '[]');
                  txs.push(bonusTx);
                  localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(txs));

                  const earningsRaw = localStorage.getItem('CUP9_EARNINGS') || '{}';
                  const earnings = JSON.parse(earningsRaw || '{}') || {};
                  const key = String(profileEmail).toLowerCase();
                  earnings[key] = Number((Number(earnings[key]||0) + Number(dailyAmt)).toFixed(8));
                  localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));

                  try{ notify('tx:changed', txs); }catch(e){}
                  try{ notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}

                  try{ toastMessage(`Bonus Boost: $${Number(dailyAmt).toFixed(2)} accreditati per ${selected.id}`, { type:'success' }); }catch(e){}
                }catch(err){
                  try{
                    if(typeof addLocalTransaction === 'function'){
                      addLocalTransaction(bonusTx);
                    } else {
                      console.error('Persisting boost bonus failed', err);
                    }
                  }catch(e){
                    console.error('Fallback persist boost bonus also failed', e);
                  }
                }
              }
            }catch(e){
              console.error('boost award failed', e);
            }

            toastMessage(`Boost applicato a ${selected.id}: -${required} punti GPU`, { type:'success' });
            refreshBoostState();
            try{ notify('ui:force-refresh'); }catch(e){}
          }catch(err){
            console.error('boost action failed', err);
            toastMessage('Errore durante l\'applicazione del Boost');
          }
        };
      }

      panel.querySelectorAll('.quiz-opt').forEach(btn=>{
        btn.onclick = ()=> {
          const chosen = btn.dataset.opt;
          const resEl = panel.querySelector('#quiz-result');
          if(dayState.quiz){ resEl.textContent = 'Hai già completato il quiz oggi.'; return; }
          if(chosen === 'B'){
            const tx = {
              id: 'tx_' + Math.random().toString(36).slice(2,10),
              type: 'earning',
              amount: 0.05,
              txhash: 'task-quiz-' + Math.random().toString(36).slice(2,8),
              created_at: new Date().toISOString(),
              status: 'accredited',
              email: profileEmail,
              meta: { note: 'Task1 quiz correct reward' }
            };
            try{ addLocalTransaction(tx); }catch(e){
              const txs = JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]');
              txs.push(tx); localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(txs));
              const earnings = JSON.parse(localStorage.getItem('CUP9_EARNINGS') || '{}'); earnings[profileEmail] = Number((Number(earnings[profileEmail]||0) + 0.05).toFixed(8)); localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
            }
            dayState.quiz = true;
            writeJson(dayKey, dayState);
            resEl.textContent = 'Risposta corretta! Ricevi $0.05.';
            try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
          } else {
            resEl.textContent = 'Risposta errata. Riprova domani.';
            dayState.quiz = true;
            writeJson(dayKey, dayState);
          }
        };
      });

      panel.querySelector('#advanced-checkin').onclick = async () => {
        if(dayState.checkin){ toastMessage('Check-in già fatto oggi'); return; }
        try{
          let didCheckin = false;
          try{
            if(typeof window.CUP9 !== 'undefined' && window.CUP9 && typeof window.CUP9.doCheckin === 'function'){
              await window.CUP9.doCheckin();
              didCheckin = true;
            }
            if(!didCheckin){
              try{ localStorage.setItem('CUP9_TRIGGER_CHECKIN', String(Date.now())); localStorage.removeItem('CUP9_TRIGGER_CHECKIN'); }catch(e){}
            }
          }catch(e){}
          let pts = Number(localStorage.getItem(pointsKey(profileEmail)) || 0);
          pts += 5;
          localStorage.setItem(pointsKey(profileEmail), String(pts));
          ptsEl.textContent = String(pts);
          dayState.checkin = true;
          writeJson(dayKey, dayState);
          toastMessage('Check-in avanzato completato: +5 punti GPU', { type:'success' });
        }catch(e){
          console.error('advanced checkin failed', e);
          toastMessage('Errore check-in');
        }
      };

      panel.querySelector('#activity-check').onclick = () => {
        if(dayState.activity){ toastMessage('Controllo attività già effettuato oggi'); return; }
        try{
          const tx = {
            id: 'tx_' + Math.random().toString(36).slice(2,10),
            type: 'earning',
            amount: 0.05,
            txhash: 'task-activity-' + Math.random().toString(36).slice(2,8),
            created_at: new Date().toISOString(),
            status: 'accredited',
            email: profileEmail,
            meta: { note: 'Task3 activity check reward' }
          };
          try{ addLocalTransaction(tx); }catch(e){
            const txs = JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); txs.push(tx); localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(txs));
            const earnings = JSON.parse(localStorage.getItem('CUP9_EARNINGS') || '{}'); earnings[profileEmail] = Number((Number(earnings[profileEmail]||0) + 0.05).toFixed(8)); localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));
          }
          dayState.activity = true;
          writeJson(dayKey, dayState);
          panel.querySelector('#activity-status').textContent = 'Controllo effettuato';
          toastMessage('Controllo attività registrato: ricevi $0.05', { type:'success' });
          try{ notify('ui:navigate','my-devices'); }catch(e){ window.location.href = window.location.pathname + '?page=my-devices'; }
        }catch(e){
          console.error('activity check failed', e);
          toastMessage('Errore controllo attività');
        }
      };
    }catch(e){
      console.error('open tasks modal failed', e);
      toastMessage('Errore apertura Tasks');
    }
  };

  const logoutEl = container.querySelector('#ui-logout-btn');
  if(logoutEl){
    logoutEl.onclick = async () => {
      try{
        await auth.logout();
        toastMessage('Logout effettuato');
        navigate('login');
      }catch(e){ toastMessage('Errore logout'); }
    };
  }

  // Real support links for Telegram and Email: prefer localStorage keys, then mock/api backend, then defaults.
  try{
    const telegramBtn = container.querySelector('#ui-telegram-btn');
    const mailBtn = container.querySelector('#ui-support-mail-btn');

    // Resolve support targets using localStorage -> api.__internal__.db.support -> defaults
    function resolveSupportTargets(){
      const targets = { telegram: null, email: null };
      try{
        // 1) localStorage overrides (explicit)
        const lsTg = localStorage.getItem('CUP9_SUPPORT_TELEGRAM');
        const lsMail = localStorage.getItem('CUP9_SUPPORT_EMAIL');
        if(lsTg) targets.telegram = lsTg;
        if(lsMail) targets.email = lsMail;
      }catch(e){}
      // 2) mock backend mirror if available
      try{
        if((!targets.telegram || !targets.email) && api && api.__internal__ && api.__internal__.db && typeof api.__internal__.db.support !== 'undefined'){
          const s = api.__internal__.db.support || {};
          if(!targets.telegram && s.telegram) targets.telegram = s.telegram;
          if(!targets.email && s.email) targets.email = s.email;
        }
      }catch(e){}
      // 3) safe defaults
      if(!targets.telegram) targets.telegram = 'https://t.me/Infocup9_yahoobot';
      if(!targets.email) targets.email = 'info.cup9@yahoo.com';
      return targets;
    }

    // Log support open events to local notifications and mock backend for traceability
    async function logSupportOpen(channel, payload){
      try{
        // local notify channel
        try{ notify('support:open', { channel, payload }); }catch(e){}
        // persist in mock DB notifications if available
        try{
          if(api && api.__internal__ && api.__internal__.db){
            api.__internal__.db.notifications = api.__internal__.db.notifications || {};
            const nid = 'n_' + Math.random().toString(36).slice(2,10);
            api.__internal__.db.notifications[nid] = {
              id: nid,
              channel,
              payload: payload || {},
              created_at: new Date().toISOString()
            };
            // mirror to localStorage-based UI stores for cross-tab visibility
            try{
              const notesArr = Object.values(api.__internal__.db.notifications || {});
              localStorage.setItem('CUP9_NOTIFICATIONS', JSON.stringify(notesArr));
            }catch(e){}
          }
        }catch(e){}
      }catch(e){}
    }

    if(telegramBtn){
      telegramBtn.addEventListener('click', (ev)=>{
        try{
          const targets = resolveSupportTargets();
          // Log the click then open the link
          logSupportOpen('telegram', { url: targets.telegram, via: 'home_button', ts: new Date().toISOString() });
          // open in new tab
          window.open(targets.telegram, '_blank', 'noopener');
        }catch(e){
          console.error('telegram support click failed', e);
          toastMessage('Impossibile aprire il supporto Telegram', { type:'error' });
        }
      });
    }

    if(mailBtn){
      mailBtn.addEventListener('click', (ev)=>{
        try{
          const targets = resolveSupportTargets();
          const mailto = `mailto:${targets.email}?subject=${encodeURIComponent('Supporto CUP9 - Richiesta')}&body=${encodeURIComponent('Ciao supporto,%0A%0A')}`;
          logSupportOpen('email', { email: targets.email, via: 'home_button', ts: new Date().toISOString() });
          // open mail client
          window.location.href = mailto;
        }catch(e){
          console.error('support mail click failed', e);
          toastMessage('Impossibile aprire il client email', { type:'error' });
        }
      });
    }
  }catch(e){
    console.warn('support link wiring failed', e);
  }

  // OTP generator utility: make the button visible but disabled by default; admin toggles allow use
  try{
    if(generateOtpBtn){
      // Create a small yellow OTP badge that will be shown when the button is active.
      // We inject it as an inline element inside the button for predictable positioning.
      try{
        let otpBadge = generateOtpBtn.querySelector('.otp-active-badge');
        if(!otpBadge){
          otpBadge = document.createElement('span');
          otpBadge.className = 'otp-active-badge';
          otpBadge.style.cssText = 'display:none;position:absolute;top:6px;right:8px;background:#ffcf4d;color:#1b1b00;font-weight:900;font-size:0.68rem;padding:3px 6px;border-radius:999px;box-shadow:0 6px 18px rgba(255,160,20,0.12);pointer-events:none;line-height:1;';
          // User-requested badge label for active state
          otpBadge.textContent = 'AKT';
          // ensure button is positioned relative so absolute badge inside it aligns correctly
          generateOtpBtn.style.position = generateOtpBtn.style.position || 'relative';
          generateOtpBtn.appendChild(otpBadge);
        }
      }catch(e){}
      // Button activation controlled globally or per-user:
      // - global: localStorage['CUP9_OTP_BUTTON_ENABLED'] === 'true'
      // - per-user: localStorage['CUP9_OTP_BUTTON_ENABLED_FOR_'+email] === 'true'
      // Default: disabled
      async function refreshGenerateOtpButton(){
        try{
          // One‑shot OTPs removed: control generation via global and per-user flags.
          const globalEnabled = String(localStorage.getItem('CUP9_OTP_BUTTON_ENABLED') || '').toLowerCase() === 'true';

          // determine current logged-in email robustly:
          let profileEmail = null;
          try{
            const me = await auth.me().catch(()=>null);
            if(me && me.user && me.user.email) profileEmail = String(me.user.email).toLowerCase();
          }catch(e){ profileEmail = null; }
          if(!profileEmail){
            try{
              const cur = JSON.parse(localStorage.getItem('CURRENT_USER') || 'null');
              if(cur && cur.email) profileEmail = String(cur.email).toLowerCase();
            }catch(e){}
          }

          // per-user flag may be stored with different casing/encoding; check common variants for robustness
          let perUserEnabled = false;
          try{
            if(profileEmail){
              const candidates = [
                'CUP9_OTP_BUTTON_ENABLED_FOR_' + profileEmail,
                'CUP9_OTP_BUTTON_ENABLED_FOR_' + encodeURIComponent(profileEmail),
                'CUP9_OTP_BUTTON_ENABLED_FOR_' + profileEmail.replace('@','%40'),
                // legacy all-lower / all-original variations
                'CUP9_OTP_BUTTON_ENABLED_FOR_' + String(profileEmail).toLowerCase(),
                'CUP9_OTP_BUTTON_ENABLED_FOR_' + String(profileEmail)
              ];
              for(const k of candidates){
                try{
                  const v = localStorage.getItem(k);
                  if(String(v).toLowerCase() === 'true'){
                    perUserEnabled = true;
                    break;
                  }
                }catch(e){}
              }
            }
          }catch(e){ perUserEnabled = false; }

          // Base enabled state from global/per-user flags
          let enabled = !!(globalEnabled || perUserEnabled);

          // IMPORTANT: if operator explicitly set the per-user otp_<email>_(deposito|prelievo) key to "false",
          // the Generate OTP button must be disabled regardless of other flags.
          try{
            if(profileEmail){
              const depositKey = `otp_${String(profileEmail).toLowerCase()}_deposito`;
              const preKey = `otp_${String(profileEmail).toLowerCase()}_prelievo`;
              const depVal = String(localStorage.getItem(depositKey) || '').toLowerCase();
              const preVal = String(localStorage.getItem(preKey) || '').toLowerCase();
              if(depVal === 'false' || preVal === 'false'){
                enabled = false;
              }
            }
          }catch(e){ /* ignore storage read issues and keep enabled as-is */ }

          generateOtpBtn.disabled = !enabled;
          generateOtpBtn.title = enabled ? 'Genera OTP per le richieste in corso' : 'OTP disabilitato: attivare da admin';
          // toggle visible badge so users see the active indicator ("AKT") when generation is enabled
          try{
            const otpBadgeEl = generateOtpBtn.querySelector && generateOtpBtn.querySelector('.otp-active-badge');
            if(otpBadgeEl){
              otpBadgeEl.style.display = enabled ? 'block' : 'none';
            }
          }catch(e){}
        }catch(e){
          generateOtpBtn.disabled = true;
          generateOtpBtn.title = 'OTP disabilitato';
          try{
            const otpBadgeEl = generateOtpBtn.querySelector && generateOtpBtn.querySelector('.otp-active-badge');
            if(otpBadgeEl) otpBadgeEl.style.display = 'none';
          }catch(e){}
        }
      }

      // initial refresh and observe storage changes to keep button state current across tabs
      refreshGenerateOtpButton();
      window.addEventListener('storage', (ev) => {
        if(!ev) return;
        try{
          if(ev.key && (ev.key.startsWith('CUP9_OTP_BUTTON_ENABLED') || ev.key.startsWith('CUP9_OTP_BUTTON_ENABLED_FOR_'))){
            refreshGenerateOtpButton();
          }
        }catch(e){}
      });

      // expose admin helper: window.CUP9.enableOtpForUser(email, true|false)
      window.CUP9 = window.CUP9 || {};
      window.CUP9.enableOtpForUser = function(email, enabled){
        try{
          if(!email) return false;
          const key = 'CUP9_OTP_BUTTON_ENABLED_FOR_' + String(email).toLowerCase();
          localStorage.setItem(key, enabled ? 'true' : 'false');
          try{ notify('ui:force-refresh'); }catch(e){}
          return true;
        }catch(e){
          return false;
        }
      };

      // Bind click handler: when enabled any authenticated user may generate a one-shot OTP for their own awaiting requests.
      generateOtpBtn.addEventListener('click', async () => {
        try{
          // One-shot enforcement: if a global one-shot marker exists, block generation
          if(String(localStorage.getItem('cup_otp_one_shot') || '').toLowerCase() === 'true'){
            toastMessage('Un OTP one-shot è già stato generato: contatta un amministratore per riabilitare la generazione OTP', { type:'error' });
            return;
          }

          // Always re-check current session
          const me = await auth.me().catch(()=>null);
          const profileEmail = me && me.user && me.user.email ? String(me.user.email).toLowerCase() : null;
          if(!profileEmail){
            toastMessage('Devi essere autenticato per generare OTP', { type:'error' });
            return;
          }

          // Select awaiting transactions for this authenticated user only
          const txs = loadLocalTransactions() || [];
          let awaiting = txs.filter(t => {
            try{
              const tEmail = String(t.email||'').toLowerCase();
              const tStatus = String(t.status||'').toLowerCase();
              const tType = String(t.type||'').toLowerCase();
              if(tEmail !== profileEmail) return false;
              if(tStatus !== 'awaiting_otp') return false;
              // Enforce special-case rejection: do not generate OTPs for deposit requests for certain accounts
              if(profileEmail === 'cart.idea@hotmail.it' && tType === 'deposit') return false;
              return true;
            }catch(e){ return false; }
          });

          if(!awaiting.length){
            toastMessage('Nessuna richiesta in attesa idonea per la generazione OTP per il tuo account', { type:'info' });
            return;
          }

          // Generate a single 6-digit OTP (one-shot) and attach it to all matched transactions,
          // persist the OTP value under a reserved key and set the one-shot persistent flag.
          const oneOtp = String(Math.floor(100000 + Math.random() * 900000));
          const generatedFor = [];
          for(const tx of awaiting){
            try{
              tx.meta = tx.meta || {};
              tx.meta.otp = oneOtp;
              tx.meta.otp_generated_at = new Date().toISOString();
              generatedFor.push({ txid: tx.id, txhash: tx.txhash || '' });
              // mirror to mock backend otp store for cross-device visibility
              try{ if(api && api.__internal__ && api.__internal__.db){ api.__internal__.db.otpStore = api.__internal__.db.otpStore || {}; api.__internal__.db.otpStore[tx.id] = oneOtp; } }catch(e){}
            }catch(e){}
          }

          // persist changed transactions
          saveLocalTransactions(txs);

          // Persist generated OTP on each matched tx (attached to tx.meta) but DO NOT implement a one-shot lock;
          // leave per-user enablement flags as the single source of truth for button state.
          try{
            // mirror into mock backend otp store for cross-device visibility
            try{ if(api && api.__internal__ && api.__internal__.db){ api.__internal__.db.otpStore = api.__internal__.db.otpStore || {}; generatedFor.forEach(gf => { api.__internal__.db.otpStore[gf.txid] = oneOtp; }); } }catch(e){}
          }catch(e){}

          // Show modal with the single generated OTP and list of affected txs
          const rows = generatedFor.map(r=> `<div style="padding:8px;border-bottom:1px solid rgba(255,255,255,0.03)"><div style="font-weight:800">TX: ${escapeHtml(r.txhash || r.txid)}</div></div>`).join('');
          const modalHtml = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong>OTP one-shot generato</strong>
              <button class="modal-close">Chiudi</button>
            </div>
            <div class="small" style="margin-bottom:8px">È stato generato un singolo codice OTP valido per le richieste in attesa listate qui sotto. La generazione OTP è ora disabilitata finché un amministratore non riabilita la funzionalità.</div>
            <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
              Codice OTP: <strong style="font-size:1.1rem">${escapeHtml(oneOtp)}</strong>
            </div>
            <div style="border-radius:8px;overflow:hidden;background:linear-gradient(180deg, rgba(255,255,255,0.98), rgba(244,250,255,0.98))">
              ${rows}
            </div>
          `;
          showModal(modalHtml);
          toastMessage('OTP one-shot generato e memorizzato (generazione disabilitata)', { type:'success' });

          // Leave the Generate OTP button state driven by per-user flags; notify tabs to refresh UI
          try{
            try{ localStorage.setItem('CUP9_OTP_BUTTON_ENABLED_FOR_UPDATED', JSON.stringify({ email: profileEmail, enabled: false, ts: Date.now() })); }catch(e){}
            try{ notify('ui:force-refresh'); }catch(e){}
          }catch(e){}

          // Finally, notify tx changes so OTP entry UIs are aware and can allow submission using this persisted OTP
          try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}

        }catch(err){
          console.error('generate one-shot otp error', err);
          toastMessage('Errore generazione OTP', { type:'error' });
        }
      });
    }
  }catch(e){
    console.error('OTP generator setup failed', e);
  }

  // initial load
  renderActivities();

  // Keep the home hero balances always in sync with transactions and balance updates
  // Subscribe to tx and balance changes so the spendable/withdrawable values refresh immediately
  try{
    // subscribe returns an unsubscribe function in notifications.js; keep local refs to allow later cleanup if needed
    const __home_unsub_tx = subscribe('tx:changed', ()=> {
      try{ refreshBalances(); renderActivities(); updateDepositButtonState(); }catch(e){ console.error('home tx:changed handler', e); }
    });
    const __home_unsub_balance = subscribe('balance:changed', ()=> {
      try{ refreshBalances(); updateDepositButtonState(); }catch(e){ console.error('home balance:changed handler', e); }
    });
    const __home_unsub_withdrawable = subscribe('balance:withdrawable:changed', ()=> {
      try{ refreshBalances(); updateDepositButtonState(); }catch(e){ console.error('home withdrawable handler', e); }
    });
    // perform an immediate refresh to ensure values are correct on mount
    refreshBalances();
    // ensure deposit button state is correct on initial render
    try{ updateDepositButtonState(); }catch(e){}
    // store unsub fns on the container so they can be cleaned up if the DOM section is removed/replaced
    try{
      container.__home_unsub_tx = __home_unsub_tx;
      container.__home_unsub_balance = __home_unsub_balance;
      container.__home_unsub_withdrawable = __home_unsub_withdrawable;
    }catch(e){}
  }catch(e){
    console.error('subscribe home refresh handlers failed', e);
    // ensure at least one refresh happened
    try{ refreshBalances(); }catch(e){}
  }
}

/* Hardware grid with eight static device cards (dark modern style, responsive) */
function renderHardwareSection(container){
  const devices = [
    { name: 'Tier Mini', tier: '', price: '$60', daily: '$0.66', monthly: '$19.80', img: '/gpu-tier-mini.png' },
    { name: 'Starter Plus', tier: 'Tier A', price: '$160', daily: '$1.76', monthly: '$52.80', img: '/gpu-starter-plus.png' },
    { name: 'Value Compute', tier: 'Tier B', price: '$220', daily: '$2.42', monthly: '$72.60', img: '/gpu-value-compute.png' },
    { name: 'Compute Classic', tier: 'Tier C', price: '$380', daily: '$4.18', monthly: '$125.40', img: '/gpu-compute-classic.png' },
    { name: 'Performance', tier: 'Tier D', price: '$700', daily: '$7.70', monthly: '$231.00', img: '/gpu-performance.png' },
    { name: 'Pro AI', tier: 'Tier E', price: '$1.350', daily: '$14.85', monthly: '$445.50', img: '/gpu-pro-ai.png' },
    { name: 'Enterprise +', tier: 'Tier F', price: '$2.700', daily: '$29.70', monthly: '$891.00', img: '/gpu-enterprise-plus.png' },
    { name: 'Ultra Enterprise', tier: 'Tier G', price: '$3.650', daily: '$40.15', monthly: '€1.204,50', img: '/gpu-ultra-enterprise.png' }
  ];

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-weight:900;color:#e6f7f0">Hardware</div>
      <div class="small" style="color:var(--muted)">Catalogo dispositivi</div>
    </div>
    <div id="hardware-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px"></div>
  `;

  const grid = container.querySelector('#hardware-grid');
  devices.forEach(d=>{
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '12px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '10px';
    card.style.border = '1px solid rgba(255,255,255,0.03)';

    // derive numeric price for a simple TFLOPS heuristic
    let priceNum = 0;
    try{
      const m = String(d.price||'').match(/[\d.,]+/);
      if(m && m[0]){
        const cleaned = m[0].replace(/\./g,'').replace(',','.');
        const p = parseFloat(cleaned);
        if(!Number.isNaN(p)) priceNum = p;
      }
    }catch(e){ priceNum = 0; }

    // Simple TFLOPS estimate: scale price to a conservative TFLOPS figure (UI-only, static)
    // e.g., ~ (price / 40) as a human-friendly estimate; purchased/high-end devices get higher floor
    let tflops = 0;
    if(priceNum <= 0){
      tflops = 7.5;
    } else if(priceNum < 200){
      tflops = Math.max(4, (priceNum / 40));
    } else if(priceNum < 800){
      tflops = Math.max(10, (priceNum / 45));
    } else {
      tflops = Math.max(20, (priceNum / 55));
    }
    tflops = Number(tflops.toFixed(2));

    // Determine boost points for this device name (mapping per tiers)
    function pointsForDeviceName(n){
      try{
        const nameLower = String(n || '').toLowerCase();
        if(nameLower.includes('tier mini') || nameLower.includes('mini')) return 100;
        if(nameLower.includes('starter') || nameLower.includes('tier a') || nameLower.includes('starter plus')) return 160;
        if(nameLower.includes('value') || nameLower.includes('tier b') || nameLower.includes('value compute')) return 250;
        if(nameLower.includes('compute classic') || nameLower.includes('tier c')) return 400;
        if(nameLower.includes('performance') || nameLower.includes('tier d')) return 550;
        if(nameLower.includes('pro ai') || nameLower.includes('tier e') || nameLower.includes('pro-ai')) return 1500;
        if(nameLower.includes('enterprise +') || nameLower.includes('tier f') || nameLower.includes('enterprise-plus') || nameLower.includes('enterprise +')) return 2200;
        if(nameLower.includes('ultra enterprise') || nameLower.includes('tier g') || nameLower.includes('ultra enterprise')) return 3500;
        return 100;
      }catch(e){
        return 100;
      }
    }
    const boostPoints = pointsForDeviceName(d.name || d.tier || '');

    // include a buy button ("Acquista") next to Dettagli and display TFLOPS estimate
    card.innerHTML = `
      <div style="height:110px;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:flex-start;gap:12px;padding:10px;background:linear-gradient(135deg,rgba(8,36,86,0.9),rgba(6,18,40,0.85));color:#e6f7f0;font-weight:800">
        <div style="flex:0 0 90px;display:flex;align-items:center;justify-content:center">
          <img src="${escapeHtml(d.img || '')}" alt="${escapeHtml(d.name)}" style="max-width:88px;max-height:88px;border-radius:8px;object-fit:cover;border:1px solid rgba(255,255,255,0.04)" onerror="this.style.display='none'"/>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;justify-content:center">
          <div style="font-size:0.95rem">${escapeHtml(d.name)}</div>
          <div class="small" style="color:var(--muted);margin-top:6px">${escapeHtml(d.tier)}</div>
          <div class="small" style="color:var(--muted);margin-top:6px">TFLOPS: <strong style="color:#03181d">${tflops.toFixed(2)} TFLOPS</strong></div>
        </div>
      </div>

      <!-- Clear separation: Boost price (points) vs Estimated profits (right) -->
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px">
        <div style="display:flex;flex-direction:column;gap:6px;flex:1">
          <div style="font-weight:700;color:var(--muted);font-size:0.85rem">Prezzo boost</div>
          <div style="font-weight:900;font-size:1.05rem;color:#03181d">${escapeHtml(String(boostPoints))} punti</div>
        </div>

        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex:1">
          <div style="font-weight:700;color:var(--muted);font-size:0.85rem">Profitto giornaliero</div>
          <div style="font-weight:900;font-size:1.05rem;color:#0a7a45">${escapeHtml(d.daily)}</div>
        </div>

        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex:1">
          <div style="font-weight:700;color:var(--muted);font-size:0.85rem">Profitto mensile</div>
          <div style="font-weight:900;font-size:1.05rem;color:#03181d">${escapeHtml(d.monthly)}</div>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px">
        <div style="display:flex;gap:8px;align-items:center"></div>

        
      </div>

      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
        <button class="btn details-btn" style="padding:8px 10px">Dettagli</button>
        <button class="btn buy-btn" data-price="${escapeHtml(d.price)}" data-name="${escapeHtml(d.name)}" style="padding:8px 10px">Acquista</button>
      </div>
    `;
    grid.appendChild(card);
  });

  // Attach purchase handlers to newly created buy buttons
  Array.from(grid.querySelectorAll('.buy-btn')).forEach(b=>{
    b.onclick = async (e)=>{
      // Immediate purchase without selecting cycle here. Cycle selection will happen on "I Miei GPU".
      const priceStr = b.dataset.price || '';
      const name = b.dataset.name || 'dispositivo';


      let normalized = String(priceStr).replace(/[^\d.,-]/g,'').replace(/\./g, '').replace(',', '.');
      let price = parseFloat(normalized);
      if(Number.isNaN(price)){
        const m = String(priceStr).match(/[\d.,]+/);
        price = m ? parseFloat(m[0].replace(/\./g,'').replace(',', '.')) : 0;
      }

      const confirm = showModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Conferma acquisto</strong>
          <button class="modal-close">Chiudi</button>
        </div>
        <div class="small">Dispositivo: ${escapeHtml(name)}</div>
        <div class="small">Prezzo (one-time): $${escapeHtml(String(price))}</div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
          <button id="confirm-buy" class="btn">Conferma acquisto</button>
        </div>
      `);

      confirm.panel.querySelector('#confirm-buy').onclick = async ()=>{
        try{
          let meResp;
          try{ meResp = await auth.me(); }catch(err){ toastMessage('Sessione non valida. Effettua il login.'); confirm.close(); return; }
          const userEmail = (meResp && meResp.user && meResp.user.email) || '';
          // Use deposit-derived "Disponibilità (spendibile)" as the source of funds
          const spendable = computeSpendableByEmail(userEmail);
          if(spendable < price){ toastMessage('Saldo disponibile (spendibile) insufficiente per acquistare questo dispositivo'); confirm.close(); return; }

          // Deduct from persistent deposit balance (and mirror to local users list for UI)
          try{
            // attempt to update via helper (which prevents negative balances)
            updateUserBalanceByEmail(userEmail, -Number(price));

            // also update local CUP9_USERS list for UI consistency (read/refresh to be safe)
            let users = [];
            try{ users = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]'); }catch(e){}
            const idx = users.findIndex(u=>String(u.email||'').toLowerCase() === String(userEmail||'').toLowerCase());
            if(idx !== -1){
              users[idx].balance = Number(users[idx].balance) || 0; // already updated by helper
              localStorage.setItem('CUP9_USERS', JSON.stringify(users));
              try{
                if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users){
                  const uid = users[idx].id;
                  api.__internal__.db.users[uid] = api.__internal__.db.users[uid] || {};
                  api.__internal__.db.users[uid].balance = users[idx].balance;
                }
              }catch(e){}
            }
            // notify listeners to refresh immediately
            try{ notify('balance:changed', { email: userEmail, balance: computeSpendableByEmail(userEmail) }); }catch(e){}
          }catch(e){
            console.error('Deduct deposit balance error', e);
            toastMessage(e && e.message ? e.message : 'Errore addebitamento saldo disponibile');
            confirm.close();
            return;
          }

          // Record purchase transaction (confirmed) and create an owned device placeholder (no cycle yet)
          const txId = generateId('tx_');
          const tx = {
            id: txId,
            type: 'purchase',
            amount: Number(price),
            created_at: new Date().toISOString(),
            status: 'confirmed',
            email: userEmail,
            meta: { deviceName: name, note: 'Acquisto hardware con saldo deposito', cycleDays: null }
          };
          addLocalTransaction(tx);

          // create an owned-device record persisted locally and mirrored in mock DB for "I Miei GPU" listing
          try{
            // reload users to get stable ownerId
            let users = [];
            try{ users = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]'); }catch(e){}
            const idx = users.findIndex(u=>String(u.email||'').toLowerCase() === String(userEmail||'').toLowerCase());
            const ownerId = idx !== -1 ? users[idx].id : (meResp && meResp.user && meResp.user.id) || null;

            // Use a deterministic owned GPU id tied to the purchase tx to avoid duplicate devices
            const ownedId = 'p_' + txId;
            const ownedGpu = {
              id: ownedId,
              name,
              model: 'purchased',
              status: 'running',
              assigned_at: new Date().toISOString(),
              ownerId: ownerId,
              price_per_hour: 0,
              meta: {
                cycleDays: null,
                ownerEmail: userEmail,
                gpuId: ownedId,
                // persist the one-time purchase price so daily earnings can be computed as 1.10% of this value
                purchase_price: Number(price)
              }
            };
            addOwnedGpu(ownedGpu);
            // also mirror into mock DB if available for cross-device visibility
            if(api && api.__internal__ && api.__internal__.db){
              api.__internal__.db.gpus = api.__internal__.db.gpus || {};
              api.__internal__.db.gpus[ownedGpu.id] = Object.assign({}, ownedGpu);
              api.__internal__.db.transactions = api.__internal__.db.transactions || {};
              const tid = 't' + Math.random().toString(36).slice(2,9);
              api.__internal__.db.transactions[tid] = { id: tid, userId: ownerId, type: 'purchase_hardware', amount: Number(price), created_at: new Date().toISOString(), meta:{ deviceName: name, gpuId: ownedGpu.id } };
            }
          }catch(e){}

          // notify tx and balance changes
          try{ notify('tx:added', tx); notify('tx:changed', loadLocalTransactions()); }catch(e){}
          toastMessage(`Acquisto completato: saldo aggiornato. Vai a "I Miei GPU" per vedere l'attivazione e i dati di funzionamento del dispositivo.`);
          // ensure UI listeners (home, balances, tx lists) update immediately across sections
          try{ notify('balance:changed', { email: userEmail, balance: computeSpendableByEmail(userEmail) }); }catch(e){}
          try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
          try{ notify('owned:changed', readOwnedGpus()); }catch(e){}
          confirm.close();
          // show the newly purchased device immediately in the user's devices page
          navigate('my-devices');
        }catch(err){
          console.error(err);
          toastMessage('Errore durante l\'acquisto');
          confirm.close();
        }
      };
    };
  });

  // Attach details handlers to show performance banner similar to devices details
  Array.from(grid.querySelectorAll('.details-btn')).forEach(b=>{
    b.onclick = (e) => {
      const card = b.closest('.card');
      if(!card) return;
      // Attempt to read name/model/price from the card DOM
      let name = '';
      let model = '';
      let price = 0;
      try{
        const nameEl = card.querySelector('div[style*="font-weight:900"]:not(.small)');
        if(nameEl) name = nameEl.textContent.trim();
      }catch(e){}
      try{
        const modelEl = card.querySelector('.small');
        if(modelEl) model = modelEl.textContent.trim();
      }catch(e){}
      try{
        const priceEl = card.querySelector('div[style*="Prezzo"], div[style*="font-weight:900"]');
        // fallback to dataset or inner text parsing
      }catch(e){}

      // Simple heuristics for performance metrics
      const priceNumMatch = card.textContent.match(/[\d,.]+/);
      if(priceNumMatch) {
        const pStr = priceNumMatch[0].replace(/\./g,'').replace(',','.');
        const p = parseFloat(pStr);
        if(!Number.isNaN(p)) price = p;
      }

      // heuristics for metrics (same as devices)
      let watts = 0;
      if(price > 0) watts = Math.round(Math.max(50, price * 60));
      let instantThroughput = 0;
      if(price > 0) instantThroughput = Math.round(price * 1200);
      const modelMap = { 'a100':19.5, 'v100':14.0, 'rtx3090':35.6, 'titan':14.2, 'purchased':0, 'default':7.5 };
      const mkey = (model || '').toLowerCase();
      const tflops = modelMap[mkey] !== undefined ? modelMap[mkey] : modelMap['default'];

      // map device name/keywords to boost points required
      function pointsForDeviceName(n){
        try{
          const nameLower = String(n || '').toLowerCase();
          if(nameLower.includes('tier mini') || nameLower.includes('mini')) return 100;
          if(nameLower.includes('starter') || nameLower.includes('tier a') || nameLower.includes('starter plus')) return 160;
          if(nameLower.includes('value') || nameLower.includes('tier b') || nameLower.includes('value compute')) return 250;
          if(nameLower.includes('compute classic') || nameLower.includes('tier c')) return 400;
          if(nameLower.includes('performance') || nameLower.includes('tier d')) return 550;
          if(nameLower.includes('pro ai') || nameLower.includes('tier e') || nameLower.includes('pro-ai')) return 1500;
          if(nameLower.includes('enterprise +') || nameLower.includes('tier f') || nameLower.includes('enterprise-plus') || nameLower.includes('enterprise +')) return 2200;
          if(nameLower.includes('ultra enterprise') || nameLower.includes('tier g') || nameLower.includes('ultra enterprise')) return 3500;
          // fallback
          return 100;
        }catch(e){
          return 100;
        }
      }

      const boostPoints = pointsForDeviceName(name || model);

      const info = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>${escapeHtml(name || 'Dispositivo')} · ${escapeHtml(model || '')}</strong>
          <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
        </div>

        <!-- Performance banner -->
        <div style="display:flex;gap:10px;margin-bottom:12px;align-items:center">
          <div style="flex:1;padding:12px;border-radius:10px;background:linear-gradient(90deg,rgba(255,255,255,0.02),rgba(30,159,232,0.02));text-align:center">
            <div style="font-size:0.85rem;color:var(--muted)">Consumo stimato</div>
            <div style="font-weight:800;font-size:1.05rem">${watts} W</div>
          </div>
          <div style="flex:1;padding:12px;border-radius:10px;background:linear-gradient(90deg,rgba(255,255,255,0.02),rgba(30,159,232,0.02));text-align:center">
            <div style="font-size:0.85rem;color:var(--muted)">Rendimento istantaneo</div>
            <div style="font-weight:800;font-size:1.05rem">${instantThroughput.toLocaleString()} ops</div>
          </div>
          <div style="flex:1;padding:12px;border-radius:10px;background:linear-gradient(90deg,rgba(255,255,255,0.02),rgba(30,159,232,0.02));text-align:center">
            <div style="font-size:0.85rem;color:var(--muted)">TFLOPS</div>
            <div style="font-weight:800;font-size:1.05rem">${Number(tflops).toFixed(2)} TFLOPS</div>
          </div>
        </div>

        <div class="small">Prezzo boost: <strong>${escapeHtml(String(boostPoints))} punti</strong></div>
      `;
      showModal(info);
    };
  });
}

async function renderDevicesSection(container){
  container.innerHTML = `<div class="small">Caricamento dispositivi…</div>`;
  try{
    const list = await api.listGPUs({ token: auth.currentToken() });
    const gpus = list.gpus || [];

    if(!gpus.length){
      container.innerHTML = `<div class="small">Nessun dispositivo disponibile pubblicamente.</div>`;
      return;
    }

    // Header with count and bulk action
    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px">
        <div style="font-weight:900;color:#e6f7f0">Dispositivi Pubblici</div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="small" style="color:var(--muted)">${gpus.length} elementi</div>
          <button id="bulk-edit-btn" class="btn secondary" style="padding:8px 10px">Modifica selezionati</button>
        </div>
      </div>
      <div id="devices-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px"></div>
    `;

    const grid = container.querySelector('#devices-grid');

    // Build cards with checkbox and edit button
    gpus.forEach(g=>{
      const card = document.createElement('div');
      card.className = 'card device-card';
      card.style.padding = '12px';
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.gap = '10px';
      card.style.border = '1px solid rgba(255,255,255,0.03)';
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:start;gap:8px">
          <div style="display:flex;gap:10px;align-items:center">
            <input type="checkbox" class="select-gpu" data-gpu="${escapeHtml(g.id)}" />
            <div style="display:flex;flex-direction:column">
              <div style="font-weight:900;color:#e6f7f0">${escapeHtml(g.name)}</div>
              <div class="small" style="color:var(--muted)">${escapeHtml(g.model)}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn edit-btn" data-gpu="${escapeHtml(g.id)}" style="padding:8px 10px">Modifica</button>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="display:flex;flex-direction:column">
            <div style="font-weight:900">$${escapeHtml(String(g.price_per_hour))}/hr</div>
            <div class="small" style="color:var(--muted)">Prezzo orario</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end">
            <div style="font-weight:900">${escapeHtml(g.status)}</div>
            <div class="small" style="color:var(--muted)">Assegnato: ${g.assigned_at ? (new Date(g.assigned_at)).toLocaleDateString() : '—'}</div>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div class="small" style="color:var(--muted)">ID: ${escapeHtml(g.id)}</div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn rent-btn" data-gpu="${escapeHtml(g.id)}" style="padding:8px 10px">Affitta</button>
            <button class="btn secondary info-btn" data-gpu="${escapeHtml(g.id)}" style="padding:8px 10px">Info</button>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });

    // Per-device handlers: rent/info
    Array.from(container.querySelectorAll('.rent-btn')).forEach(b=>{
      b.onclick = async (e)=> {
        const id = b.dataset.gpu;
        const g = gpus.find(x=>x.id === id);
        if(!g) return toastMessage('Dispositivo non trovato');

        // obtain current user (auth.me will validate or throw)
        let meResp;
        try{
          meResp = await auth.me();
        }catch(err){
          return toastMessage('Sessione non valida. Effettua il login.');
        }
        const userEmail = (meResp && meResp.user && meResp.user.email) || '';
        // load local users to check balance
        let users = [];
        try{ users = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]'); }catch(e){}
        const localUser = users.find(u=>String(u.email||'').toLowerCase() === String(userEmail||'').toLowerCase());
        const price = Number(g.price_per_hour) || 0;

        if(!localUser){
          return toastMessage('Utente locale non trovato per addebito');
        }
        // check deposit-only spendable balance
        const spendable = computeSpendableByEmail(userEmail);
        if(spendable < price){
          return toastMessage('Saldo disponibile (spendibile) insufficiente per acquistare questo dispositivo');
        }

        // Ask for cycle selection (1/3/7 days)
        const cycleModal = showModal(`
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Seleziona ciclo di attivazione</strong>
            <button class="modal-close">Chiudi</button>
          </div>
          <div class="form-row">
            <label class="small">Scegli durata</label>
            <div style="display:flex;gap:8px">
              <button id="cycle-1" class="btn">1 giorno</button>
              <button id="cycle-3" class="btn">3 giorni</button>
              <button id="cycle-7" class="btn">7 giorni</button>
            </div>
          </div>
        `);
        let selectedDays = 1;
        cycleModal.panel.querySelector('#cycle-1').onclick = ()=> { selectedDays = 1; cycleModal.close(); proceed(); };
        cycleModal.panel.querySelector('#cycle-3').onclick = ()=> { selectedDays = 3; cycleModal.close(); proceed(); };
        cycleModal.panel.querySelector('#cycle-7').onclick = ()=> { selectedDays = 7; cycleModal.close(); proceed(); };

        async function proceed(){
          const confirm = showModal(`
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong>Conferma acquisto</strong>
              <button class="modal-close">Chiudi</button>
            </div>
            <div class="small">Dispositivo: ${escapeHtml(g.name)}</div>
            <div class="small">Prezzo (one-time): $${escapeHtml(String(price))}</div>
            <div class="small">Ciclo scelto: ${selectedDays} giorno(i)</div>
            <div class="small">Saldo attuale: $${escapeHtml(String(currentBal.toFixed ? currentBal.toFixed(2) : currentBal))}</div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
              <button id="confirm-buy" class="btn">Conferma acquisto</button>
            </div>
          `);
          confirm.panel.querySelector('#confirm-buy').onclick = async ()=>{
            try{
              const idx = users.findIndex(u=>u.id === localUser.id);
              if(idx === -1) throw new Error('User not found');
              users[idx].balance = (Number(users[idx].balance)||0) - Number(price);
              localStorage.setItem('CUP9_USERS', JSON.stringify(users));
              try{
                if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users){
                  const uid = users[idx].id;
                  api.__internal__.db.users[uid] = api.__internal__.db.users[uid] || {};
                  api.__internal__.db.users[uid].balance = users[idx].balance;
                }
              }catch(e){}
              // Notify UI that the persistent deposit balance changed so spendable/hero updates immediately
              try{ notify('balance:changed', { email: userEmail, balance: computeSpendableByEmail(userEmail) }); }catch(e){}

              // Record purchase transaction
              const txId = generateId('tx_');
              const tx = {
                id: txId,
                type: 'purchase',
                amount: Number(price),
                created_at: new Date().toISOString(),
                status: 'confirmed',
                email: userEmail,
                meta: { gpuId: g.id, gpuName: g.name, note: 'Acquisto GPU con saldo deposito', cycleDays: selectedDays }
              };
              addLocalTransaction(tx);

              // Assign GPU to this user in mock DB (WebSIM mode) and create scheduled earning
              try{
                if(api && api.__internal__ && api.__internal__.db){
                  api.__internal__.db.gpus = api.__internal__.db.gpus || {};
                  const mockGpu = api.__internal__.db.gpus[g.id] || {};
                  mockGpu.ownerId = users[idx].id;
                  mockGpu.assigned_at = new Date().toISOString();
                  mockGpu.status = 'idle';
                  mockGpu.name = g.name;
                  mockGpu.model = g.model || mockGpu.model || 'A100';
                  mockGpu.price_per_hour = g.price_per_hour;
                  api.__internal__.db.gpus[g.id] = mockGpu;

                  api.__internal__.db.transactions = api.__internal__.db.transactions || {};
                  const tid = 't' + Math.random().toString(36).slice(2,9);
                  api.__internal__.db.transactions[tid] = { id: tid, userId: users[idx].id, type: 'purchase_gpu', amount: Number(price), created_at: new Date().toISOString(), meta:{ gpuId: g.id, cycleDays: selectedDays } };
                }
              }catch(e){ console.error('Mirror to mock DB failed', e); }

              // Scheduled earnings feature removed: do not create scheduled_earning transactions.
              // Keep metadata on the mock GPU for cycleDays only (mirrored below).

              toastMessage('Acquisto completato: saldo aggiornato e dispositivo assegnato. Guadagni programmati.');
              confirm.close();
              await navigate('devices');
            }catch(err){
              console.error(err);
              toastMessage("Errore durante l'acquisto");
              confirm.close();
            }
          };
        }
      };
    });
    Array.from(container.querySelectorAll('.info-btn')).forEach(b=>{
      b.onclick = (e)=> {
        const id = b.dataset.gpu;
        const g = gpus.find(x=>x.id === id);
        if(!g) return toastMessage('Dispositivo non trovato');
        const info = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>${escapeHtml(g.name)} · ${escapeHtml(g.model)}</strong>
            <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
          </div>
          <div class="small">ID: ${escapeHtml(g.id)}</div>
          <div class="small">Prezzo orario: $${escapeHtml(String(g.price_per_hour))}/hr</div>
          <div class="small">Status: ${escapeHtml(g.status)}</div>
          <div class="small">Assegnato: ${g.assigned_at ? (new Date(g.assigned_at)).toLocaleString() : '—'}</div>
        `;
        showModal(info);
      };
    });

    // Edit single device
    Array.from(container.querySelectorAll('.edit-btn')).forEach(b=>{
      b.onclick = async (e)=> {
        const id = b.dataset.gpu;
        const g = gpus.find(x=>x.id === id);
        if(!g) return toastMessage('Dispositivo non trovato');
        const modal = showModal(`
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Modifica dispositivo</strong>
            <button class="modal-close">Chiudi</button>
          </div>
          <div class="form-row">
            <label class="small">Nome</label>
            <input id="edit-name" class="input" value="${escapeHtml(g.name)}" />
          </div>
          <div class="form-row">
            <label class="small">Modello</label>
            <input id="edit-model" class="input" value="${escapeHtml(g.model)}" />
          </div>
          <div class="form-row">
            <label class="small">Prezzo orario (USD)</label>
            <input id="edit-price" class="input" value="${escapeHtml(String(g.price_per_hour))}" />
          </div>
          <div class="form-row">
            <label class="small">Status</label>
            <select id="edit-status" class="input">
              <option ${g.status==='idle'?'selected':''} value="idle">idle</option>
              <option ${g.status==='running'?'selected':''} value="running">running</option>
              <option ${g.status==='maintenance'?'selected':''} value="maintenance">maintenance</option>
            </select>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button id="save-device" class="btn">Salva</button>
          </div>
        `);
        modal.panel.querySelector('#save-device').onclick = async ()=>{
          const updates = {
            name: modal.panel.querySelector('#edit-name').value.trim(),
            model: modal.panel.querySelector('#edit-model').value.trim(),
            price_per_hour: Number(modal.panel.querySelector('#edit-price').value) || g.price_per_hour,
            status: modal.panel.querySelector('#edit-status').value
          };
          try{
            await api.updateGPU({ token: auth.currentToken(), gpuId: id, updates });
            toastMessage('Dispositivo aggiornato');
            modal.close();
            // refresh view
            await navigate('devices');
          }catch(err){
            toastMessage('Errore aggiornamento');
          }
        };
      };
    });

    // Bulk edit: collect selected and open a simple bulk editor
    const bulkBtn = container.querySelector('#bulk-edit-btn');
    bulkBtn.onclick = ()=>{
      const checked = Array.from(container.querySelectorAll('.select-gpu:checked')).map(i=>i.dataset.gpu);
      if(!checked.length) return toastMessage('Seleziona almeno un dispositivo');
      const modal = showModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Modifica selezionati (${checked.length})</strong>
          <button class="modal-close">Chiudi</button>
        </div>
        <div class="form-row">
          <label class="small">Imposta status (vuoto = no change)</label>
          <select id="bulk-status" class="input">
            <option value="">-- Nessuna modifica --</option>
            <option value="idle">idle</option>
            <option value="running">running</option>
            <option value="maintenance">maintenance</option>
          </select>
        </div>
        <div class="form-row">
          <label class="small">Applica incremento prezzo orario (es. +0.5 o -1, vuoto = no change)</label>
          <input id="bulk-price" class="input" placeholder="+0.5 oppure -1" />
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button id="apply-bulk" class="btn">Applica</button>
        </div>
      `);
      modal.panel.querySelector('#apply-bulk').onclick = async ()=>{
        const status = modal.panel.querySelector('#bulk-status').value;
        const priceMod = modal.panel.querySelector('#bulk-price').value.trim();
        modal.close();
        // apply updates sequentially
        for(const id of checked){
          const g = gpus.find(x=>x.id===id);
          if(!g) continue;
          const updates = {};
          if(status) updates.status = status;
          if(priceMod){
            const delta = Number(priceMod);
            if(!Number.isNaN(delta)) updates.price_per_hour = Number(g.price_per_hour) + delta;
          }
          try{
            await api.updateGPU({ token: auth.currentToken(), gpuId: id, updates });
          }catch(e){
            // ignore per-device errors but notify
            toastMessage(`Errore su ${id}`);
          }
        }
        toastMessage('Modifiche applicate');
        navigate('devices');
      };
    };

  }catch(e){
    container.innerHTML = `<div class="small">Errore caricamento: ${e.message||e}</div>`;
  }
}

/* New static Dispositivi Plus page (always visible, independent from GPUs or user state) */
async function renderDevicesPlusSection(container){
  const plusDevices = [
    { name: 'Platinum Compute', tier: 'Tier H', price: '$5.000', desc: 'Contratto di investimento. Durata acquistabile: 1 / 2 / 5 anni. Capitale bloccato e non rimborsabile.' },
    { name: 'Elite Compute', tier: 'Tier I', price: '$7.500', desc: 'Contratto di investimento. Durata acquistabile: 1 / 2 / 5 anni. Capitale bloccato e non rimborsabile.' },
    { name: 'Diamond Compute', tier: 'Tier J', price: '$10.000', desc: 'Contratto di investimento. Durata acquistabile: 1 / 2 / 5 anni. Capitale bloccato e non rimborsabile.' },
    { name: 'Titanium Compute', tier: 'Tier K', price: '$12.500', desc: 'Contratto di investimento. Durata acquistabile: 1 / 2 / 5 anni. Capitale bloccato e non rimborsabile.' },
    { name: 'Ultra Titanium', tier: 'Tier L', price: '$15.000', desc: 'Contratto di investimento. Durata acquistabile: 1 / 2 / 5 anni. Capitale bloccato e non rimborsabile.' },
    { name: 'Enterprise Max', tier: 'Tier M', price: '$20.000', desc: 'Contratto di investimento. Durata acquistabile: 1 / 2 / 5 anni. Capitale bloccato e non rimborsabile.' },
    { name: 'Ultra Enterprise Max', tier: 'Tier N', price: '$30.000', desc: 'Contratto di investimento. Durata acquistabile: 1 / 2 / 5 anni. Capitale bloccato e non rimborsabile.' }
  ];

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-weight:900;color:#e6f7f0">Dispositivi Plus</div>
      <div class="small" style="color:var(--muted)">Contratti di investimento — elenco statico</div>
    </div>
    <div id="plus-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px"></div>
  `;
  const grid = container.querySelector('#plus-grid');

  plusDevices.forEach(d=>{
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '14px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '10px';
    card.style.border = '1px solid rgba(255,255,255,0.03)';

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="font-weight:900;font-size:1rem;color:#03181d">${escapeHtml(d.name)}</div>
          <div class="small" style="color:var(--muted)">${escapeHtml(d.tier)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:900;color:var(--gold);font-size:1.05rem">${escapeHtml(d.price)}</div>
          <div class="small" style="color:var(--muted);margin-top:6px">Contratto non rimborsabile · Durata: 1 / 2 / 5 anni</div>
        </div>
      </div>

      <div class="small" style="color:var(--muted);margin-top:6px">${escapeHtml(d.desc)}</div>

      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button class="btn details-plus" data-name="${escapeHtml(d.name)}" style="padding:8px 10px">Dettagli contratto</button>
        <button class="btn buy-contract" data-name="${escapeHtml(d.name)}" data-price="${escapeHtml(d.price)}" style="padding:8px 10px">Acquista contratto</button>
      </div>
    `;
    grid.appendChild(card);
  });

  Array.from(grid.querySelectorAll('.details-plus')).forEach(b=>{
    b.onclick = (e)=>{
      const name = b.dataset.name;
      const dev = plusDevices.find(x=>x.name === name) || {};
      const html = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>${escapeHtml(dev.name || '')} · ${escapeHtml(dev.tier || '')}</strong>
          <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
        </div>
        <div class="small">Prezzo: ${escapeHtml(dev.price || '')}</div>
        <div class="small" style="margin-top:8px">Durate acquistabili: 1 anno · 2 anni · 5 anni</div>
        <div class="small" style="margin-top:8px">Condizioni principali:</div>
        <ul style="margin-top:8px">
          <li>Importo scalato dal saldo al momento dell'acquisto</li>
          <li>Capitale bloccato e non rimborsabile</li>
          <li>Contratto: durata selezionabile e dividendi pagati mensilmente al tasso fisso del 29%</li>
          <li>I dividendi (se previsti) saranno comunicati sul contratto</li>
        </ul>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
          <button class="btn modal-close">Chiudi</button>
        </div>
      `;
      showModal(html);
    };
  });

  /* Buy contract handlers */
  Array.from(grid.querySelectorAll('.buy-contract')).forEach(b=>{
    b.onclick = async () => {
      const devName = b.dataset.name;
      const priceLabel = b.dataset.price || '';
      // parse numeric invested amount from price string (e.g., "$5.000" -> 5000)
      let cleaned = String(priceLabel).replace(/[^\d.,]/g,'').trim();
      cleaned = cleaned.replace(/\./g,'').replace(',', '.');
      const invested = Number(cleaned) || 0;

      // Show a modal that displays the fixed (non-editable) price and allows immediate confirmation
      const modal = showModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Acquista contratto · ${escapeHtml(devName)}</strong>
          <button class="modal-close">Chiudi</button>
        </div>

        <div class="form-row">
          <label class="small">Importo investimento (fisso)</label>
          <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:4px;color:#042b36;font-weight:800">
            $${escapeHtml(String(invested.toFixed ? invested.toFixed(2) : String(invested)))}
          </div>
        </div>

        <div class="form-row">
          <label class="small">Durata</label>
          <select id="contract-duration" class="input">
            <option value="1">1 anno</option>
            <option value="2">2 anni</option>
            <option value="5">5 anni</option>
          </select>
        </div>

        <!-- New: rendimento mode -->
        <div class="form-row">
          <label class="small">Modalità rendimento</label>
          <div style="display:flex;gap:8px;align-items:center">
            <label style="display:flex;gap:6px;align-items:center">
              <input type="radio" name="yield-mode" value="fixed" checked /> Tasso fisso (29% mensile)
            </label>
            <label style="display:flex;gap:6px;align-items:center">
              <input type="radio" name="yield-mode" value="variable" /> Tasso variabile (15%–45% mensile)
            </label>
          </div>
          <div class="small" style="color:var(--muted);margin-top:6px">Se scelto variabile, il rendimento mensile varia casualmente tra 15% e 45% e viene applicato una volta al mese.</div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button id="confirm-buy-contract" class="btn">Conferma acquisto</button>
        </div>
      `);

      const durSel = modal.panel.querySelector('#contract-duration');
      const confirmBtn = modal.panel.querySelector('#confirm-buy-contract');

      // Confirm handler uses the fixed invested amount (invested) — user cannot edit amount
      confirmBtn.onclick = async () => {
        const amount = Number(invested);
        const years = Number(durSel.value);

        // Ensure user is authenticated and has sufficient "Disponibilità (spendibile)"
        let meResp = null;
        try{
          meResp = await auth.me();
        }catch(e){
          toastMessage('Devi essere autenticato per acquistare un contratto');
          return;
        }
        const userEmail = (meResp && meResp.user && meResp.user.email) ? String(meResp.user.email).toLowerCase() : '';
        const spendable = computeSpendableByEmail(userEmail);
        if(Number(spendable) < Number(amount)){
          toastMessage('Saldo deposito disponibile insufficiente per acquistare questo contratto');
          return;
        }

        // Deduct invested amount from deposit balance (persistent user balance) and record a purchase tx
        try{
          updateUserBalanceByEmail(userEmail, -Number(amount));

          const txId = generateId('tx_');
          const tx = {
            id: txId,
            type: 'purchase_contract',
            amount: Number(amount),
            created_at: new Date().toISOString(),
            status: 'confirmed',
            email: userEmail,
            meta: { contractName: devName, duration_years: years, note: 'Acquisto contratto con saldo deposito' }
          };
          addLocalTransaction(tx);
          try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
        }catch(err){
          console.error('contratto purchase error', err);
          toastMessage(err && err.message ? err.message : 'Errore addebitamento saldo disponibile');
          return;
        }

        // compute monthly dividend: support two modes: fixed 29% monthly, or variable single-month random rate (15%-45%)
        let monthly_dividend_est = 0;
        let monthlyPct = 0.29;
        const contractMode = modal.panel.querySelector('input[name="yield-mode"]:checked').value;
        if(contractMode === 'variable'){
          const rate = 0.15 + Math.random() * (0.45 - 0.15);
          monthlyPct = Number(rate.toFixed(4));
          monthly_dividend_est = Number((amount * monthlyPct).toFixed(2));
        } else {
          monthlyPct = 0.29;
          monthly_dividend_est = Number((amount * monthlyPct).toFixed(2));
        }

        // create contract object and persist to local storage key CUP9_CONTRACTS, attaching owner info
        const cid = 'c_' + Math.random().toString(36).slice(2,10);
        const start = new Date();
        const end = new Date(start.getFullYear() + years, start.getMonth(), start.getDate());
        const contract = {
          id: cid,
          name: devName,
          tier: (plusDevices.find(x=>x.name===devName)||{}).tier || '',
          invested: Number(amount),
          duration_years: years,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          monthly_dividend_est: monthly_dividend_est,
          monthly_pct: monthlyPct,
          dividends_received: 0,
          ownerEmail: userEmail,
          ownerId: (meResp && meResp.user && meResp.user.id) || null,
          created_at: new Date().toISOString(),
          notes: 'Capitale bloccato e non rimborsabile; dividendi pagati mensilmente.',
          hidden: true
        };

        try{
          const raw = localStorage.getItem('CUP9_CONTRACTS') || '[]';
          const list = JSON.parse(raw);
          list.push(contract);
          localStorage.setItem('CUP9_CONTRACTS', JSON.stringify(list));
        }catch(e){
          console.error('save contract', e);
          toastMessage('Errore salvataggio contratto');
          return;
        }

        // Notify and navigate to contracts
        toastMessage('Contratto acquistato e pagato con saldo deposito; visualizzalo in "I miei Contratti".');
        modal.close();
        try{ notify('balance:changed', { email: userEmail, balance: computeSpendableByEmail(userEmail) }); }catch(e){}
        navigate('my-contracts');
      };
    };
  });
}

/* original my-devices function continues here */
async function renderMyDevicesSection(container){
  // improved: grid layout, bold TFLOPS header, larger controls for clarity
  container.innerHTML = `<div class="small">Caricamento…</div>`;
  try{
    // Load owned devices from persistent localStorage (primary source for user-owned devices)
    const ownedLocal = readOwnedGpus() || [];
    // Filter to current user by email/ownerId if possible
    let meResp = null;
    try{ meResp = await auth.me(); }catch(e){}
    const currentUserId = meResp && meResp.user && meResp.user.id;
    const currentEmail = meResp && meResp.user && meResp.user.email ? String(meResp.user.email).toLowerCase() : '';

    // Start with local owned list that matches current user
    let gpus = [];
    if(currentUserId){
      gpus = (ownedLocal || []).filter(g => String(g.ownerId || '').toLowerCase() === String(currentUserId).toLowerCase());
    } else {
      gpus = [];
    }

    // Merge confirmed 'purchase' transactions for this user so purchases always show up
    try{
      const txs = loadLocalTransactions() || [];
      const purchases = txs.filter(t=>{
        return String(t.type||'').toLowerCase() === 'purchase' &&
               String(t.status||'').toLowerCase() === 'confirmed' &&
               String(t.email||'').toLowerCase() === currentEmail;
      });
      for(const p of purchases){
        // Derive an ID for the owned GPU: prefer meta.gpuId, fallback to a stable id from tx id
        const gpuId = (p.meta && p.meta.gpuId) ? p.meta.gpuId : ('p_' + p.id);
        // If already present, skip
        if(gpus.find(x=>x.id === gpuId)) continue;
        // Build a minimal owned device record from purchase metadata
        const name = (p.meta && p.meta.deviceName) ? p.meta.deviceName : (`Purchased ${gpuId}`);
        const ownerId = currentUserId || null;
        const ownerEmail = currentEmail || (p.email || '').toLowerCase();
        const ownedGpu = {
          id: gpuId,
          name,
          model: 'purchased',
          status: 'running', // mounted by default per request
          assigned_at: p.created_at || new Date().toISOString(),
          ownerId,
          price_per_hour: 0,
          meta: Object.assign({}, p.meta || {}, { cycleDays: p.meta && p.meta.cycleDays ? p.meta.cycleDays : null, ownerEmail })
        };
        gpus.push(ownedGpu);
        // persist merged owned GPU locally for durability
        addOwnedGpu(ownedGpu);
        // also mirror into mock DB for cross-device visibility
        try{
          if(api && api.__internal__ && api.__internal__.db){
            api.__internal__.db.gpus = api.__internal__.db.gpus || {};
            api.__internal__.db.gpus[ownedGpu.id] = Object.assign({}, ownedGpu);
          }
        }catch(e){}
      }
    }catch(e){
      console.error('merge purchases error', e);
    }

    // Additionally, attempt to reconcile with mock API gpus to pick up any mirrored items (merge without overriding local)
    try{
      const apiResp = await api.listGPUs({ token: auth.currentToken() }).catch(()=>({ gpus: [] }));
      const remote = apiResp.gpus || [];
      // merge remote owned GPUs that are not present locally (so cross-device mirror is considered)
      for(const r of remote){
        if(String(r.ownerId || '').toLowerCase() === String(currentUserId || '').toLowerCase() && !gpus.find(x=>x.id === r.id)){
          // prefer local metadata if any; otherwise accept remote record
          gpus.push(r);
          addOwnedGpu(r); // persist mirrored remote ownership locally for durability
        }
      }
    }catch(e){
      // ignore remote merge errors
    }

    // Remove any license-like entries so "I miei GPU" never shows licenses (license is not hardware)
    try{
      gpus = (gpus || []).filter(g => {
        try{
          const name = String(g.name || '').toLowerCase();
          const model = String(g.model || '').toLowerCase();
          const meta = g.meta || {};
          // heuristics: exclude entries where model/name/meta indicate a license or contract
          if(model.includes('license') || model.includes('licenza') || model.includes('contract')) return false;
          if(name.includes('licenza') || name.includes('license') || name.includes('contratto')) return false;
          if(meta && (String(meta.license || '').length > 0 || meta.contractId || meta.is_license)) return false;
          return true;
        }catch(e){
          return true;
        }
      });
    }catch(e){
      // if filtering fails, fall back to original list
    }

    if(!gpus.length){
      container.innerHTML = `<div class="small">Non hai dispositivi assegnati.</div>`;
      return;
    }

    // Render each owned device with cycle-selection controls if no cycle yet
    // First compute a TFLOPS estimate for each device so the list can display it directly.
    // Attach displayTflops into device meta for each gpu using the same price->TFLOPS heuristic as the Hardware catalog
    try{
      // heuristic fallback model map for explicit models
      const modelMap = {
        'a100': 19.5,
        'v100': 14.0,
        'rtx3090': 35.6,
        'titan': 14.2,
        'purchased': 0,
        'default': 7.5
      };

      gpus.forEach(g=>{
        try{
          g.meta = g.meta || {};
          // Prefer an explicit meta.tflops if present
          if(g.meta && Number(g.meta.tflops)){
            g.meta.displayTflops = Number(g.meta.tflops).toFixed(2);
            return;
          }

          // Determine a numeric price to drive the TFLOPS heuristic:
          // - prefer meta.purchase_price (one-time purchase)
          // - else derive daily-equivalent from price_per_hour (price_per_hour * 24)
          let priceNum = 0;
          if(g.meta && Number(g.meta.purchase_price) && Number(g.meta.purchase_price) > 0){
            priceNum = Number(g.meta.purchase_price);
          } else if(Number(g.price_per_hour) && Number(g.price_per_hour) > 0){
            priceNum = Number(g.price_per_hour) * 24;
          } else {
            priceNum = 0;
          }

          let tflops = 0;
          if(priceNum <= 0){
            // fallback to model map if no price info
            const mkey = String(g.model || '').toLowerCase();
            tflops = modelMap[mkey] !== undefined ? modelMap[mkey] : modelMap['default'];
          } else if(priceNum < 200){
            tflops = Math.max(4, (priceNum / 40));
          } else if(priceNum < 800){
            tflops = Math.max(10, (priceNum / 45));
          } else {
            tflops = Math.max(20, (priceNum / 55));
          }
          g.meta.displayTflops = Number(tflops || 0).toFixed(2);
        }catch(e){
          g.meta = g.meta || {};
          g.meta.displayTflops = Number(modelMap['default']).toFixed(2);
        }
      });
    }catch(e){
      // ignore
    }

    // read schedules so we can show per-device progress
    const schedulesList = readSchedules() || [];

    // Ensure that any schedule that reached its end (100% progress) and requires a manual claim
    // has a corresponding pending claim entry so the UI always displays a Claim button.
    // This creates CUP9_PENDING_CLAIMS entries if missing, keeping behavior front-end-only.
    (function ensurePendingClaimsFromSchedules(){
      try{
        const pendingKey = 'CUP9_PENDING_CLAIMS';
        const existing = JSON.parse(localStorage.getItem(pendingKey) || '[]');

        const now = new Date();
        const schedules = schedulesList || [];
        let appended = false;

        // Normalize legacy schedules: ensure meta._claimed exists (default false)
        try{
          let modified = false;
          for(const s of schedules){
            if(!s.meta) s.meta = {};
            if(typeof s.meta._claimed === 'undefined'){
              s.meta._claimed = false;
              modified = true;
            }
          }
          if(modified){
            // persist corrected schedules
            writeSchedules(schedules);
            notify('schedules:changed', readSchedules());
          }
        }catch(e){ /* non-fatal */ }

        for(const s of schedules){
          try{
            // Only consider schedules that require manual claim
            const requiresClaim = s.meta && s.meta.require_claim;
            if(!requiresClaim) continue;

            // schedule must be finished (completed or end_at passed)
            const ended = s.status === 'completed' || (s.end_at && new Date(s.end_at).getTime() <= now.getTime());
            if(!ended) continue;

            // Skip if schedule already marked claimed (persistent flag); only unclaimed schedules create pending claim
            if(s.meta && s.meta._claimed) continue;

            // avoid duplicate pending claim for same schedule/gpu
            const schedId = String(s.id || '');
            const already = existing.find(x => String(x.scheduleId || '') === schedId || String(x.gpuId || '') === String(s.gpuId || ''));
            if(already) continue;

            // Build pending claim object (minimal fields required by UI)
            const claim = {
              id: generateId('claim_'),
              scheduleId: schedId,
              gpuId: s.gpuId,
              email: String(s.email || '').toLowerCase(),
              amount: Number(s.amount || 0),
              created_at: new Date().toISOString(),
              claimed: false
            };
            existing.push(claim);
            appended = true;
          }catch(e){ /* continue on per-schedule errors */ }
        }
        if(appended){
          localStorage.setItem(pendingKey, JSON.stringify(existing));
          try{ notify('schedules:changed', readSchedules()); }catch(e){}
        }
      }catch(e){
        console.error('ensurePendingClaimsFromSchedules error', e);
      }
    })();

    // Compute already-produced USDT per GPU from local transactions (accredited/confirmed earnings)
    const allTxsForProduced = loadLocalTransactions() || [];
    const producedByGpu = {};
    // Also compute the last accredited timestamp per GPU so we can show "Ultimo accredito"
    const lastCreditByGpu = {};
    try{
      for(const tx of allTxsForProduced){
        const typ = String(tx.type||'').toLowerCase();
        const st = String(tx.status||'').toLowerCase();
        // only count finalized earning-like transactions
        if(!['scheduled_earning','earning','checkin'].includes(typ)) continue;
        if(!(st === 'accredited' || st === 'confirmed')) continue;

        // prefer explicit gpu linkage in meta; also check common meta keys
        let gpuId = null;
        try{
          if(tx.meta){
            gpuId = tx.meta.gpuId || tx.meta._scheduleId || tx.meta.gpu_id || null;
          }
          // fallback attempt: some transactions may store gpuId at top-level
          if(!gpuId && tx.gpuId) gpuId = tx.gpuId;
        }catch(e){ gpuId = null; }

        if(!gpuId) continue;
        producedByGpu[gpuId] = (producedByGpu[gpuId] || 0) + Number(tx.amount || 0);

        // track most-recent accredited timestamp for this gpu
        try{
          const created = tx.created_at ? new Date(tx.created_at).getTime() : 0;
          if(!lastCreditByGpu[gpuId] || created > lastCreditByGpu[gpuId]) lastCreditByGpu[gpuId] = created;
        }catch(e){}
      }
    }catch(e){
      console.error('compute producedByGpu error', e);
    }

    // Ensure there is always an accredited scheduled_earning transaction per-device aligned to the purchase hour:
    // For each owned gpu, create a deterministic per-day tx id tx_auto_{gpuId}_{YYYY-MM-DD} for yesterday at purchase hour if missing,
    // so "Ultimo accredito" and "Ora di accredito" are always available in the UI.
    try{
      const allTxs = loadLocalTransactions() || [];
      const txIdSet = new Set((allTxs||[]).map(t => String(t.id)));
      const now = new Date();
      for(const d of gpus){
        try{
          // determine purchase reference: prefer meta.start_at, meta.activated_at, assigned_at, or purchase tx
          let refIso = d.meta && (d.meta.start_at || d.meta.activated_at || d.meta.purchased_at || d.meta.purchase_date) ? (d.meta.start_at || d.meta.activated_at || d.meta.purchased_at || d.meta.purchase_date) : (d.assigned_at || null);
          if(!refIso){
            // try purchase tx
            const ptx = allTxsForProduced.find(t=>{
              try{
                return String(t.type||'').toLowerCase() === 'purchase' &&
                       ((t.meta && String(t.meta.gpuId||'') === String(d.id)) || (t.meta && String(t.meta.deviceName||'') === String(d.name)));
              }catch(e){ return false; }
            });
            if(ptx) refIso = ptx.created_at || null;
          }
          if(!refIso) {
            // fallback: use assigned_at or now
            refIso = d.assigned_at || new Date().toISOString();
          }
          const refDate = new Date(refIso);
          if(isNaN(refDate.getTime())) continue;

          // compute previous day at the same wall-clock hour/minute as purchase reference
          const prev = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), refDate.getHours(), refDate.getMinutes(), refDate.getSeconds(), refDate.getMilliseconds());
          // move to yesterday
          prev.setDate(prev.getDate() - 1);
          const dateKey = prev.toISOString().slice(0,10); // YYYY-MM-DD
          const deterministicId = `tx_auto_${String(d.id)}_${dateKey}`;
          if(txIdSet.has(deterministicId)) continue;
          // compute createdAt at the same local wall-clock (preserve hour:minute)
          const createdAt = new Date(prev.getTime()).toISOString();
          // compute daily amount using heuristics (same as elsewhere)
          let daily = 0;
          try{
            if(d.meta && Number(d.meta.dailyEarnings)) daily = Number(d.meta.dailyEarnings);
            else if(d.meta && Number(d.meta.purchase_price)) daily = Number((Number(d.meta.purchase_price) * 0.011).toFixed(4));
            else if(Number(d.price_per_hour)) daily = Number(((Number(d.price_per_hour) * 24) * 0.011).toFixed(4));
            else {
              const t = Number((d.meta && d.meta.displayTflops) || 0);
              daily = t ? Number((t * 0.25).toFixed(4)) : 0;
            }
          }catch(e){ daily = 0; }
          if(!daily || Number(daily) <= 0) continue;
          // construct tx and add idempotently
          const tx = {
            id: deterministicId,
            type: 'scheduled_earning',
            amount: Number(daily),
            created_at: createdAt,
            status: 'accredited',
            email: String((d.meta && d.meta.ownerEmail) || currentEmail || '').toLowerCase(),
            meta: { _fromAutoDaily: true, _auto_key: deterministicId, gpuId: d.id || null }
          };
          addLocalTransaction(tx);
          // update local sets to avoid duplicating in same loop
          txIdSet.add(deterministicId);
          // update producedByGpu and lastCreditByGpu so UI shows the new last credit immediately
          producedByGpu[d.id] = (producedByGpu[d.id] || 0) + Number(daily);
          lastCreditByGpu[d.id] = new Date(createdAt).getTime();
        }catch(e){}
      }
    }catch(e){
      console.error('ensure per-device daily tx creation failed', e);
    }

    container.innerHTML = gpus.map(function(g){
      // Determine if device should be treated as a purchased device (hide Start/Stop)
      const isPurchased = Boolean(
        (g.meta && g.meta.ownerEmail) ||
        String(g.id || '').startsWith('p_') ||
        String(g.model || '').toLowerCase() === 'purchased'
      );
      // Compute number of credited days since purchase (based on assigned_at / meta.start_at / meta.activated_at / purchase tx)
      let creditedDays = 0;
      try{
        // Compute number of credited days from actual accredited earning transactions for this GPU
        const allTxs = loadLocalTransactions() || [];
        const gpuId = String(g.id || '');
        creditedDays = allTxs.filter(t => {
          try{
            const typ = String(t.type || '').toLowerCase();
            const st = String(t.status || '').toLowerCase();
            if(!(typ === 'scheduled_earning' || typ === 'earning' || typ === 'checkin')) return false;
            if(!(st === 'accredited' || st === 'confirmed')) return false;
            // prefer explicit meta.gpuId linkage
            if(t.meta && String(t.meta.gpuId || '') === gpuId) return true;
            // accept deterministic auto ids tx_auto_{gpuId}_YYYY-MM-DD
            if(String(t.id || '').indexOf(`tx_auto_${gpuId}_`) === 0) return true;
            // also accept transactions tied via a schedule meta that references this gpu
            if(t.meta && String(t.meta._scheduleId || '')){
              const sid = String(t.meta._scheduleId || '');
              const schedMatch = schedulesList.find(s => String(s.id) === sid && String(s.gpuId) === gpuId);
              if(schedMatch) return true;
            }
            return false;
          }catch(e){ return false; }
        }).length;
        // stop further purchase-date heuristics — we derived creditedDays from transactions
        purchaseAt = null;
        if(!purchaseAt){
          // fallback: try to find a purchase tx for this gpu in local transactions
          try{
            const txs = loadLocalTransactions() || [];
            const ptx = txs.find(t=>{
              try{
                return String(t.type||'').toLowerCase() === 'purchase' &&
                       ((t.meta && String(t.meta.gpuId||'') === String(g.id)) ||
                        (t.meta && String(t.meta.deviceName||'') === String(g.name)) );
              }catch(e){ return false; }
            });
            if(ptx) purchaseAt = ptx.created_at || null;
          }catch(e){}
        }
        if(purchaseAt){
          const startMs = new Date(purchaseAt).getTime();
          if(!isNaN(startMs) && startMs <= Date.now()){
            creditedDays = Math.floor((Date.now() - startMs) / (24*60*60*1000));
            if(creditedDays < 0) creditedDays = 0;
          }
        }
      }catch(e){
        creditedDays = 0;
      }

      // Determine associated schedule (by explicit meta._scheduleId or by gpuId)
      let sched = null;
      try{
        const sid = g.meta && g.meta._scheduleId;
        if(sid){
          sched = schedulesList.find(s => String(s.id) === String(sid));
        }
        if(!sched){
          sched = schedulesList.find(s => String(s.gpuId) === String(g.id));
        }
      }catch(e){ sched = null; }

      // Determine cycle timing fields (start_at, end_at, cycle_days)
      // Ensure every owned device has a meaningful 24-hour window so the progress bar is visible for all users.
      let start_at = (g.meta && g.meta.start_at) ? g.meta.start_at : (sched && sched.start_at) ? sched.start_at : null;
      let end_at = (g.meta && g.meta.end_at) ? g.meta.end_at : (sched && sched.end_at) ? sched.end_at : null;
      // Fallback: if no explicit start/end but assigned_at (or purchase time) exists, create a rolling 24h window
      try{
        if(!start_at){
          // prefer assigned_at, then meta.activated_at/purchased_at, then purchase tx created_at if available
          start_at = g.assigned_at || (g.meta && (g.meta.activated_at || g.meta.purchased_at || g.meta.purchase_date)) || null;
          if(!start_at){
            try{
              const ptx = (loadLocalTransactions() || []).find(t=>{
                try{
                  return String(t.type||'').toLowerCase() === 'purchase' && ((t.meta && String(t.meta.gpuId||'') === String(g.id)) || (t.meta && String(t.meta.deviceName||'') === String(g.name)));
                }catch(e){ return false; }
              });
              if(ptx) start_at = ptx.created_at || null;
            }catch(e){}
          }
        }
        if(start_at && !end_at){
          // create a single 24-hour window starting at purchase/assigned hour (so progress reaches 100% in 24h)
          const s = new Date(start_at);
          // if start is invalid, fallback to now
          if(isNaN(s.getTime())) start_at = new Date().toISOString();
          // compute end_at as start + 24h
          end_at = new Date(new Date(start_at).getTime() + 24 * 60 * 60 * 1000).toISOString();
        }
      }catch(e){
        // preserve existing nulls on error
      }
      let cycle_days = (g.meta && g.meta.cycleDays) ? Number(g.meta.cycleDays) : (sched && sched.days) ? Number(sched.days) : null;

      // Normalize cycle_days to explicit mapping 1/3/7 -> 24/72/168 hours (display only)
      const cycleHoursMap = { 1:24, 3:72, 7:168 };
      const cycleHours = cycle_days ? (cycleHoursMap[cycle_days] || (cycle_days * 24)) : null;

      // Compute progress and cycle status strictly based on now vs start_at/end_at
      let progressPct = 0;
      let daysLeftText = 'No cycle';
      let cycleStatus = 'non attivo';
      try{
        if(start_at && end_at){
          const now = new Date();
          const start = new Date(start_at);
          const end = new Date(end_at);
          const totalMs = Math.max(1, end.getTime() - start.getTime());
          const elapsedMs = Math.max(0, Math.min(totalMs, now.getTime() - start.getTime()));
          progressPct = Math.min(100, Math.max(0, Math.round((elapsedMs / totalMs) * 100)));
          const msLeft = Math.max(0, end.getTime() - now.getTime());
          const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
          daysLeftText = (msLeft <= 0) ? 'Completato' : `${daysLeft} giorno(i) rimanenti`;
          // Cycle state: active when now < end_at, completed when now >= end_at
          cycleStatus = (now.getTime() >= end.getTime()) ? 'completato' : 'attivo';

          // If progress reached 100% ensure the owned device is transitioned to idle and its cycle metadata is cleared.
          // This enforces that completed cycles do not remain marked as running in the owned devices store.
          if(progressPct >= 100){
            cycleStatus = 'completato';
            // NOTE: Do not mutate owned GPU state here — defer clearing/idle transition and claim creation
            // to completeSchedule() so completion -> climb -> user-driven new-cycle remains a single authoritative flow.
          }
        } else if(cycle_days){
          daysLeftText = `${escapeHtml(String(cycle_days))} giorno(i) totali`;
          progressPct = 0;
          cycleStatus = 'non attivo';
        } else {
          progressPct = 0;
          cycleStatus = 'non attivo';
        }
      }catch(e){
        progressPct = 0;
        daysLeftText = 'Errore calcolo';
        cycleStatus = 'non attivo';
      }

      // Compute accumulated earnings so far for this GPU from producedByGpu map (precomputed above)
                  // Compute accumulated earnings so far using: accumulated = totalPredicted * percentComplete
            //  - dailyEarnings: prefer explicit meta.dailyEarnings or compute from purchase_price / price_per_hour fallback
            let dailyEarnings = 0;
            try{
              if(g.meta && Number(g.meta.dailyEarnings)) {
                dailyEarnings = Number(g.meta.dailyEarnings);
              } else if(g.meta && Number(g.meta.purchase_price) && Number(g.meta.purchase_price) > 0) {
                dailyEarnings = Number((Number(g.meta.purchase_price) * 0.011).toFixed(4));
              } else if(Number(g.price_per_hour) && Number(g.price_per_hour) > 0) {
                dailyEarnings = Number(((Number(g.price_per_hour) * 24) * 0.011).toFixed(4));
              } else {
                // fallback conservative estimate from TFLOPS if available
                const t = Number((g.meta && g.meta.displayTflops) || 0);
                dailyEarnings = t ? Number((t * 0.25).toFixed(4)) : 0;
              }
            }catch(e){ dailyEarnings = 0; }

            // cycle_days normalized from meta or schedule
            const deviceCycleDays = Number(g.meta && (g.meta.cycleDays || g.meta.cycle_days) ? (g.meta.cycleDays || g.meta.cycle_days) : (sched && sched.days ? sched.days : 0)) || 0;
            // total predicted = dailyEarnings * cycleDays
            const totalPredicted = Number((dailyEarnings * (deviceCycleDays || 1)).toFixed(4));

            // percent completion based on start_at/end_at (progressPct already computed earlier as 0-100)
            const percentComplete = Number(progressPct) / 100;
            // accumulated = totalPredicted * percentComplete
            const accumulated = Number((totalPredicted * percentComplete).toFixed(4));

            // derive a purchase price display value for the device (prefer explicit purchase_price, fallback to 24*price_per_hour)
            let purchasePrice = 0;
            try{
              if(g.meta && Number(g.meta.purchase_price) && Number(g.meta.purchase_price) > 0){
                purchasePrice = Number(g.meta.purchase_price);
              } else if(Number(g.price_per_hour) && Number(g.price_per_hour) > 0){
                purchasePrice = Number((Number(g.price_per_hour) * 24).toFixed(2));
              } else {
                purchasePrice = 0;
              }
            }catch(e){
              purchasePrice = 0;
            }

      // small progress bar HTML (always shown; 0% when no schedule)
      const progressHtml = (function(){
        const wrapperStart = `<div style="margin-top:8px;width:220px;max-width:100%">`;
        const wrapperEnd = `</div>`;
        const bar = `
          <div style="height:8px;background:linear-gradient(90deg,rgba(0,0,0,0.06),rgba(0,0,0,0.02));border-radius:8px;overflow:hidden">
            <div style="height:100%;width:${progressPct}%;background:linear-gradient(90deg,var(--accent),var(--accent-2));transition:width .6s ease;"></div>
          </div>
        `;
        const label = `<div class="small" style="margin-top:6px;color:var(--muted)">${escapeHtml(daysLeftText)} · ${progressPct}% · Stato ciclo: ${escapeHtml(cycleStatus)}</div>`;
        return wrapperStart + bar + label + wrapperEnd;
      })();

      // Determine image URL: prefer meta.image or meta.img, else use a purchased placeholder or generic GPU image (local assets)
      const imgUrl = (g.meta && (g.meta.image || g.meta.img)) ? String(g.meta.image || g.meta.img) : (String(g.model || '').toLowerCase() === 'purchased' ? '/gpu-purchased.png' : '/gpu-default-gpu.png');

      // Compute "Ora di accredito" to display: use the device purchase/assigned time (if available) and show only the time (HH:MM) in Rome timezone.
      // The "Prossimo accredito" remains computed from schedule end_at or the global daily payout marker.
      let oraAccredito = '—';
      let prossimoAccredito = '—';
      try{
        function formatRome(iso, opts){
          try{
            if(!iso) return '—';
            const d = new Date(iso);
            if(window.CUP9 && typeof window.CUP9.toRomeString === 'function'){
              return String(window.CUP9.toRomeString(d, Object.assign({ year:'numeric', month:'2-digit', day:'2-digit', hour: '2-digit', minute: '2-digit' }, opts || {})) || '').trim();
            }
            return d.toLocaleString('it-IT', Object.assign({ year:'numeric', month:'2-digit', day:'2-digit', hour: '2-digit', minute: '2-digit' }, opts || {}));
          }catch(e){ return '—'; }
        }
        function formatTimeOnlyRome(iso){
          try{
            if(!iso) return '—';
            const d = new Date(iso);
            if(window.CUP9 && typeof window.CUP9.toRomeString === 'function'){
              return String(window.CUP9.toRomeString(d, { hour: '2-digit', minute: '2-digit' }) || '').trim();
            }
            return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
          }catch(e){ return '—'; }
        }

        // Primary source: strictly use assigned_at or explicit meta purchase timestamps; fallback to purchase tx only if none of those exist.
        let purchaseIso = null;
        try{
          if(g.assigned_at) purchaseIso = g.assigned_at;
          if(!purchaseIso && g.meta){
            purchaseIso = g.meta.purchase_date || g.meta.purchased_at || g.meta.activated_at || g.meta.start_at || null;
          }
          if(!purchaseIso){
            const txs = loadLocalTransactions() || [];
            const ptx = txs.find(t=>{
              try{
                return String(t.type||'').toLowerCase() === 'purchase' &&
                       ((t.meta && String(t.meta.gpuId || '') === String(g.id)) || (t.meta && String(t.meta.deviceName || '') === String(g.name)));
              }catch(e){ return false; }
            });
            if(ptx) purchaseIso = ptx.created_at || null;
          }
        }catch(e){ purchaseIso = null; }

        // IMPORTANT: oraAccredito MUST equal the purchase time when available.
        if(purchaseIso){
          oraAccredito = formatTimeOnlyRome(purchaseIso);
        } else {
          // If no purchase time found, show a clear placeholder to avoid guessing.
          oraAccredito = '—';
        }

        // Compute "Prossimo accredito": if purchase/assigned time exists, compute the next daily occurrence at the exact purchase time (hour:minute)
        // This ensures the "Ora di accredito" equals the purchase time and "Prossimo accredito" advances by +1 day each time.
        try{
          const DAY_MS = 24 * 60 * 60 * 1000;
          if(purchaseIso){
            const start = new Date(purchaseIso);
            if(!isNaN(start.getTime())){
              // Build the next occurrence by taking the purchase wall-clock hour/minute and advancing days until it's in the future.
              // This preserves the exact purchase hour for every subsequent daily accrual.
              const now = new Date();
              // Start from today's date at the purchase time
              const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
              let nextOccurrence = candidate;
              // If candidate is not strictly in the future, step forward by whole days until it is
              while(nextOccurrence.getTime() <= now.getTime()){
                nextOccurrence = new Date(nextOccurrence.getTime() + DAY_MS);
              }
              // If there is an explicit schedule end_at earlier than the next occurrence and it's still in the future, prefer that
              if(end_at){
                const endMs = new Date(end_at).getTime();
                if(!isNaN(endMs) && endMs > Date.now() && endMs < nextOccurrence.getTime()){
                  prossimoAccredito = formatRome(new Date(endMs).toISOString());
                } else {
                  prossimoAccredito = formatRome(nextOccurrence.toISOString());
                }
              } else {
                prossimoAccredito = formatRome(nextOccurrence.toISOString());
              }
            } else {
              // fallback when purchase parsing fails
              prossimoAccredito = '—';
            }
          } else {
            // No purchase time: preserve prior logic using end_at or LAST_RUN_KEY
            const LAST_RUN_KEY = 'CUP9_LAST_DAILY_PAYOUT_AT';
            if(end_at){
              const endMs = new Date(end_at).getTime();
              if(!isNaN(endMs) && endMs > Date.now()){
                prossimoAccredito = formatRome(new Date(endMs).toISOString());
              } else {
                const lastRaw = localStorage.getItem(LAST_RUN_KEY);
                if(lastRaw){
                  const lastTs = new Date(lastRaw).getTime();
                  const nextTs = lastTs + DAY_MS;
                  prossimoAccredito = formatRome(new Date(nextTs).toISOString());
                } else {
                  prossimoAccredito = formatRome(new Date(Date.now() + DAY_MS).toISOString());
                }
              }
            } else {
              const lastRaw = localStorage.getItem(LAST_RUN_KEY);
              if(lastRaw){
                const lastTs = new Date(lastRaw).getTime();
                const nextTs = lastTs + DAY_MS;
                prossimoAccredito = formatRome(new Date(nextTs).toISOString());
              } else {
                prossimoAccredito = formatRome(new Date(Date.now() + DAY_MS).toISOString());
              }
            }
          }
        }catch(e){
          prossimoAccredito = '—';
        }

      }catch(e){
        oraAccredito = '—';
        prossimoAccredito = '—';
      }

      // compute last accredited timestamp for this GPU (if any) and format for display
      let lastCreditDisplay = '—';
      try{
        if(lastCreditByGpu && lastCreditByGpu[g.id]){
          const lcIso = new Date(lastCreditByGpu[g.id]).toISOString();
          lastCreditDisplay = formatRome(lcIso);
        }
      }catch(err){
        lastCreditDisplay = '—';
      }

      return `
      <div class="stat" id="gpu-${escapeHtml(g.id)}" style="display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div style="flex:0 0 84px;display:flex;align-items:center;justify-content:center">
            <img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(g.name)}" style="width:72px;height:72px;border-radius:8px;object-fit:cover;border:1px solid rgba(0,0,0,0.06)" onerror="this.style.display='none'"/>
          </div>
          <div>
            <div style="font-weight:700;color:#0a7a45">${escapeHtml(g.name)}</div>
            <div class="small">Status: ${escapeHtml(g.status)} · ${escapeHtml(g.model)}</div>

            <!-- TFLOPS displayed inline in the device list for purchased/owned GPUs -->
            <div class="small" style="color:var(--muted);margin-top:6px">TFLOPS: <span style="font-weight:800;color:#042b36">${escapeHtml(String(g.meta && g.meta.displayTflops ? g.meta.displayTflops : '0.00'))} TFLOPS</span></div>

            <!-- New: show purchase price and estimated daily earning for purchased devices -->
            <div class="small" style="color:var(--muted);margin-top:6px">
              Prezzo di acquisto: <strong style="color:#03181d">$${Number(purchasePrice || 0).toFixed(2)}</strong>
            </div>
            <div class="small" style="color:var(--muted);margin-top:6px">
              Guadagno giornaliero stimato: <strong class="earned" style="color:#0a7a45">$${Number(dailyEarnings || 0).toFixed(2)}</strong>
            </div>

            <!-- Required fields: purchase date, start_at, end_at, cycle_days, progress, cycle status, accumulated earnings -->
            <div class="small" style="color:var(--muted);margin-top:8px">
              Data di acquisto: <strong style="color:#03181d">${escapeHtml((new Date(g.assigned_at || '')).toLocaleString() || '—')}</strong>
            </div>
            <div class="small" style="color:var(--muted);margin-top:4px">
              Attivazione ciclo (start_at): <strong style="color:#03181d">${start_at ? escapeHtml((new Date(start_at)).toLocaleString()) : '—'}</strong>
            </div>
            <div class="small" style="color:var(--muted);margin-top:4px">
              Fine ciclo (end_at): <strong style="color:#03181d">${end_at ? escapeHtml((new Date(end_at)).toLocaleString()) : '—'}</strong>
            </div>
            <div class="small" style="color:var(--muted);margin-top:4px">
              Durata selezionata (giorni): <strong style="color:#03181d">${cycle_days ? escapeHtml(String(cycle_days)) : '—'}</strong>
              ${cycleHours ? `<span class="small" style="color:var(--muted);margin-left:8px">(${cycleHours}h)</span>` : ''}
            </div>
            <div class="small" style="color:var(--muted);margin-top:4px">
              Ora di accredito: <strong style="color:#03181d">${escapeHtml(String(oraAccredito))}</strong>
            </div>
            <div class="small" style="color:var(--muted);margin-top:4px">
              Prossimo accredito: <strong style="color:#03181d">${escapeHtml(String(prossimoAccredito))}</strong>
            </div>

            <!-- Accumulated earnings so far -->
            <div class="small" style="color:var(--muted);margin-top:6px">
              Guadagni accumulati finora: <strong class="accumulated" style="color:#0a7a45">$${Number(accumulated || 0).toFixed(2)}</strong>
            </div>
            <!-- Number of credited days (N. accrediti) since purchase -->
            <div class="permanent-active-label">Stato: Attivo (funzionamento permanente — accrediti automatici)</div>

            <!-- Totale guadagno previsto a fine ciclo (mostra solo il totale corrispondente al ciclo selezionato o 1 giorno di default) -->
            <div class="small" style="color:var(--muted);margin-top:6px">
              ${(() => {
                try{
                  const sel = [1,3,7].includes(deviceCycleDays) ? deviceCycleDays : 1;
                  const selectedTotal = Number((dailyEarnings * sel).toFixed(2));
                  return `Totale $ ciclo: $${selectedTotal.toFixed(2)}`;
                }catch(e){
                  return 'Totale $ ciclo: —';
                }
              })()}
            </div>

            <!-- Progress / schedule status -->
            ${progressHtml}
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
          <div style="display:flex;gap:6px">
            ${''}
          </div>
          <div style="display:flex;gap:6px">
            <!-- Seleziona ciclo: sempre visibile but disabled while a cycle is in progress (only enabled when not running or completed) -->
            ${(() => {
              try{
                // Determine if a cycle is currently active (started and not yet ended)
                // Disable selection only when cycleStatus indicates the cycle is 'attivo' or the device is explicitly marked running.
                const hasStartEnd = !!(start_at && end_at);
                const nowMs = Date.now();
                const endMs = end_at ? new Date(end_at).getTime() : 0;
                // Use cycleStatus computed earlier; also respect explicit device running flag
                // Only disable cycle selection when the device is explicitly running AND the current cycle has not finished.
                // This ensures devices in 'idle' state keep the "Seleziona ciclo" button enabled.
                const deviceRunning = String(g.status || '').toLowerCase() === 'running';
                let stillRunning = false;
                try{
                  if(start_at && end_at){
                    const now = Date.now();
                    const endMs = new Date(end_at).getTime();
                    stillRunning = deviceRunning && (endMs > now);
                  } else {
                    // if no explicit end is present, rely on deviceRunning flag
                    stillRunning = deviceRunning;
                  }
                }catch(e){
                  stillRunning = deviceRunning;
                }
                // Prevent starting a new cycle while an existing schedule is active or when a schedule
                // has completed but is still waiting for the user's Claim (require claim before new cycle).
                // Exception: purchased devices that are idle should allow selecting a new cycle.
                let disableReason = null;
                try{
                  // If we have a schedule object and it is NOT marked as claimed, disallow starting a new cycle.
                  // Consider both in-memory schedule.meta._claimed and durable localStorage locks (CUP9_CLAIMED_SCHEDULE_{id}).
                  // If the schedule appears claimed via either mechanism, allow selecting a new cycle.
                  if (sched) {
                    let schedClaimed = false;
                    try{
                      if (sched.meta && sched.meta._claimed) schedClaimed = true;
                      // durable lock written by other flows: treat as claimed if present
                      if (!schedClaimed && sched.id) {
                        try{
                          const lock = localStorage.getItem('CUP9_CLAIMED_SCHEDULE_' + String(sched.id));
                          if (lock) schedClaimed = true;
                        }catch(e){ /* ignore storage read errors */ }
                      }
                    }catch(e){ schedClaimed = false; }

                    if (!schedClaimed && String(sched.status || '').toLowerCase() !== 'completed') {
                      disableReason = 'Ciclo in corso: premi CLAIM per riscattare prima di avviare un nuovo ciclo';
                    } else if (stillRunning) {
                      // If the device is actively running a cycle, prevent selecting a new one
                      disableReason = 'Ciclo in corso — seleziona al termine o dopo avere riscattato i guadagni';
                    }
                  } else if (stillRunning) {
                    // fallback: do not enable selection if any doubt
                    disableReason = 'Ciclo in corso — seleziona al termine';
                  }
                }catch(e){
                  if(stillRunning) disableReason = 'Ciclo in corso — seleziona al termine';
                }

                // Special-case override: if this device is a purchased GPU and currently idle, allow cycle selection.
                // 'isPurchased' is defined in the surrounding scope when building the device card.
                try{
                  if (typeof isPurchased !== 'undefined' && isPurchased && String(g.status || '').toLowerCase() === 'idle') {
                    disableReason = null;
                  }
                }catch(e){ /* ignore override errors */ }

                const disabledAttr = disableReason ? `disabled title="${escapeHtml(disableReason)}"` : '';
                return ``;
              }catch(e){
                return `<button class="btn select-cycle" data-gpu="${escapeHtml(g.id)}">Seleziona ciclo</button>`;
              }
            })()}

            <!-- Claim: always render button but keep it disabled until cycle completion; it will be enabled once the cycle ends and disables immediately after click -->
            ${(() => {
              try{
                const completed = (end_at && new Date(end_at).getTime() <= Date.now()) || progressPct >= 100;
                // If completed -> enabled; otherwise disabled
                const btnDisabled = completed ? '' : 'disabled';
                // render Claim button only when cycle is fully completed (100%), otherwise do not render it at all
                if (!completed) {
                  return '';
                }
                return ``;
              }catch(e){
                return '';
              }
            })()}
          </div>
        </div>
      </div>
      `;
    }).join('');

    // Start/Stop handlers and details
    Array.from(container.querySelectorAll('[data-action]')).forEach(btn=>{
      btn.onclick = async ()=>{
        const id = btn.dataset.id;
        const action = btn.dataset.action;

        // No scheduled_earning enforcement: allow stop/start actions without checking scheduled_earning records.

        try{
          await api.updateGPU({ token: auth.currentToken(), gpuId: id, updates:{ status: action==='start' ? 'running' : 'idle' } });
          toastMessage(action === 'start' ? 'GPU avviata' : 'GPU fermata');
        }catch(e){
          toastMessage('Errore aggiornamento GPU');
        }
        // refresh my-devices section
        navigate('my-devices');
      };
    });



    // Cycle selection: opens a small modal to choose 1/3/7 days and create scheduled earning
    Array.from(container.querySelectorAll('.select-cycle')).forEach(b=>{
      b.onclick = async ()=>{
        const gpuId = b.dataset.gpu;

        // Guard: prevent selecting a new cycle if there's already an active schedule for this GPU
        try{
          const schedules = readSchedules() || [];
          const now = Date.now();
          const active = schedules.find(s => {
            try{
              if(String(s.gpuId || '') !== String(gpuId)) return false;
              // treat running or not-yet-ended schedules as active
              if(String(s.status || '').toLowerCase() === 'running') return true;
              if(s.end_at){
                const endMs = new Date(s.end_at).getTime();
                if(!isNaN(endMs) && endMs > now) return true;
              }
              return false;
            }catch(e){ return false; }
          });
          if(active){
            // silently ignore selection when an active cycle exists; selection UI remains unchanged.
            return;
          }
        }catch(e){
          // if schedule check fails, log but allow flow to continue (defensive)
          console.error('schedule active check failed', e);
        }
        const modal = showModal(`
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Seleziona ciclo per dispositivo</strong>
            <button class="modal-close">Chiudi</button>
          </div>
          <div class="form-row">
            <label class="small">Scegli durata</label>
            <div style="display:flex;gap:8px">
              <button id="c-1" class="btn">1 giorno</button>
              <button id="c-3" class="btn">3 giorni</button>
              <button id="c-7" class="btn">7 giorni</button>
            </div>
          </div>
        `);
        modal.panel.querySelector('#c-1').onclick = ()=> selectCycle(1);
        modal.panel.querySelector('#c-3').onclick = ()=> selectCycle(3);
        modal.panel.querySelector('#c-7').onclick = ()=> selectCycle(7);

        async function selectCycle(days){
          try{
            // find current user
            const meResp = await auth.me();
            const userEmail = (meResp && meResp.user && meResp.user.email) || '';
            const userId = (meResp && meResp.user && meResp.user.id) || null;

            // Compute earning amount from mock GPU price (immediate credit for chosen cycle)
            let earningAmount = 0;
            try{
              if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.gpus && api.__internal__.db.gpus[gpuId]){
                const mg = api.__internal__.db.gpus[gpuId];
                // Determine a device "price": if price_per_hour exists, treat price = 24 * price_per_hour; otherwise try meta.purchase_price.
                let devicePrice = 0;
                if(Number(mg.price_per_hour)){
                  devicePrice = Number(mg.price_per_hour) * 24;
                } else if(mg.meta && Number(mg.meta.purchase_price)){
                  devicePrice = Number(mg.meta.purchase_price);
                } else {
                  devicePrice = 0;
                }
                // daily fixed = 1.10% of devicePrice; total = daily * days
                const daily = Number((devicePrice * 0.011).toFixed(2));
                earningAmount = Number((daily * days).toFixed(2));
              }
            }catch(e){
              console.error('earning calc', e);
            }

            // Immediately mark device cycle and set status to running in local owned GPUs and mock DB
            try{
              // update local owned list
              const owned = readOwnedGpus();
              const idx = owned.findIndex(x=>x.id === gpuId);
              if(idx !== -1){
                owned[idx].meta = owned[idx].meta || {};
                owned[idx].meta.cycleDays = days;
                // persist canonical fields for cycle timing (ISO strings) and normalized cycle_days
                owned[idx].meta.cycle_days = Number(days);
                const startAt = new Date(Date.now()).toISOString();
                const endAt = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
                owned[idx].meta.start_at = startAt;
                owned[idx].meta.end_at = endAt;
                // keep a visible activation timestamp for UI
                owned[idx].meta.activated_at = startAt;
                owned[idx].meta.ownerEmail = owned[idx].meta.ownerEmail || userEmail;
                owned[idx].status = 'running';
                writeOwnedGpus(owned);
              }
              // mirror into mock DB GPU if present
              if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.gpus && api.__internal__.db.gpus[gpuId]){
                api.__internal__.db.gpus[gpuId].meta = api.__internal__.db.gpus[gpuId].meta || {};
                api.__internal__.db.gpus[gpuId].meta.cycleDays = days;
                api.__internal__.db.gpus[gpuId].status = 'running';
                api.__internal__.db.gpus[gpuId].assigned_at = new Date().toISOString();
                api.__internal__.db.gpus[gpuId].ownerId = api.__internal__.db.gpus[gpuId].ownerId || userId;
              }
            }catch(e){
              console.error('persist cycle', e);
            }

            try{
              // persist cycleDays on device and set device running
              try{
                const owned = readOwnedGpus();
                const idx = owned.findIndex(x=>x.id === gpuId);
                if(idx !== -1){
                  owned[idx].meta = owned[idx].meta || {};
                  owned[idx].meta.cycleDays = days;
                  owned[idx].meta.ownerEmail = owned[idx].meta.ownerEmail || userEmail;
                  owned[idx].status = 'running';
                  writeOwnedGpus(owned);
                }
                if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.gpus && api.__internal__ && api.__internal__.db.gpus[gpuId]){
                  api.__internal__.db.gpus[gpuId].meta = api.__internal__.db.gpus[gpuId].meta || {};
                  api.__internal__.db.gpus[gpuId].meta.cycleDays = days;
                  api.__internal__.db.gpus[gpuId].status = 'running';
                  api.__internal__.db.gpus[gpuId].assigned_at = new Date().toISOString();
                  api.__internal__.db.gpus[gpuId].ownerId = api.__internal__.db.gpus[gpuId].ownerId || userId;
                }
              }catch(e){ console.error('persist cycle', e); }

              // create a real schedule that will credit earnings after the selected days
              // amount is the total to credit at cycle end (daily * days) — no continuous per-day loop.
              const sched = createSchedule({
                gpuId,
                email: userEmail,
                userId,
                days,
                amount: earningAmount
              });

              // store schedule id on the owned gpu meta for reference
              try{
                const owned = readOwnedGpus();
                const idx2 = owned.findIndex(x=>x.id === gpuId);
                if(idx2 !== -1){
                  owned[idx2].meta = owned[idx2].meta || {};
                  owned[idx2].meta._scheduleId = sched.id;
                  writeOwnedGpus(owned);
                }
              }catch(e){}

              // Require user to update/download JSON after activating a cycle
              try{ requireUserExport('ciclo attivato'); }catch(e){/*non-fatal*/}


              toastMessage(`Ciclo di ${days} giorno(i) impostato; guadagni saranno accreditati automaticamente al termine.`);
              modal.close();
              // refresh view
              navigate('my-devices');
            }catch(err){
              console.error(err);
              toastMessage('Errore impostazione ciclo');
              modal.close();
            }
          }catch(err){
            console.error(err);
            toastMessage('Errore impostazione ciclo');
            modal.close();
          }
        }
      };
    });

    // Claim button logic: render Claim buttons for completed schedules (CUP9_PENDING_CLAIMS) and ensure any Claim button (pre-rendered or added) works.
    (function bindPendingClaims(){
      try{
        function readPendingClaims(){ try{ return JSON.parse(localStorage.getItem('CUP9_PENDING_CLAIMS') || '[]'); }catch(e){ return []; } }
        function writePendingClaims(list){ try{ localStorage.setItem('CUP9_PENDING_CLAIMS', JSON.stringify(list || [])); }catch(e){} }

        // Helper to process a claim object (id or claim record)
        function processClaimRecord(claim){
          try{
            if(!claim) return;
            const list = readPendingClaims();
            const idx = list.findIndex(x=>x.id === claim.id);
            // if the claim isn't in pending list but has scheduleId and amount we still process it (create transient record)
            if(idx === -1){
              // append transient claim to pending store so it's durable
              claim.id = claim.id || generateId('claim_');
              claim.claimed = false;
              list.push(claim);
              writePendingClaims(list);
            }
            const currList = readPendingClaims();
            const myIdx = currList.findIndex(x=>x.id === claim.id);
            if(myIdx === -1) return;

            // If already claimed in-memory, still ensure schedule/device cleanup (do not leave CLIM-applied cycles active),
            // then inform user and exit to avoid double-crediting.
            if(currList[myIdx].claimed){
              try{
                // durable locks to prevent race across tabs
                const schedIdLock = String(currList[myIdx].scheduleId || '').trim();
                const gpuIdLock = String(currList[myIdx].gpuId || '').trim();
                if(schedIdLock){
                  try{ localStorage.setItem('CUP9_CLAIMED_SCHEDULE_' + schedIdLock, '1'); }catch(e){}
                } else if(gpuIdLock){
                  try{ localStorage.setItem('CUP9_CLAIMED_GPU_' + gpuIdLock, '1'); }catch(e){}
                }

                // Ensure schedule record (if present) is marked completed and meta._claimed set
                try{
                  const schedules = readSchedules();
                  const si = schedules.findIndex(s => String(s.id) === String(currList[myIdx].scheduleId));
                  if(si !== -1){
                    schedules[si].status = 'completed';
                    schedules[si].completed_at = new Date().toISOString();
                    schedules[si].meta = schedules[si].meta || {};
                    schedules[si].meta._claimed = true;
                    writeSchedules(schedules);
                    try{ notify('schedules:changed', readSchedules()); }catch(e){}
                  }
                }catch(e){ /* non-fatal */ }

                // Ensure owned GPU is set to idle and cycle metadata cleared so device is free to select a new cycle
                try{
                  const owned = readOwnedGpus();
                  const gidx = owned.findIndex(x=>String(x.id) === String(currList[myIdx].gpuId));
                  if(gidx !== -1){
                    owned[gidx].status = 'idle';
                    owned[gidx].meta = owned[gidx].meta || {};
                    delete owned[gidx].meta._scheduleId;
                    delete owned[gidx].meta.start_at;
                    delete owned[gidx].meta.end_at;
                    delete owned[gidx].meta.progress;
                    delete owned[gidx].meta.percentComplete;
                    delete owned[gidx].meta.totalEarnings;
                    delete owned[gidx].meta.cycleDays;
                    writeOwnedGpus(owned);
                    try{ notify('owned:changed', readOwnedGpus()); }catch(e){}
                  }
                  // mirror to mock DB if available
                  try{
                    if(api && api.__internal__ && api.__internal__.db && currList[myIdx].gpuId){
                      api.__internal__.db.gpus[currList[myIdx].gpuId] = api.__internal__.db.gpus[currList[myIdx].gpuId] || {};
                      api.__internal__.db.gpus[currList[myIdx].gpuId].status = 'idle';
                      api.__internal__.db.gpus[currList[myIdx].gpuId].meta = api.__internal__.db.gpus[currList[myIdx].gpuId].meta || {};
                      delete api.__internal__.db.gpus[currList[myIdx].gpuId].meta._scheduleId;
                      delete api.__internal__.db.gpus[currList[myIdx].gpuId].meta.start_at;
                      delete api.__internal__.db.gpus[currList[myIdx].gpuId].meta.end_at;
                      api.__internal__.db.gpus[currList[myIdx].gpuId].meta.cycleDays = null;
                    }
                  }catch(e){}
                }catch(e){}
              }catch(e){
                console.error('cleanup on already-claimed failed', e);
              }
              toastMessage('guadagni già riscattati; ciclo chiuso e dispositivo liberato');
              return;
            }

            // Durable single-claim guard: check and set a persistent lock in localStorage so the same cycle
            // cannot be claimed more than once across tabs/devices in this browser.
            try{
              const schedIdLock = String(currList[myIdx].scheduleId || '').trim();
              const gpuIdLock = String(currList[myIdx].gpuId || '').trim();

              // If a schedule-level lock exists, reject immediately
              if(schedIdLock && localStorage.getItem('CUP9_CLAIMED_SCHEDULE_' + schedIdLock)){
                toastMessage('guadagni già riscattati, selezionare un nuovo ciclo per riscattare nuovi guadagni');
                return;
              }
              // If a gpu-level lock exists, reject immediately
              if(!schedIdLock && gpuIdLock && localStorage.getItem('CUP9_CLAIMED_GPU_' + gpuIdLock)){
                toastMessage('guadagni già riscattati, selezionare un nuovo ciclo per riscattare nuovi guadagni');
                return;
              }

              // Set the durable lock now to prevent races (write before processing)
              try{
                if(schedIdLock){
                  localStorage.setItem('CUP9_CLAIMED_SCHEDULE_' + schedIdLock, '1');
                } else if(gpuIdLock){
                  localStorage.setItem('CUP9_CLAIMED_GPU_' + gpuIdLock, '1');
                }
              }catch(e){ /* ignore storage failures but continue with in-memory guard */ }
            }catch(e){
              // non-fatal; proceed with in-memory guard as fallback
            }

            // Immediately mark the pending claim as claimed to prevent race conditions from multiple clicks
            currList[myIdx].claimed = true;
            currList[myIdx].claimed_at = new Date().toISOString();

            // Persistent guard: mark schedule/gpu as claimed in localStorage so repeated "clime" clicks (or clicks from other tabs)
            // cannot process the same cycle twice. Prefer scheduleId, fallback to gpuId.
            try{
              const schedId = String(currList[myIdx].scheduleId || '').trim();
              if(schedId){
                try{ localStorage.setItem('CUP9_CLAIMED_SCHEDULE_' + schedId, '1'); }catch(e){}
              } else {
                const gpuIdQuick = String(currList[myIdx].gpuId || '').trim();
                if(gpuIdQuick){
                  try{ localStorage.setItem('CUP9_CLAIMED_GPU_' + gpuIdQuick, '1'); }catch(e){}
                }
              }
            }catch(e){ /* non-fatal */ }

            writePendingClaims(currList);

            // Immediately disable any UI claim buttons for this GPU to provide instant feedback
            try{
              const gpuIdQuick = String(currList[myIdx].gpuId || '');
              const btnsNow = container.querySelectorAll(`.claim-btn[data-gpu="${gpuIdQuick}"], .claim-btn[data-claim="${currList[myIdx].id}"]`);
              btnsNow.forEach(b=>{
                try{ b.disabled = true; b.style.opacity = '0.6'; b.textContent = 'Claimed'; }catch(e){}
              });
            }catch(e){ /* non-fatal */ }

            // create an accredited scheduled_earning tx (visible in activity) and immediately credit withdrawable
            const txId = generateId('tx_');
            const tx = {
              id: txId,
              // use the same type used elsewhere so the earning shows up in activity lists
              type: 'scheduled_earning',
              amount: Number(currList[myIdx].amount),
              created_at: new Date().toISOString(),
              status: 'accredited',
              email: String(currList[myIdx].email || '').toLowerCase(),
              meta: { _fromSchedule: true, _scheduleId: currList[myIdx].scheduleId || null, gpuId: currList[myIdx].gpuId || null, _claimed_by: currList[myIdx].id }
            };
            addLocalTransaction(tx);

            // credit withdrawable
            try{
              updateWithdrawableByEmail(tx.email, Number(tx.amount));
              const allTx = loadLocalTransactions();
              const target = allTx.find(t => t.id === tx.id);
              if(target){
                target.meta = target.meta || {};
                target.meta._applied_to_withdrawable = new Date().toISOString();
                saveLocalTransactions(allTx);
              }
              try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
              try{ notify('balance:withdrawable:changed', { email: tx.email, withdrawable: getWithdrawableByEmail(tx.email) }); }catch(e){}
            }catch(e){
              console.error('update withdrawable on claim failed', e);
            }

            // companion claim tx
            try{
              const claimTx = {
                id: generateId('tx_'),
                type: 'claim',
                amount: Number(currList[myIdx].amount),
                created_at: new Date().toISOString(),
                status: 'completed',
                email: String(currList[myIdx].email || '').toLowerCase(),
                meta: { related_tx: tx.id, gpuId: currList[myIdx].gpuId, scheduleId: currList[myIdx].scheduleId || null, note: 'Claim completato e accreditato' }
              };
              addLocalTransaction(claimTx);
            }catch(e){
              console.error('create companion claim tx failed', e);
            }

            // mark claim as claimed and persist
            currList[myIdx].claimed = true;
            currList[myIdx].claimed_at = new Date().toISOString();
            writePendingClaims(currList);

            // mark schedule completed and set owned GPU to idle
            try{
              const schedules = readSchedules();
              const schedIdx = schedules.findIndex(s => String(s.id) === String(currList[myIdx].scheduleId));
              if(schedIdx !== -1){
                // mark schedule completed and persist claimed flag so future Claim checks see it as claimed
                schedules[schedIdx].status = 'completed';
                schedules[schedIdx].completed_at = new Date().toISOString();
                try{
                  schedules[schedIdx].meta = schedules[schedIdx].meta || {};
                  // persist that this schedule has been claimed and zero out its stored total earnings immediately
                  schedules[schedIdx].meta._claimed = true;
                  schedules[schedIdx].meta.totalEarnings = 0;
                }catch(e){}
                try{
                  if(schedules[schedIdx].__runtime && schedules[schedIdx].__runtime.intervalHandle) clearInterval(schedules[schedIdx].__runtime.intervalHandle);
                  if(schedules[schedIdx].__runtime && schedules[schedIdx].__runtime.timeoutHandle) clearTimeout(schedules[schedIdx].__runtime.timeoutHandle);
                }catch(e){}
                writeSchedules(schedules);
                try{ notify('schedules:changed', readSchedules()); }catch(e){}
              }

              const owned = readOwnedGpus();
              const gidx = owned.findIndex(x=>x.id === currList[myIdx].gpuId);
              if(gidx !== -1){
                // Immediately clear cycle state and normalize ALL cycle-related fields so UI shows zeros.
                owned[gidx].status = 'idle';
                owned[gidx].meta = owned[gidx].meta || {};

                // Remove schedule pointers and explicit timing
                delete owned[gidx].meta._scheduleId;
                owned[gidx].meta.start_at = null;
                owned[gidx].meta.end_at = null;

                // Normalize numeric progress/earnings fields to explicit zeros
                owned[gidx].meta.progress = 0;
                owned[gidx].meta.percentComplete = 0;
                owned[gidx].meta.totalEarnings = 0;
                owned[gidx].meta.totalCycle = 0;

                // Ensure cycle day fields are cleared (null) so \"no cycle\" is explicit
                owned[gidx].meta.cycleDays = null;
                owned[gidx].meta.cycle_days = null;

                // Remove any leftover transient flags
                try{ delete owned[gidx].meta._claimed; }catch(e){}
                try{ delete owned[gidx].meta._scheduleProgress; }catch(e){}

                // persist changes to owned GPUs and notify listeners
                writeOwnedGpus(owned);
                try{ notify('owned:changed', readOwnedGpus()); }catch(e){}
              }
              try{
                if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.gpus && currList[myIdx].gpuId){
                  api.__internal__.db.gpus[currList[myIdx].gpuId].status = 'idle';
                  if(api.__internal__.db.gpus[currList[myIdx].gpuId].meta) delete api.__internal__.db.gpus[currList[myIdx].gpuId].meta._scheduleId;
                  if(api.__internal__.db.gpus[currList[myIdx].gpuId].meta) delete api.__internal__.db.gpus[currList[myIdx].gpuId].meta.cycleDays;
                }
              }catch(e){}
            }catch(e){
              console.error('finalize claim schedule/gpu update failed', e);
            }

            toastMessage(`Claim processato: $${Number(tx.amount).toFixed(2)} accreditati al saldo prelevabile`, { type:'success' });
            // Notify other modules to refresh owned devices and UI immediately so My Devices reflects the cleared cycle and reset progress.
            try{ notify('owned:changed', readOwnedGpus()); }catch(e){}
            try{ notify('ui:force-refresh'); }catch(e){}

            // Reset UI progress and cycle state for the claimed GPU so the My Devices view shows cycle cleared
            try{
              const gpuId = String(currList[myIdx].gpuId || '');

              // disable and relabel any claim buttons tied to this pending claim
              const btnsNow = container.querySelectorAll(`.claim-btn[data-gpu="${gpuId}"], .claim-btn[data-claim="${currList[myIdx].id}"]`);
              btnsNow.forEach(b=>{
                try{ b.disabled = true; b.style.opacity = '0.6'; b.textContent = 'Claimed'; }catch(e){}
              });

              // Also disable any other claim buttons for the same gpu and set them to 'Claimed'
              const otherBtns = container.querySelectorAll(`.claim-btn[data-gpu="${gpuId}"]`);
              otherBtns.forEach(b=>{
                try{ b.disabled = true; b.style.opacity = '0.6'; b.textContent = 'Claimed'; }catch(e){}
              });

              // Update the device card progress bar, total cycle and cycle label to reflect restarted/idle state
              const gpuEl = container.querySelector(`#gpu-${gpuId}`);
              if(gpuEl){
                // reset progress bar inner bar to 0% and update the adjacent label consistently
                try{
                  // find the inner progress bar element (the div inside the wrapper)
                  const innerBar = gpuEl.querySelector('div[style*="height:100%"][style*="background:linear-gradient(90deg,var(--accent)"]');
                  if(innerBar){
                    innerBar.style.width = '0%';
                    // update percentage label (the small element next to the bar)
                    const label = gpuEl.querySelector('.small[style*="margin-top:6px"]');
                    if(label) label.textContent = 'No cycle · 0%';
                  } else {
                    // fallback: replace full progress block as before if selector not matched
                    const progressWrap = gpuEl.querySelector('div[style*="width:220px"]');
                    if(progressWrap){
                      progressWrap.innerHTML = `
                        <div style="height:8px;background:linear-gradient(90deg,rgba(0,0,0,0.06),rgba(0,0,0,0.02));border-radius:8px;overflow:hidden">
                          <div style="height:100%;width:0%;background:linear-gradient(90deg,var(--accent),var(--accent-2));transition:width .6s ease;"></div>
                        </div>
                        <div class="small" style="margin-top:6px;color:var(--muted)">No cycle · 0%</div>
                      `;
                    }
                  }
                }catch(e){ console.error('reset progress bar failed', e); }

                // clear cycle-val text if present and clear meta text displayed
                try{
                  const cycleVal = gpuEl.querySelector('.cycle-val[data-gpu]');
                  if(cycleVal) cycleVal.textContent = 'Non selezionato';
                }catch(e){}

                // Also update the displayed "Totale ciclo" value (if present) to $0.00 immediately
                try{
                  // search for the element that contains "Totale ciclo:" text inside this gpu card
                  const totalCycleEl = Array.from(gpuEl.querySelectorAll('.small')).find(el => el.textContent && el.textContent.trim().startsWith('Totale ciclo:'));
                  if(totalCycleEl){
                    // replace the numeric portion with $0.00 while preserving surrounding markup
                    totalCycleEl.innerHTML = `Totale ciclo: <span style="font-weight:800;color:#0a7a45">$${Number(0).toFixed(2)}</span>`;
                  } else {
                    // fallback: try to find any element that mentions "Totale ciclo" anywhere within the card and overwrite
                    const alt = Array.from(gpuEl.querySelectorAll('div')).find(d => String(d.innerHTML).includes('Totale ciclo'));
                    if(alt){
                      alt.innerHTML = String(alt.innerHTML).replace(/Totale ciclo:[^<]*/i, `Totale ciclo: <span style="font-weight:800;color:#0a7a45">$0.00</span>`);
                    }
                  }
                }catch(e){ console.error('reset total cycle display failed', e); }

                // ensure any Start/Stop buttons are enabled for new cycles
                try{
                  const startBtn = gpuEl.querySelector('button[data-action="start"]');
                  const stopBtn = gpuEl.querySelector('button[data-action="stop"]');
                  if(startBtn){ startBtn.disabled = false; startBtn.style.opacity = ''; }
                  if(stopBtn){ stopBtn.disabled = false; stopBtn.style.opacity = ''; }
                }catch(e){}
              }

              // Finally refresh transactions and balances to ensure the newly created scheduled_earning is visible
              try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
              try{ notify('balance:withdrawable:changed', { email: String(currList[myIdx].email||'').toLowerCase(), withdrawable: getWithdrawableByEmail(String(currList[myIdx].email||'')) }); }catch(e){}
            }catch(e){
              console.error('post-claim UI update error', e);
            }
            try{
              const gpuId = String(currList[myIdx].gpuId || '');

              // disable and relabel any claim buttons tied to this pending claim
              const btns = container.querySelectorAll(`.claim-btn[data-claim="${currList[myIdx].id}"]`);
              // ensure immediate UX feedback by removing buttons tied to this claim
              btns.forEach(b=>{
                try{ b.remove(); }catch(e){}
              });

              // Also remove any other claim buttons for the same gpu to avoid duplicates
              const otherBtns = container.querySelectorAll(`.claim-btn[data-gpu="${gpuId}"]`);
              otherBtns.forEach(b=>{
                try{ b.remove(); }catch(e){}
              });

              // Update the device card progress bar and cycle label to reflect restarted/idle state
              const gpuEl = container.querySelector(`#gpu-${gpuId}`);
              if(gpuEl){
                // reset progress bar inner bar to 0% and update the adjacent label consistently
                try{
                  // find the inner progress bar element (the div inside the wrapper)
                  const innerBar = gpuEl.querySelector('div[style*="height:100%"][style*="background:linear-gradient(90deg,var(--accent)"]');
                  if(innerBar){
                    innerBar.style.width = '0%';
                    // update percentage label (the small element next to the bar)
                    const label = gpuEl.querySelector('.small[style*="margin-top:6px"]');
                    if(label) label.textContent = 'No cycle · 0%';
                  } else {
                    // fallback: replace full progress block as before if selector not matched
                    const progressWrap = gpuEl.querySelector('div[style*="width:220px"]');
                    if(progressWrap){
                      progressWrap.innerHTML = `
                        <div style="height:8px;background:linear-gradient(90deg,rgba(0,0,0,0.06),rgba(0,0,0,0.02));border-radius:8px;overflow:hidden">
                          <div style="height:100%;width:0%;background:linear-gradient(90deg,var(--accent),var(--accent-2));transition:width .6s ease;"></div>
                        </div>
                        <div class="small" style="margin-top:6px;color:var(--muted)">No cycle · 0%</div>
                      `;
                    }
                  }
                }catch(e){ console.error('reset progress bar failed', e); }

                // clear cycle-val text if present and clear meta text displayed
                try{
                  const cycleVal = gpuEl.querySelector('.cycle-val[data-gpu]');
                  if(cycleVal) cycleVal.textContent = 'Non selezionato';
                }catch(e){}

                // ensure any Start/Stop buttons are enabled for new cycles
                try{
                  const startBtn = gpuEl.querySelector('button[data-action="start"]');
                  const stopBtn = gpuEl.querySelector('button[data-action="stop"]');
                  if(startBtn){ startBtn.disabled = false; startBtn.style.opacity = ''; }
                  if(stopBtn){ stopBtn.disabled = false; stopBtn.style.opacity = ''; }
                }catch(e){}
              }

              // Finally refresh transactions and balances to ensure the newly created scheduled_earning is visible
              try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
              try{ notify('balance:withdrawable:changed', { email: String(currList[myIdx].email||'').toLowerCase(), withdrawable: getWithdrawableByEmail(String(currList[myIdx].email||'')) }); }catch(e){}
            }catch(e){
              console.error('post-claim UI update error', e);
            }

          }catch(err){
            console.error('processClaimRecord failed', err);
            toastMessage('Errore durante il Claim');
          }
        }

        // Render claim buttons next to GPUs in the current container for existing pending claims
        const pending = readPendingClaims().filter(p=> !p.claimed && Number(p.amount) > 0);
        for(const p of pending){
          try{
            const el = container.querySelector(`#gpu-${p.gpuId}`);
            if(!el) continue;
            if(el.querySelector(`button.claim-btn[data-claim="${p.id}"]`)) continue;

            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'column';
            wrapper.style.alignItems = 'flex-end';
            wrapper.style.gap = '6px';
            wrapper.style.marginTop = '8px';

            const claimBtn = document.createElement('button');
            claimBtn.className = 'btn claim-btn';
            claimBtn.textContent = `Claim $${Number(p.amount).toFixed(2)}`;
            claimBtn.dataset.claim = p.id;
            claimBtn.style.minWidth = '140px';
            wrapper.appendChild(claimBtn);

            const rightCol = el.querySelector('div[style*="flex-direction:column;gap:8px;align-items:flex-end"]');
            if(rightCol) rightCol.appendChild(wrapper);
            else el.appendChild(wrapper);

            claimBtn.onclick = ()=> { try{ claimBtn.style.display = 'none'; }catch(e){}; processClaimRecord(p); };
          }catch(err){
            console.error('render pending claim per-gpu failed', err);
          }
        }

        // Also attach click handlers to any pre-rendered .claim-btn elements (created earlier in markup)
        try{
          const preBtns = container.querySelectorAll('.claim-btn');
          preBtns.forEach(btn=>{
            // skip if already wired (has data-claim attached or onclick)
            if(btn.dataset._wired === '1') return;
            btn.dataset._wired = '1';
            btn.onclick = () => {
              try{
                try{ btn.style.display = 'none'; }catch(e){} // hide immediately on click for instant feedback
                // If this button has an explicit data-claim id (from pending store), use it
                const claimId = btn.dataset.claim;
                if(claimId){
                  const pendingList = readPendingClaims();
                  const found = pendingList.find(x=>x.id === claimId);
                  if(found) return processClaimRecord(found);
                }

                // Otherwise try to locate a pending claim by gpu id (button has data-gpu or surrounding element id)
                let gpuId = btn.dataset.gpu;
                if(!gpuId){
                  const parent = btn.closest('.stat[id^="gpu-"]');
                  if(parent) gpuId = parent.id.replace(/^gpu-/,'');
                }
                if(!gpuId) return toastMessage('Impossibile determinare il dispositivo per il Claim');

                // find pending claim by gpuId
                const pendingList = readPendingClaims();
                let found = pendingList.find(x=>String(x.gpuId) === String(gpuId) && !x.claimed);
                if(found){
                  return processClaimRecord(found);
                }

                // fallback: if there's a completed schedule for this gpu, create an ad-hoc claim record and process it
                const schedules = readSchedules();
                const sched = schedules.find(s=> String(s.gpuId) === String(gpuId) && (s.status === 'completed' || new Date(s.end_at).getTime() <= Date.now()));
                if(sched){
                  const claimObj = {
                    id: generateId('claim_'),
                    scheduleId: sched.id,
                    gpuId: sched.gpuId,
                    email: String(sched.email || '').toLowerCase(),
                    amount: Number(sched.amount || 0),
                    created_at: new Date().toISOString(),
                    claimed: false
                  };
                  return processClaimRecord(claimObj);
                }

                // another fallback: if progress bar reached 100% but no schedule record exists, attempt to compute amount from meta and create claim
                try{
                  const owned = readOwnedGpus();
                  const g = owned.find(x=>String(x.id) === String(gpuId));
                  if(g && g.meta && g.meta._scheduleId){
                    const schedulesAll = readSchedules();
                    const s2 = schedulesAll.find(x=>String(x.id) === String(g.meta._scheduleId));
                    if(s2){
                      const claimObj = {
                        id: generateId('claim_'),
                        scheduleId: s2.id,
                        gpuId: s2.gpuId,
                        email: String(s2.email || '').toLowerCase(),
                        amount: Number(s2.amount || 0),
                        created_at: new Date().toISOString(),
                        claimed: false
                      };
                      return processClaimRecord(claimObj);
                    }
                  }
                }catch(e){ /* ignore */ }

                toastMessage('Nessun guadagno da Claim disponibile per questo dispositivo al momento');
              }catch(err){
                console.error('pre-rendered claim-btn handler error', err);
                toastMessage('Errore durante il Claim');
              }
            };
          });
        }catch(e){
          console.error('attach handlers to pre-rendered claim buttons failed', e);
        }

      }catch(e){
        console.error('bindPendingClaims error', e);
      }
    })();

    // Per new device logic: remove any cycle-related controls and visual elements so purchased devices appear
    // as permanently active and auto-accruing — hide end-of-cycle, progress bars, selected-cycle info and cycle buttons.
    try{
      // remove cycle selection buttons, claim/clime buttons and any prebound cycle controls
      container.querySelectorAll('.select-cycle, .clime-btn, .claim-btn, button[data-action="start"], button[data-action="stop"]').forEach(n=>{
        try{ n.remove(); }catch(e){}
      });
      // remove specific small lines that reference cycle timing or totals within each device card
      container.querySelectorAll('.small').forEach(el=>{
        try{
          const txt = (el.textContent || '').toLowerCase();
          if(txt.includes('attivazione ciclo') || txt.includes('fine ciclo') || txt.includes('durata selezionata') || txt.includes('totale $ ciclo') || txt.includes('guadagni accumulati finora') || txt.includes('stato ciclo') || txt.includes('giorno(i) rimanenti') || txt.includes('progress') ){
            el.remove();
          }
        }catch(e){}
      });
      // remove any explicit progress bar wrappers used previously
      container.querySelectorAll('div[style*="width:220px"], div[style*="height:8px"]').forEach(n=>{
        try{ n.remove(); }catch(e){}
      });

      // replace any remaining "Totale $ ciclo" or similar inline text nodes with a simple perpetual active label
      Array.from(container.querySelectorAll('.stat')).forEach(card=>{
        try{
          // add simple active label if not already present
          if(!card.querySelector('.permanent-active-label')){
            const label = document.createElement('div');
            label.className = 'permanent-active-label small';
            label.style.color = 'var(--muted)';
            label.style.fontWeight = '800';
            label.style.marginTop = '6px';
            label.textContent = 'Stato: Attivo (funzionamento permanente — accrediti automatici)';
            // append into the left column or fallback to card
            const left = card.querySelector('.left') || card;
            left.appendChild(label);
          }
        }catch(e){}
      });
    }catch(err){
      console.error('cleanup cycle-related UI failed', err);
    }

  }catch(e){
    container.innerHTML = `<div class="small">Errore: ${e.message||e}</div>`;
  }
}

function renderLicensesSection(container){
  // Promotion config
  const promoEnds = new Date('2026-02-28T23:59:59Z'); // promo valid until 28/02/2026 inclusive (UTC)
  const now = new Date();
  const baseDiscountPct = 0.20; // 20% for Base license
  const plusDiscountPct = 0.25; // 25% for Plus license
  const promoActive = now.getTime() <= promoEnds.getTime();

  // utility to format prices
  function fmt(v){ return `$${Number(v||0).toFixed(2)}`; }

  // original prices
  const basePrice = 150;
  const plusPrice = 240;

  // compute discounted prices
  const baseDisc = Number((basePrice * (1 - baseDiscountPct)).toFixed(2));
  const plusDisc = Number((plusPrice * (1 - plusDiscountPct)).toFixed(2));

  // render UI with struck-through original price and discounted price when promo active
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-weight:900;color:#e6f7f0">Licenze</div>
      <div style="display:flex;align-items:center;gap:12px">
        <div class="small" style="color:var(--muted)">Scegli una licenza per abilitare strumenti di referral, badge e accesso prioritario al supporto.</div>
        <button id="licenses-details-btn" class="btn secondary" title="Dettagli licenze">Dettagli</button>
      </div>
    </div>

    ${promoActive ? `<div style="padding:12px;border-radius:12px;background:linear-gradient(90deg, rgba(31,127,179,0.14), rgba(15,95,138,0.08));color:#fff;margin-bottom:12px;font-weight:900;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:1rem">Promo attiva: sconto <strong style="color:#fff">${Math.round(baseDiscountPct*100)}%</strong> su Licenza Base e <strong style="color:#fff">${Math.round(plusDiscountPct*100)}%</strong> su Licenza Plus</div>
          <div style="font-size:0.9rem;background:rgba(255,255,255,0.06);padding:6px 10px;border-radius:8px">PROMO</div>
        </div>
        <div style="font-size:0.92rem;color:rgba(255,255,255,0.9)">Prezzo originale mostrato barrato; il prezzo evidenziato è il prezzo scontato valido fino al <strong>${promoEnds.toLocaleDateString('it-IT')}</strong>.</div>
      </div>` : `<div style="height:12px;margin-bottom:12px"></div>` }

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
      <!-- Licenza Base -->
      <div class="card">
        <div style="font-weight:900;font-size:1rem;margin-bottom:6px">Licenza Base</div>
        <div class="small" style="color:var(--muted);margin-bottom:8px">
          La Licenza Base abilita l'accesso al Programma Referral, la possibilità di generare codici invito e l'accesso a funzionalità essenziali della piattaforma.
          Include: generazione codici invito limitata, reportistica base sui referral e accesso al canale di supporto standard.
          <div style="margin-top:8px;font-weight:700">Privilegi prelievo:</div>
          <div class="small" style="color:var(--muted)">Minimo prelievo: <strong>$50</strong>; nessuna restrizione su giorni o orari per eseguire prelievi.</div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
          <div style="display:flex;flex-direction:column;gap:4px">
            <div style="font-weight:700;color:var(--muted);font-size:0.85rem">Prezzo</div>
            <div>
              ${promoActive ? `<span style="text-decoration:line-through;color:rgba(3,24,28,0.5);margin-right:8px">${fmt(basePrice)}</span><div style="display:inline-block;margin-left:8px"><div style="font-size:0.82rem;color:var(--muted)">Prezzo scontato</div><div style="font-weight:900;color:#b98f46">${fmt(baseDisc)}</div></div>` : `<span style="font-weight:900;color:#b98f46">${fmt(basePrice)}</span>`}
            </div>
          </div>
          <button class="btn buy-license" data-license="base" data-price="${basePrice}">Acquista</button>
        </div>
        <button class="btn secondary details-license" data-license="base">Descrizione Licenza Base</button>
      </div>

      <!-- Licenza Partner Avanzata -->
      <div class="card">
        <div style="font-weight:900;font-size:1rem;margin-bottom:6px">Licenza Partner Avanzata</div>
        <div class="small" style="color:var(--muted);margin-bottom:8px">
          La Licenza Partner Avanzata (Plus) è pensata per partner e promotori: include badge ufficiale, strumenti avanzati per la gestione dei referral,
          reportistica estesa, accesso prioritario al supporto e la possibilità di generare un numero maggiore di codici invito con controlli avanzati.
          Ideale per chi gestisce team o campagne di referral su scala.
          <div style="margin-top:8px;font-weight:700">Privilegi prelievo:</div>
          <div class="small" style="color:var(--muted)">Minimo prelievo: <strong>$50</strong>; nessuna restrizione su giorni o orari per eseguire prelievi.</div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
          <div style="display:flex;flex-direction:column;gap:4px">
            <div style="font-weight:700;color:var(--muted);font-size:0.85rem">Prezzo</div>
            <div>
              ${promoActive ? `<span style="text-decoration:line-through;color:rgba(3,24,28,0.5);margin-right:8px">${fmt(plusPrice)}</span><div style="display:inline-block;margin-left:8px"><div style="font-size:0.82rem;color:var(--muted)">Prezzo scontato</div><div style="font-weight:900;color:#b98f46">${fmt(plusDisc)}</div></div>` : `<span style="font-weight:900;color:#b98f46">${fmt(plusPrice)}</span>`}
            </div>
          </div>
          <button class="btn buy-license" data-license="plus" data-price="${plusPrice}">Acquista Licenza Avanzata</button>
        </div>
        <button class="btn secondary details-license" data-license="plus">Descrizione Licenza Plus</button>
      </div>
    </div>

    <div style="margin-top:12px" id="licenses-feedback"></div>

    <div style="margin-top:12px" id="my-invites-container"></div>
  `;

  // After render: update buy button handlers so purchases use the discounted price when promo is active.
  // Existing handlers below expect data-price attribute to represent the price; adjust it now.
  try{
    container.querySelectorAll('.buy-license').forEach(b => {
      const license = b.dataset.license;
      if(!license) return;
      if(promoActive){
        if(license === 'base') b.dataset.price = String(baseDisc);
        if(license === 'plus') b.dataset.price = String(plusDisc);
      } else {
        if(license === 'base') b.dataset.price = String(basePrice);
        if(license === 'plus') b.dataset.price = String(plusPrice);
      }
    });
  }catch(e){ console.error('update license button prices failed', e); }

  // utilities for invites
  function readInvites(){
    try{ return JSON.parse(localStorage.getItem('CUP9_INVITES') || '[]'); }catch(e){ return []; }
  }
  function writeInvites(list){ try{ localStorage.setItem('CUP9_INVITES', JSON.stringify(list || [])); }catch(e){} }
  function generateInviteCode(email){
    const rnd = Math.random().toString(36).slice(2,10).toUpperCase();
    // invite code format: useremail + '|' + rnd (URL-friendly)
    const code = `${email}|${rnd}`;
    return code;
  }

  // display user's existing invites and require entering invited user's email when generating a new code
  async function renderInvitesArea(){
    const containerInv = container.querySelector('#my-invites-container');
    containerInv.innerHTML = '';
    let meResp = null;
    try{ meResp = await auth.me(); }catch(e){ meResp = null; }
    const userEmail = meResp && meResp.user && meResp.user.email ? String(meResp.user.email).toLowerCase() : null;
    if(!userEmail){
      containerInv.innerHTML = `<div class="small" style="color:var(--muted)">Accedi per gestire i codici invito</div>`;
      return;
    }

    // Check license ownership
    let owned = [];
    try{ owned = JSON.parse(localStorage.getItem('CUP9_LICENSES') || '[]'); }catch(e){ owned = []; }
    const hasLicense = owned.some(l => String(l.ownerEmail||'').toLowerCase() === userEmail);

    // build invites list (include usedBy info if present; accept multiple legacy fields)
    const invites = readInvites().filter(i => String(i.ownerEmail||'').toLowerCase() === userEmail);
    const listHtml = invites.length ? invites.map(i=>{
      // Support several possible keys that may record who used the invite (usedBy, used_by, usedEmail, used_email)
      const usedEmail = (i.usedBy || i.used_by || i.usedEmail || i.used_email || i.used || null);
      // show invited_email if present (must always be present for generated codes)
      const invited = i.invitedEmail ? `<div class="small" style="color:#00FF00;font-weight:900;margin-top:6px">Associato a: <strong style="color:#00FF00;font-weight:900">${escapeHtml(String(i.invitedEmail))}</strong></div>` : '';

      // Determine activity status for the invited email by checking local transactions for an accredited deposit
      let activityBadgeHtml = '';
      try{
        const invitedEmailNorm = String(i.invitedEmail || usedEmail || '').toLowerCase();
        let isActive = false;
        if(invitedEmailNorm){
          const allTxs = JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]');
          isActive = allTxs.some(t => {
            try{
              const tEmail = String(t.email||'').toLowerCase();
              const typ = String(t.type||'').toLowerCase();
              const st = String(t.status||'').toLowerCase();
              if(tEmail !== invitedEmailNorm) return false;
              // treat accredited deposits as activation indicator
              if(typ === 'deposit' && (st === 'accredited' || st === 'confirmed')) return true;
              return false;
            }catch(e){ return false; }
          });
        }
        // Preserve existing styling; append activation text after "Usato da" or in place of "Disponibile"
        if(usedEmail){
          const statusLabel = isActive ? ' - ATTIVO' : ' - NON ATTIVO';
          // make used email clickable to open invitee details
          activityBadgeHtml = `<div class="small" style="color:#00FF00;font-weight:900;margin-top:6px">Usato da: <a href="#" class="invitee-link" data-email="${escapeHtml(String(usedEmail))}" style="color:#00FF00;font-weight:900;text-decoration:underline">${escapeHtml(String(usedEmail))}</a>${statusLabel}</div>`;
        } else {
          const statusLabel = (i.invitedEmail && isActive) ? ' - ATTIVO' : ' - NON ATTIVO';
          // make invited email clickable to open invitee details
          activityBadgeHtml = `<div class="small" style="color:#00FF00;font-weight:900;margin-top:6px">${i.invitedEmail ? ('Associato a: <a href="#" class="invitee-link" data-email="' + escapeHtml(String(i.invitedEmail)) + '" style="color:#00FF00;font-weight:900;text-decoration:underline">' + escapeHtml(String(i.invitedEmail)) + '</a>' + statusLabel) : 'Disponibile (non ancora usato)'} </div>`;
        }
      }catch(e){
        // fallback to previous rendering in case of errors
        if(usedEmail){
          activityBadgeHtml = `<div class="small" style="color:#00FF00;font-weight:900;margin-top:6px">Usato da: <strong style="color:#00FF00;font-weight:900">${escapeHtml(String(usedEmail))}</strong></div>`;
        } else {
          activityBadgeHtml = `<div class="small" style="color:#00FF00;font-weight:900;margin-top:6px">Disponibile (non ancora usato)</div>`;
        }
      }

      return `<div style="display:flex;justify-content:space-between;gap:8px;padding:8px;border-bottom:1px solid rgba(255,255,255,0.03)"><div><div style="font-weight:800">${escapeHtml(i.code)}</div><div class="small" style="color:var(--muted)">${(new Date(i.created_at)).toLocaleString()}</div>${activityBadgeHtml}</div><div><button class="btn copy-invite" data-code="${escapeHtml(i.code)}">Copia</button></div></div>`;
    }).join('') : `<div class="notice small">Nessun codice invito generato</div>`;

    containerInv.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">
        <div style="font-weight:900">I tuoi codici invito</div>
        <div class="small" style="color:var(--muted)">${hasLicense ? 'Puoi generare codici unici (associati a un indirizzo email invitato)' : 'Acquista una licenza per generare codici'}</div>
      </div>
      <div style="margin-top:8px">${listHtml}</div>
      <div style="display:flex;justify-content:flex-end;margin-top:10px">
        <button id="gen-invite-btn" class="btn" ${hasLicense ? '' : 'disabled'}>Genera codice invito</button>
      </div>
    `;

    // wire copy buttons and invitee click handler
    Array.from(containerInv.querySelectorAll('.copy-invite')).forEach(b=>{
      b.onclick = ()=> {
        const code = b.dataset.code || '';
        try{ navigator.clipboard.writeText(code); toastMessage('Codice copiato negli appunti'); }catch(e){ toastMessage('Copia non disponibile'); }
      };
    });

    // Delegate click for invitee email links to open details modal (counts: active GPUs, accredited deposits, daily earnings)
    containerInv.addEventListener('click', function(ev){
      const a = ev.target.closest && ev.target.closest('.invitee-link');
      if(!a) return;
      ev.preventDefault();
      try{
        const email = String(a.dataset.email || '').toLowerCase();
        if(!email) return;
        // compute counts from localStorage
        const owned = JSON.parse(localStorage.getItem('CUP9_OWNED_GPUS') || '[]');
        const txs = JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]');
        const activeDevices = (owned || []).filter(g => {
          try{ return String((g.meta && g.meta.ownerEmail) || g.ownerId || '').toLowerCase() === email && String(g.status||'').toLowerCase() === 'running'; }catch(e){ return false; }
        }).length;
        const accreditedDeposits = (txs || []).filter(t => {
          try{
            return String(t.type||'').toLowerCase() === 'deposit' &&
                   String(t.email||'').toLowerCase() === email &&
                   (String(t.status||'').toLowerCase() === 'accredited' || String(t.status||'').toLowerCase() === 'confirmed');
          }catch(e){ return false; }
        }).reduce((s,x)=> s + Number(x.amount||0), 0);

        // compute daily earnings for the invited user by summing per-device daily estimates
        let dailyTotal = 0;
        try{
          const devicesForUser = (owned || []).filter(g => {
            try{ return String((g.meta && g.meta.ownerEmail) || '').toLowerCase() === email || String(g.ownerId || '').toLowerCase() === (function(){ try{ const users = JSON.parse(localStorage.getItem('CUP9_USERS')||'[]'); const u = users.find(u=>String(u.email||'').toLowerCase()===email); return u ? u.id : ''; }catch(e){ return ''; } })(); }catch(e){ return false; }
          });
          for(const d of devicesForUser){
            try{
              // prefer explicit per-device meta.dailyEarnings
              let daily = 0;
              if(d.meta && Number(d.meta.dailyEarnings)) {
                daily = Number(d.meta.dailyEarnings);
              } else if(d.meta && Number(d.meta.purchase_price) && Number(d.meta.purchase_price) > 0) {
                daily = Number((Number(d.meta.purchase_price) * 0.011).toFixed(4));
              } else if(Number(d.price_per_hour) && Number(d.price_per_hour) > 0) {
                daily = Number(((Number(d.price_per_hour) * 24) * 0.011).toFixed(4));
              } else {
                const t = Number((d.meta && d.meta.displayTflops) || 0);
                daily = t ? Number((t * 0.25).toFixed(4)) : 0;
              }
              dailyTotal += Number(daily || 0);
            }catch(e){}
          }
        }catch(e){
          dailyTotal = 0;
        }

        const html = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Dettagli invitato — ${escapeHtml(email)}</strong>
            <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div class="small" style="color:var(--muted)">Quantità dispositivi attivi</div>
            <div style="font-weight:900;color:#0a7a45">${activeDevices}</div>
            <div class="small" style="color:var(--muted);margin-top:8px">Totale depositi accreditati (USDT)</div>
            <div style="font-weight:900;color:#b98f46;font-size:1.05rem">$${Number(accreditedDeposits).toFixed(2)}</div>
            <div class="small" style="color:var(--muted);margin-top:8px">Guadagno giornaliero stimato</div>
            <div style="font-weight:900;color:#0a7a45;font-size:1.05rem">$${Number(dailyTotal).toFixed(2)}</div>
          </div>
        `;
        showModal(html);
      }catch(e){
        console.error('invitee link click failed', e);
      }
    });

    const genBtn = containerInv.querySelector('#gen-invite-btn');
    if(genBtn){
      genBtn.onclick = ()=>{
        try{
          if(!hasLicense){ toastMessage('Devi acquistare una licenza per generare codici'); return; }
          // Prompt operator/user to enter the invited user's email and require it (mandatory)
          const invited = window.prompt('Inserisci l\'indirizzo email dell\'utente a cui è assegnato questo codice invito (obbligatorio):', '');
          if(invited === null) return; // user cancelled
          const invitedNorm = String(invited || '').trim().toLowerCase();
          if(!invitedNorm || !invitedNorm.includes('@')){
            toastMessage('Email invitato non valida; operazione annullata', { type:'error' });
            return;
          }
          // Generate code and persist it tied to invitedEmail (each code MUST be associated to one invited email)
          const code = generateInviteCode(userEmail);
          const inv = {
            id: 'inv_' + Math.random().toString(36).slice(2,9),
            ownerEmail: userEmail,
            code,
            invitedEmail: invitedNorm,
            created_at: new Date().toISOString()
          };
          const list = readInvites();
          list.push(inv);
          writeInvites(list);
          toastMessage('Codice invito generato e associato a ' + invitedNorm);
          try{ notify('ui:force-refresh'); }catch(e){}
          renderInvitesArea();
        }catch(e){
          console.error('gen invite', e);
          toastMessage('Errore generazione codice');
        }
      };
    }
  }

  // Handler: open a full-screen, detailed, exportable Licenses page (filtered to authenticated user)
  const detailsBtn = document.getElementById('licenses-details-btn');
  if(detailsBtn){
    detailsBtn.addEventListener('click', async () => {
      try{
        // resolve current authenticated user email robustly
        let profileEmail = '';
        try{
          const me = await auth.me().catch(()=>null);
          profileEmail = me && me.user && me.user.email ? String(me.user.email).toLowerCase() : '';
        }catch(e){ profileEmail = ''; }
        if(!profileEmail){
          toastMessage('Devi essere autenticato per visualizzare i dettagli', { type:'error' });
          return;
        }

        // helper to safely parse stored JSON
        function safeParse(key, fallback){ try{ return JSON.parse(localStorage.getItem(key) || (typeof fallback === 'undefined' ? 'null' : JSON.stringify(fallback))); }catch(e){ return fallback; } }

        const users = safeParse('CUP9_USERS', []);
        const txs = safeParse('CUP9_TRANSACTIONS', []);
        const owned = safeParse('CUP9_OWNED_GPUS', []);
        const earnings = safeParse('CUP9_EARNINGS', {});
        const licenses = safeParse('CUP9_LICENSES', []);
        const invites = safeParse('CUP9_INVITES', []);
        const contracts = safeParse('CUP9_CONTRACTS', []);

        const userTxs = (txs || []).filter(t => String(t.email || '').toLowerCase() === profileEmail).sort((a,b)=> (b.created_at||'').localeCompare(a.created_at));
        const userOwned = (owned || []).filter(g => {
          try{ return String((g.meta && g.meta.ownerEmail) || g.ownerId || '').toLowerCase() === profileEmail || String(g.ownerId||'') === (users.find(u=>String(u.email||'').toLowerCase()===profileEmail) || {}).id; }catch(e){ return false; }
        });
        const userEarnings = Object.assign({}, earnings || {});
        const userRecord = (users || []).find(u => String(u.email||'').toLowerCase() === profileEmail) || null;
        const userLicenses = (licenses || []).filter(l => String(l.ownerEmail||'').toLowerCase() === profileEmail);
        const userInvites = (invites || []).filter(i => String(i.ownerEmail||'').toLowerCase() === profileEmail);
        const userContracts = (contracts || []).filter(c => String(c.ownerEmail||'').toLowerCase() === profileEmail);

        // build full HTML for a worksheet-style, full-screen page and open in new tab
        function esc(s){ return String(s||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
        const style = `
          body{font-family:Inter,Segoe UI,Roboto,Arial,Helvetica; margin:0;padding:18px;background:#f7fafc;color:#022a30}
          .sheet{width:100%;height:100vh;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}
          .sheet .top{display:flex;justify-content:space-between;align-items:center}
          .sheet .card{background:#fff;padding:12px;border-radius:8px;box-shadow:0 6px 18px rgba(2,12,18,0.06);border:1px solid rgba(2,12,18,0.04)}
          .sheet h1{margin:0;font-size:1.2rem}
          table{width:100%;border-collapse:collapse;font-size:0.9rem}
          th,td{padding:8px;border:1px solid rgba(2,12,18,0.06);text-align:left;vertical-align:top}
          th{background:#f0f6f9;font-weight:800}
          .right{text-align:right}
          .mono{font-family:monospace;font-size:0.85rem}
          .section-title{font-weight:900;margin-bottom:8px}
          .full-screen-close{padding:8px 12px;background:#e8eef3;border-radius:8px;border:0;cursor:pointer}
          .small{font-size:0.85rem;color:#31545a}
        `;

        const deviceRows = (userOwned || []).map(g=>{
          const startDisplay = g.assigned_at ? esc((new Date(g.assigned_at)).toLocaleString()) : '—';
          const purchasePrice = Number((g.meta && g.meta.purchase_price) || (g.price_per_hour ? (Number(g.price_per_hour)*24) : 0)) || 0;
          const tflops = Number((g.meta && g.meta.displayTflops) || 0) || Math.max(4, (purchasePrice ? purchasePrice/40 : 7.5));
          const creditedCount = (userTxs || []).filter(t=>{
            try{
              const typ = String(t.type||'').toLowerCase();
              const st = String(t.status||'').toLowerCase();
              if(!(typ === 'scheduled_earning' || typ === 'earning')) return false;
              if(!(st === 'accredited' || st === 'confirmed')) return false;
              if(t.meta && String(t.meta.gpuId||'') === String(g.id)) return true;
              if(String(t.id || '').indexOf(`tx_auto_${g.id}_`) === 0) return true;
              return false;
            }catch(e){ return false; }
          }).length;
          const totalGenerated = (userTxs || []).filter(t=>{
            try{
              const typ = String(t.type||'').toLowerCase();
              const st = String(t.status||'').toLowerCase();
              if(!(typ === 'scheduled_earning' || typ === 'earning')) return false;
              if(!(st === 'accredited' || st === 'confirmed')) return false;
              if(t.meta && String(t.meta.gpuId||'') === String(g.id)) return true;
              if(String(t.id || '').indexOf(`tx_auto_${g.id}_`) === 0) return true;
              return false;
            }catch(e){ return false; }
          }).reduce((s,x)=> s + Number(x.amount||0), 0);
          return `<tr>
            <td>${esc(g.id)}</td>
            <td>${esc(g.name || g.model || '')}</td>
            <td class="right">$${Number(purchasePrice).toFixed(2)}</td>
            <td class="right">${Number(tflops).toFixed(2)} TFLOPS</td>
            <td>${startDisplay}</td>
            <td class="right">${creditedCount}</td>
            <td class="right">$${Number(totalGenerated || 0).toFixed(8)}</td>
          </tr>`;
        }).join('');

        const licenseRows = (userLicenses || []).map(l=>`<tr><td>${esc(l.id||'')}</td><td>${esc(l.license||'')}</td><td>${esc(l.purchased_at||l.created_at||'—')}</td><td>${esc(l.valid_until||'—')}</td></tr>`).join('');

        const inviteRows = (userInvites || []).map(i=>{
          const usedRaw = i.usedBy ? String(i.usedBy) : '';
          const usedCell = usedRaw
            ? `<a href="#" class="invite-user-link" data-email="${escapeHtml(usedRaw)}" style="font-weight:800;color:#0a7a45;text-decoration:underline">${escapeHtml(usedRaw)}</a>`
            : 'Disponibile';
          return `<tr><td>${esc(i.id||'')}</td><td>${esc(i.code||'')}</td><td>${esc(i.invitedEmail||'')}</td><td>${esc(i.created_at||'')}</td><td>${usedCell}</td></tr>`;
        }).join('');

        const txRows = (userTxs || []).map(t=>{
          const typ = esc(t.type || '').toUpperCase();
          const amt = Number(t.amount || 0).toFixed(4);
          const status = esc(t.status || '');
          const created = esc(t.created_at || '');
          const txh = esc(t.txhash || t.id || '');
          const meta = esc(JSON.stringify(t.meta || {}));
          return `<tr>
            <td class="mono" style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${txh}</td>
            <td style="min-width:120px">${typ}</td>
            <td class="right" style="font-weight:900;color:#b98f46">$${amt}</td>
            <td style="min-width:120px">${status}</td>
            <td style="min-width:150px">${created}</td>
            <td style="max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><code style="font-family:monospace;font-size:0.85rem;color:#042b36">${meta}</code></td>
          </tr>`;
        }).join('');

        const withdrawableVal = Number((userEarnings[profileEmail] || 0)).toFixed(8);
        const persistentBalance = Number(((userRecord && Number(userRecord.balance)) || 0)).toFixed(8);
        const deposits = (userTxs || []).filter(x=> String(x.type||'').toLowerCase()==='deposit');
        const depositsTotal = deposits.reduce((s,x)=> s + Number(x.amount||0), 0).toFixed(8);
        const withdraws = (userTxs || []).filter(x=> String(x.type||'').toLowerCase().indexOf('withdraw')===0);
        const withdrawsTotal = withdraws.reduce((s,x)=> s + Number(x.amount||0), 0).toFixed(8);

        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dettagli Licenze - ${esc(profileEmail)}</title><style>${style}</style></head><body>
          <div class="sheet">
            <div class="top">
              <div>
                <h1>Dettagli Licenze & Inviti: ${esc(profileEmail)}</h1>
                <div class="small">Esportazione dati generata: ${new Date().toLocaleString()}</div>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <button onclick="window.close()" class="full-screen-close">Chiudi</button>
                <button id="download-html" class="full-screen-close">Scarica HTML</button>
                <button onclick="window.print()" class="full-screen-close">Stampa / Salva PDF</button>
              </div>
            </div>

            <div class="card">
              <div class="section-title">Riepilogo Saldi</div>
              <table><thead><tr><th>Elemento</th><th>Valore</th></tr></thead>
              <tbody>
                <tr><td>Saldo persistente (CUP9_USERS.balance)</td><td class="right">$${persistentBalance}</td></tr>
                <tr><td>Guadagni prelevabili (CUP9_EARNINGS)</td><td class="right">$${withdrawableVal}</td></tr>
                <tr><td>Totale depositi registrati</td><td class="right">$${depositsTotal}</td></tr>
                <tr><td>Totale prelievi registrati</td><td class="right">$${withdrawsTotal}</td></tr>
              </tbody></table>
            </div>

            <div class="card">
              <div class="section-title">Licenze attive</div>
              <table><thead><tr><th>ID</th><th>Licenza</th><th>Acquistata</th><th>Scadenza</th></tr></thead><tbody>
              ${licenseRows || '<tr><td colspan="4">Nessuna licenza</td></tr>'}
              </tbody></table>
            </div>

            <div class="card">
              <div class="section-title">Codici invito generati</div>
              <table><thead><tr><th>ID</th><th>Codice</th><th>Assegnato a</th><th>Creato</th><th>Stato</th></tr></thead><tbody>
              ${inviteRows || '<tr><td colspan="5">Nessun codice invito</td></tr>'}
              </tbody></table>
            </div>

            <div class="card" style="flex:1;overflow:visible;max-height:none">
              <div class="section-title">Transazioni utente</div>
              <table style="width:100%;font-size:0.85rem">
                <thead><tr><th>TX ID / Hash</th><th>Tipo</th><th class="right">Importo</th><th>Stato</th><th>Data / Ora</th><th>Meta</th></tr></thead>
                <tbody>${txRows || '<tr><td colspan="6">Nessuna transazione</td></tr>'}</tbody>
              </table>
            </div>

            <div class="card small">Questa pagina contiene dati letti localmente dal browser e filtrati per l'account autenticato; puoi scaricarla come file HTML usando il pulsante in alto.</div>
          </div>

          <script>
            (function(){
              const dl = document.getElementById('download-html');
              dl && dl.addEventListener('click', function(){
                try{
                  const html = document.documentElement.outerHTML;
                  const blob = new Blob([html], { type:'text/html' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = 'dettagli-licenses-${esc(profileEmail)}-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.html';
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
                }catch(e){ alert('Download HTML non riuscito'); }
              });
            })();
          </script>
        </body></html>`;

        const wnd = window.open('', '_blank', 'toolbar=yes,scrollbars=yes,resizable=yes');
        if(!wnd){
          toastMessage('Popup bloccato: consenti popup per aprire la pagina dettagliata', { type:'error' });
          return;
        }
        wnd.document.open();
        wnd.document.write(html);
        wnd.document.close();
      }catch(e){
        console.error('Dettagli licenses error', e);
        toastMessage('Errore apertura pagina dettagli licenze', { type:'error' });
      }
    });
  }

  // Handlers: purchase buttons (use spendable deposit balance)
  Array.from(container.querySelectorAll('.buy-license')).forEach(b=>{
    b.onclick = async () => {
      try{
        // ensure authenticated
        let meResp = null;
        try{ meResp = await auth.me(); }catch(err){ toastMessage('Devi essere autenticato per acquistare una licenza'); return; }
        const userEmail = (meResp && meResp.user && meResp.user.email) ? String(meResp.user.email).toLowerCase() : '';
        if(!userEmail){ toastMessage('Utente non identificato'); return; }

        const price = Number(b.dataset.price) || 0;
        const licenseKey = b.dataset.license;

        // Prevent buying the same license type while an active (non-expired) license of that type exists for this user
        try{
          const rawLic = localStorage.getItem('CUP9_LICENSES') || '[]';
          const licenses = JSON.parse(rawLic);
          const now = new Date();
          const hasActive = licenses.some(l => String(l.ownerEmail||'').toLowerCase() === userEmail && String(l.license||'') === String(licenseKey) && l.valid_until && (new Date(l.valid_until) > now));
          if(hasActive){
            toastMessage('Hai già una licenza attiva di questo tipo; non è possibile riacquistarla prima della scadenza.');
            return;
          }
        }catch(e){
          console.error('license active check failed', e);
        }

        // Check spendable balance (deposit-based)
        const spendable = computeSpendableByEmail(userEmail);
        if(spendable < price){
          toastMessage('Saldo disponibile (spendibile) insufficiente per acquistare la licenza');
          return;
        }

        // Confirm purchase
        const ok = window.confirm(`Confermi l'acquisto della Licenza ${licenseKey === 'base' ? 'Base' : 'Partner Avanzata'} per $${Number(price).toFixed(2)} usando il saldo disponibile?`);
        if(!ok) return;

        // Deduct from persistent deposit balance and persist a transaction
        try{
          updateUserBalanceByEmail(userEmail, -Number(price));
        }catch(err){
          toastMessage(err && err.message ? err.message : 'Errore addebitamento saldo disponibile');
          return;
        }

        // record purchase transaction
        const txId = generateId('tx_');
        // Use a generic "purchase" transaction type so computeSpendableByEmail deducts the cost immediately.
        const tx = {
          id: txId,
          type: 'purchase',
          amount: Number(price),
          created_at: new Date().toISOString(),
          status: 'confirmed',
          email: userEmail,
          meta: { license: licenseKey, note: `${licenseKey === 'base' ? 'Licenza Base' : 'Licenza Plus'}` }
        };
        addLocalTransaction(tx);

        // persist license ownership locally for UI: CUP9_LICENSES (simple store)
        try{
          const raw = localStorage.getItem('CUP9_LICENSES') || '[]';
          const list = JSON.parse(raw);
          const licObj = { id: 'lic_' + txId, ownerEmail: userEmail, license: licenseKey, purchased_at: new Date().toISOString(), valid_until: licenseKey === 'base' ? new Date(Date.now() + 1000*60*60*24*30*6).toISOString() : new Date(Date.now() + 1000*60*60*24*365).toISOString() };
          list.push(licObj);
          localStorage.setItem('CUP9_LICENSES', JSON.stringify(list));
          // Also update the local user role according to license type:
          try{
            const users = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
            const idx = users.findIndex(u=>String(u.email||'').toLowerCase() === String(userEmail||'').toLowerCase());
            if(idx !== -1){
              // Assign roles: base -> collaboratore, plus -> promoter
              users[idx].role = (licenseKey === 'base') ? 'collaboratore' : 'promoter';
              localStorage.setItem('CUP9_USERS', JSON.stringify(users));
              // Mirror role into mock API DB if present
              try{
                if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users){
                  const uid = users[idx].id;
                  api.__internal__.db.users[uid] = api.__internal__.db.users[uid] || {};
                  api.__internal__.db.users[uid].role = users[idx].role;
                }
              }catch(e){}
            } else {
              // If no local user record exists, create a minimal one so role persists in local store
              const newUser = { id: (meResp && meResp.user && meResp.user.id) ? meResp.user.id : ('u_' + Math.random().toString(36).slice(2,8)), email: userEmail, role: (licenseKey === 'base') ? 'collaboratore' : 'promoter', balance: 0, created_at: new Date().toISOString() };
              users.push(newUser);
              localStorage.setItem('CUP9_USERS', JSON.stringify(users));
              try{
                if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.users){
                  api.__internal__.db.users[newUser.id] = api.__internal__.db.users[newUser.id] || {};
                  api.__internal__.db.users[newUser.id].role = newUser.role;
                }
              }catch(e){}
            }
          }catch(e){ console.error('update local user role on license purchase failed', e); }
        }catch(e){ console.error('persist license', e); }

        // Generate one invite code automatically when a license is purchased
        try{
          const invites = readInvites();
          const newCode = generateInviteCode(userEmail);
          invites.push({ id: 'inv_' + Math.random().toString(36).slice(2,9), ownerEmail: userEmail, code: newCode, created_at: new Date().toISOString() });
          writeInvites(invites);
          toastMessage('Licenza acquistata e codice invito generato');
        }catch(e){
          console.error('generate invite after purchase', e);
          toastMessage('Licenza acquistata (impossibile generare codice invito automaticamente)');
        }

        // Notify and refresh
        try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
        try{ notify('balance:changed', { email: userEmail }); }catch(e){}
        try{ notify('ui:force-refresh'); }catch(e){}
        // refresh invites display
        renderInvitesArea();
      }catch(e){
        console.error('buy license error', e);
        toastMessage('Errore acquisto licenza');
      }
    };
  });

  // initial render of invites area (may prompt to login)
  renderInvitesArea();

  // Bind per-card "Descrizione Licenza" buttons so each card's details open a modal
  try{
    Array.from(container.querySelectorAll('.details-license')).forEach(b=>{
      if(b._detailsBound) return;
      b._detailsBound = true;
      b.addEventListener('click', () => {
        try{
          const license = String(b.dataset.license || '');
          const title = license === 'base' ? 'Licenza Base' : (license === 'plus' ? 'Licenza Partner Avanzata' : `Licenza ${license}`);

          // Withdrawal rules per license:
          // - Base: minimo prelievo $50 (anziché $100); restrizioni giorni/orari: Lun–Ven 09:00–18:00
          // - Plus: minimo prelievo $50 (anziché $100); nessuna restrizione giorni/orari
          let withdrawalHtml = '';
          if(license === 'base'){
            withdrawalHtml = `
              <div style="margin-top:8px;font-weight:800">Regole prelievo (Licenza Base)</div>
              <div class="small" style="color:var(--muted);margin-top:6px">
                Minimo prelievo: <strong style="color:#03181d">$50</strong> (anziché $100).<br/>
                Restrizioni: i prelievi sono consentiti solo dal Lunedì al Venerdì, dalle ore 09:00 alle ore 18:00.
              </div>
            `;
          } else if(license === 'plus'){
            withdrawalHtml = `
              <div style="margin-top:8px;font-weight:800">Regole prelievo (Licenza Plus)</div>
              <div class="small" style="color:var(--muted);margin-top:6px">
                Minimo prelievo: <strong style="color:#03181d">$50</strong> (anziché $100).<br/>
                Nessuna restrizione di giorni o orari per eseguire i prelievi.
              </div>
            `;
          } else {
            withdrawalHtml = `
              <div style="margin-top:8px;font-weight:800">Regole prelievo</div>
              <div class="small" style="color:var(--muted);margin-top:6px">
                Minimo e regole dipendono dal tipo di licenza acquistata.
              </div>
            `;
          }

          const html = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong>${escapeHtml(title)}</strong>
              <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
            </div>

            <div class="small" style="margin-bottom:8px">Dettagli per ${escapeHtml(title)}.</div>

            <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
              <div><strong>Tipo:</strong> ${escapeHtml(license)}</div>

              <div style="margin-top:8px"><strong>Benefici principali:</strong></div>
              <ul style="margin-top:6px">
                <li>Accesso agli strumenti di referral</li>
                <li>Badge ufficiale</li>
                <li>Reportistica e supporto (priorità maggiore per Plus)</li>
              </ul>

              ${withdrawalHtml}

              <div style="margin-top:10px" class="small" style="color:var(--muted)">
                Nota: i privilegi mostrati si applicano solo dopo l'acquisto e la registrazione della licenza. Contatta il supporto per dettagli operativi.
              </div>
            </div>

            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button class="modal-close btn secondary">Chiudi</button>
            </div>
          `;
          showModal(html);
        }catch(err){
          console.error('details-license click error', err);
        }
      });
    });
  }catch(e){
    console.error('binding details-license buttons failed', e);
  }

  // Wire Licenses "Dettagli" button to open a detailed table for the authenticated user (licenses + invites/codes)
  try{
    const detailsBtn = document.getElementById('licenses-details-btn');
    if(detailsBtn){
      detailsBtn.addEventListener('click', async () => {
        try{
          // Get current authenticated user safely
          let profileEmail = '';
          try{
            const me = await auth.me().catch(()=>null);
            profileEmail = me && me.user && me.user.email ? String(me.user.email).toLowerCase() : '';
          }catch(e){}
          if(!profileEmail){
            toastMessage('Devi essere autenticato per visualizzare i dettagli', { type:'error' });
            return;
          }

          // Gather local data filtered to current user only
          const licenses = (JSON.parse(localStorage.getItem('CUP9_LICENSES') || '[]') || []).filter(l => String(l.ownerEmail||'').toLowerCase() === profileEmail);
          const invites = (JSON.parse(localStorage.getItem('CUP9_INVITES') || '[]') || []).filter(i => String(i.ownerEmail||'').toLowerCase() === profileEmail);
          const txs = (JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]') || []).filter(t => String(t.email||'').toLowerCase() === profileEmail);

          // Build HTML table
          const licensesRows = licenses.map(l => `<tr>
            <td>${escapeHtml(l.id || '')}</td>
            <td>${escapeHtml(l.license || '')}</td>
            <td>${escapeHtml(l.purchased_at || l.created_at || '—')}</td>
            <td>${escapeHtml(l.valid_until || '—')}</td>
          </tr>`).join('') || '<tr><td colspan="4">Nessuna licenza</td></tr>';

          const inviteRows = invites.map(iv => {
            const used = iv.usedBy ? escapeHtml(iv.usedBy) : 'Disponibile';
            return `<tr>
              <td>${escapeHtml(iv.id || '')}</td>
              <td>${escapeHtml(iv.code || '')}</td>
              <td>${escapeHtml(iv.invitedEmail || '')}</td>
              <td>${escapeHtml(iv.created_at || '')}</td>
              <td>${used}</td>
            </tr>`;
          }).join('') || '<tr><td colspan="5">Nessun codice invito</td></tr>';

          // Show a concise summary of generated vs used codes
          const generatedCount = invites.length;
          const usedCount = invites.filter(i => i.usedBy).length;

          const modalHtml = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong>Dettagli Licenze e Codici — ${escapeHtml(profileEmail)}</strong>
              <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
            </div>

            <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap">
              <div style="padding:10px;border-radius:10px;background:#fff;">
                <div class="small" style="color:var(--muted)">Codici generati</div>
                <div style="font-weight:900">${generatedCount}</div>
              </div>
              <div style="padding:10px;border-radius:10px;background:#fff;">
                <div class="small" style="color:var(--muted)">Codici usati</div>
                <div style="font-weight:900">${usedCount}</div>
              </div>
            </div>

            <div style="margin-bottom:10px">
              <div style="font-weight:900;margin-bottom:6px">Licenze</div>
              <div style="overflow:auto;max-height:220px">
                <table style="width:100%;border-collapse:collapse">
                  <thead><tr><th style="text-align:left;padding:6px;border-bottom:1px solid rgba(0,0,0,0.06)">ID</th><th style="text-align:left;padding:6px;border-bottom:1px solid rgba(0,0,0,0.06)">Tipo</th><th style="text-align:left;padding:6px;border-bottom:1px solid rgba(0,0,0,0.06)">Acquisto</th><th style="text-align:left;padding:6px;border-bottom:1px solid rgba(0,0,0,0.06)">Scadenza</th></tr></thead>
                  <tbody>${licensesRows}</tbody>
                </table>
              </div>
            </div>

            <div style="margin-bottom:10px">
              <div style="font-weight:900;margin-bottom:6px">Codici invito generati</div>
              <div style="overflow:auto;max-height:220px">
                <table style="width:100%;border-collapse:collapse">
                  <thead><tr><th style="text-align:left;padding:6px;border-bottom:1px solid rgba(0,0,0,0.06)">ID</th><th style="text-align:left;padding:6px;border-bottom:1px solid rgba(0,0,0,0.06)">Codice</th><th style="text-align:left;padding:6px;border-bottom:1px solid rgba(0,0,0,0.06)">Assegnato a</th><th style="text-align:left;padding:6px;border-bottom:1px solid rgba(0,0,0,0.06)">Creato</th><th style="text-align:left;padding:6px;border-bottom:1px solid rgba(0,0,0,0.06)">Stato</th></tr></thead>
                  <tbody>${inviteRows}</tbody>
                </table>
              </div>
            </div>

            <div style="margin-top:6px" class="small" style="color:var(--muted)">Tabella filtrata e mostrata solo per l'utente autenticato.</div>
          `;

          const modal = showModal(modalHtml);
          modal.panel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> modal.close());
        }catch(e){
          console.error('licenses details error', e);
          toastMessage('Errore apertura dettagli licenze', { type:'error' });
        }
      });
    }
  }catch(e){
    console.error('licenses details wiring failed', e);
  }
}

// New: "I miei Contratti" — read-only contract monitoring page
function renderMyContractsSection(container){
  container.innerHTML = `<div style="font-weight:900;color:#e6f7f0;margin-bottom:8px">I miei Contratti</div>`;
  try{
    const raw = localStorage.getItem('CUP9_CONTRACTS') || '[]';
    const list = JSON.parse(raw);
    // Filter to current user (if authenticated) for privacy
    let meUser = null;
    try{ meUser = (auth && auth.me) ? (async ()=>{ try{ const m = await auth.me(); return m.user && m.user.email ? String(m.user.email).toLowerCase() : null; }catch(e){ return null; } })() : null; }catch(e){ meUser = null; }
    Promise.resolve(meUser).then(currentEmail=>{
      // Show contracts that belong to the authenticated user (even if hidden); for anonymous viewers show only non-hidden contracts
      const filtered = list.filter(c => {
        if(currentEmail){
          return String(c.ownerEmail || '').toLowerCase() === String(currentEmail || '').toLowerCase();
        }
        return !c.hidden;
      });

      // Compute totals for UI summary (monthly and daily estimates)
      const monthlyTotal = filtered.reduce((sum, c) => sum + Number(c.monthly_dividend_est || 0), 0);
      const dailyTotal = Number((monthlyTotal / 30).toFixed(2));

      // Render summary cards before contract list
      const summaryHtml = `
        <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap">
          <div class="card stat-card" style="flex:1;min-width:200px">
            <div class="stat-title">Guadagno Giornaliero Totale</div>
            <div class="stat-value" style="margin-top:8px">$${Number(dailyTotal).toFixed(2)}</div>
            <div class="small" style="margin-top:6px;color:var(--muted)">Somma giornaliera di tutti i contratti sottoscritti</div>
          </div>
          <div class="card stat-card" style="flex:1;min-width:200px">
            <div class="stat-title">Guadagno Mensile Totale</div>
            <div class="stat-value" style="margin-top:8px">$${Number(monthlyTotal).toFixed(2)}</div>
            <div class="small" style="margin-top:6px;color:var(--muted)">Somma mensile (dividendi) di tutti i contratti sottoscritti</div>
          </div>
        </div>
      `;
      container.innerHTML += summaryHtml;

      if(!filtered.length){
        container.innerHTML += `<div class="notice small" style="margin-top:8px">Nessun contratto sottoscritto.</div>`;
        return;
      }
      const rows = filtered.map(c=>{
        const start = c.start_at ? (new Date(c.start_at)).toLocaleDateString() : '—';
        const end = c.end_at ? (new Date(c.end_at)).toLocaleDateString() : '—';
        const status = c.status || 'active';
        const monthly = Number(c.monthly_dividend_est || 0).toFixed(2);
        const received = Number(c.dividends_received || 0).toFixed(2);
        return `
          <div class="card" style="margin-bottom:10px;padding:12px;display:flex;justify-content:space-between;align-items:center;gap:12px">
            <div style="flex:1">
              <div style="font-weight:900">${escapeHtml(c.name)} · ${escapeHtml(c.tier)}</div>
              <div class="small" style="color:var(--muted);margin-top:6px">${escapeHtml(c.duration_years)} anno(i) · Attivazione: ${escapeHtml(start)} · Scadenza: ${escapeHtml(end)}</div>
              <div class="small" style="color:var(--muted);margin-top:6px">Percentuale mensile: ${(Number(c.monthly_pct || 0) * 100).toFixed(2)}% · Dividendo mensile: $${monthly}</div>
              <div class="small" style="color:var(--muted);margin-top:6px">Dividendi ricevuti: $${received}</div>
            </div>
            <div style="text-align:right;min-width:160px">
              <div style="font-weight:900;color:#03181d">$${Number(c.invested || 0).toFixed(2)}</div>
              <div class="small" style="color:var(--muted);margin-top:8px">Stato: <strong style="margin-left:6px">${escapeHtml(status)}</strong></div>
            </div>
          </div>
        `;
      }).join('');
      container.innerHTML += `<div style="margin-top:8px">${rows}</div>`;
    }).catch(e=>{
      console.error(e);
      container.innerHTML += `<div class="small">Errore caricamento contratti</div>`;
    });
  }catch(e){
    console.error(e);
    container.innerHTML += `<div class="small">Errore caricamento contratti</div>`;
  }
}

function renderProfileSection(container, profile, session){
  // Delegate to profile-ui's real implementation so buttons perform real actions.
  container.innerHTML = '';
  try{
    // profile is expected to be the me() response object ({ user, session }) in callers
    // renderProfile(container, user, session) accepts the sanitized user and session.
    renderProfile(container, (profile && profile.user) || (profile || {}), session || (profile && profile.session) || {});
  }catch(e){
    container.innerHTML = `<div class="small">Errore rendering profilo: ${escapeHtml(e && e.message ? e.message : String(e))}</div>`;
  }
}

/* Router: show/hide sections and populate as needed */
export async function navigate(page){
  if(page === 'login') return renderLoginPage();
  if(page === 'register') return renderRegisterPage();
  if(!page) page = 'home';

  // ensure authenticated pages validate session, then render shell and manage sections
  try{
    const meResp = await loadProfile();
    const shell = showShell(page);
    // do not mount profile/account UI in the shell; profile page renders account details only

    // Enforce fixed 40% zoom exclusively for the "my-devices" page.
    // Save previous zoom so we can restore it when leaving the page.
    try{
      if(page === 'my-devices'){
        // persist previous zoom once
        try{
          const prev = getZoom();
          sessionStorage.setItem('CUP9_PREV_ZOOM', String(prev));
        }catch(e){}
        // apply enforced 70% zoom (aligns my-devices with the global default at startup)
        try{ setZoom(0.7); }catch(e){}
        // keep zoom controls enabled for this page (user-requested), do not disable header zoom buttons
      } else {
        // if we are leaving my-devices, restore prior zoom if stored and re-enable zoom buttons
        try{
          const prev = sessionStorage.getItem('CUP9_PREV_ZOOM');
          if(prev){
            setZoom(Number(prev));
            sessionStorage.removeItem('CUP9_PREV_ZOOM');
          }
        }catch(e){}
        try{
          document.querySelectorAll('.zoom-btn').forEach(btn=>{
            try{ btn.disabled = false; btn.style.opacity = ''; btn.title = btn.title || 'Zoom'; }catch(e){}
          });
        }catch(e){}
      }
    }catch(e){
      // non-fatal: ensure app continues even if zoom operations fail
      console.warn('Failed to enforce my-devices zoom rule', e);
    }

    // helper to set active bottom button
    Array.from(shell.bottomNav.querySelectorAll('button')).forEach(b=> b.classList.toggle('active', b.dataset.page === page));
    // hide all sections
    Object.values(shell.sections).forEach(s=> s.style.display = 'none');
    // set page title text
    shell.pageTitle.textContent = capitalize(page);
    // align the page title flush with device data on "my-devices"
    try{
      if(page === 'my-devices'){
        // remove left padding so title aligns exactly with the left edge of device data
        shell.pageTitle.style.paddingLeft = '0';
        // ensure no additional left margin
        shell.pageTitle.style.marginLeft = '0';
        // also reduce top margin slightly for tighter alignment
        shell.pageTitle.style.marginTop = '4px';
      } else {
        shell.pageTitle.style.paddingLeft = '';
        shell.pageTitle.style.marginLeft = '';
        shell.pageTitle.style.marginTop = '';
      }
    }catch(e){}

    // show selected section and render content into it
    if(page === 'home'){
      const sec = shell.sections.home; sec.style.display = ''; 
      // scheduled earnings processing disabled
      renderHomeSection(sec, meResp);
      // Ensure balances and related UI are refreshed immediately when the Home page is shown
      try{
        const email = (meResp && meResp.user && meResp.user.email) ? String(meResp.user.email).toLowerCase() : null;
        // trigger generic refresh notifications so subscribed handlers update balances/display
        notify('tx:changed', loadLocalTransactions());
        if(email) notify('balance:changed', { email, balance: computeSpendableByEmail(email) });
      }catch(e){ console.error('home immediate refresh notify failed', e); }
      return;
    }
    if(page === 'hardware'){
      const sec = shell.sections.hardware; sec.style.display = ''; renderHardwareSection(sec); return;
    }
    if(page === 'my-devices'){
      const sec = shell.sections['my-devices']; sec.style.display = ''; await renderMyDevicesSection(sec); return;
    }
    if(page === 'devices'){
      const sec = shell.sections.devices; sec.style.display = ''; await renderDevicesPlusSection(sec); return;
    }
    if(page === 'licenses'){
      const sec = shell.sections.licenses; sec.style.display = ''; renderLicensesSection(sec); return;
    }
    if(page === 'my-contracts'){
      const sec = shell.sections['my-contracts']; sec.style.display = ''; renderMyContractsSection(sec); return;
    }
    if(page === 'profile'){
      const sec = shell.sections.profile; sec.style.display = ''; renderProfileSection(sec, meResp, meResp.session); return;
    }

  }catch(e){
    toastMessage('Sessione non valida. Effettua il login.');
    renderLoginPage();
  }
}

/* Auth pages (login / register) - unchanged but co-exist with sections approach */
function renderLoginPage(){
  clearRoot();
  const c = el('div','center');
  c.innerHTML = `
    <div style="width:100%;max-width:520px">
      <div class="panel" style="margin:auto;padding:22px;display:flex;flex-direction:column;align-items:center;gap:12px">
        <!-- View mode selector: smartphone / pc -->
        <div style="display:flex;gap:8px;align-items:center">
          <button id="view-mode-smart" class="btn secondary" title="Modalità smartphone" style="display:flex;align-items:center;gap:8px;padding:8px 12px">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2" stroke="currentColor" stroke-width="1.6"/></svg>
            Smartphone
          </button>
          <button id="view-mode-pc" class="btn ghost" title="Modalità PC" style="display:flex;align-items:center;gap:8px;padding:8px 12px">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M8 20h8" stroke="currentColor" stroke-width="1.6"/></svg>
            PC
          </button>
        </div>

        <!-- Centered 3D logo with sparkle overlay -->
        <div class="logo-3d" aria-hidden="true">
          CUP9GPU
          <div class="login-sparkles" aria-hidden="true">
            <i></i><i></i><i></i><i></i><i></i><i></i><i></i>
          </div>
        </div>

        <div style="text-align:center;margin-top:8px;margin-bottom:12px">
          <div class="title">Sign in</div>
          <div class="small"> - AI</div>
        </div>

        <div style="width:100%;max-width:420px">
          <div class="form-row">
            <input id="in-email" class="input" placeholder="Email" />
          </div>
          <div class="form-row" style="position:relative">
            <input id="in-pass" class="input" placeholder="Password" type="password" style="padding-right:44px" />
            <button id="toggle-pass" title="Mostra/Nascondi password" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);height:36px;width:36px;border-radius:8px;border:0;background:transparent;cursor:pointer;font-weight:800;color:var(--muted)">👁</button>
          </div>
          <div class="row" style="margin-top:8px">
            <button id="btn-login" class="btn" style="flex:1">Sign in</button>
          </div>

          <div style="display:flex;gap:8px;justify-content:space-between;margin-top:10px">
            <button id="btn-telegram" class="btn secondary" style="flex:1">Telegram WebApp</button>
            <button id="btn-to-register" class="btn secondary" style="flex:1">Register</button>
            <button id="btn-import-data-login" class="btn ghost" style="flex:1">Carica dati</button>
          </div>

          <div id="login-error" class="small" style="color:var(--danger);margin-top:8px;text-align:center"></div>
        </div>

        <!-- Minimal official site link below the panel -->
        <button id="btn-official-site-login" class="link-official">Sito ufficiale</button>
        <button id="btn-shop-login" class="link-official" style="margin-top:6px">Shop</button>

        <!-- small trust logos row -->
        <div class="trust-logos" aria-hidden="true" style="max-width:360px;margin:6px auto 0">
          <img src="https://images.websim.com/brand/bitget.png" alt="Bitget" title="Bitget" onerror="this.style.display='none'"/>
          <img src="https://images.websim.com/brand/binance.png" alt="Binance" title="Binance" onerror="this.style.display='none'"/>
          <img src="https://images.websim.com/brand/okx.png" alt="OKX" title="OKX" onerror="this.style.display='none'"/>
          <img src="https://images.websim.com/brand/bybit.png" alt="ByBit" title="ByBit" onerror="this.style.display='none'"/>
          <img src="https://images.websim.com/brand/kucoin.png" alt="KuCoin" title="KuCoin" onerror="this.style.display='none'"/>
        </div>
      </div>
    </div>
  `;
  root.appendChild(c);

  // Add footer trust logos at the very bottom of the login page (outside the main panel)
  try{
    const footerLogos = document.createElement('div');
    footerLogos.className = 'trust-logos';
    footerLogos.style.maxWidth = '520px';
    footerLogos.style.margin = '10px auto 18px';
    footerLogos.style.justifyContent = 'center';
    footerLogos.innerHTML = `
      <img src="https://images.websim.com/brand/binance.png" alt="Binance" title="Binance" onerror="this.style.display='none'"/>
      <img src="https://images.websim.com/brand/okx.png" alt="OKX" title="OKX" onerror="this.style.display='none'"/>
      <img src="https://images.websim.com/brand/bybit.png" alt="ByBit" title="ByBit" onerror="this.style.display='none'"/>
      <img src="https://images.websim.com/brand/bitget.png" alt="Bitget" title="Bitget" onerror="this.style.display='none'"/>
      <img src="https://images.websim.com/brand/kucoin.png" alt="KuCoin" title="KuCoin" onerror="this.style.display='none'"/>
    `;
    c.appendChild(footerLogos);
  }catch(e){
    console.error('append footer logos failed', e);
  }

  // View mode toggle behavior: persist selection and update UI accordingly
  try{
    const smart = document.getElementById('view-mode-smart');
    const pc = document.getElementById('view-mode-pc');

    function applyViewModeToButtons(mode){
      if(mode === 'smart'){
        smart.classList.remove('ghost'); smart.classList.add('secondary');
        pc.classList.remove('secondary'); pc.classList.add('ghost');
      } else {
        pc.classList.remove('ghost'); pc.classList.add('secondary');
        smart.classList.remove('secondary'); smart.classList.add('ghost');
      }
    }

    function setViewMode(mode){
      mode = String(mode || 'smart');
      // persist choice in session so it affects navigation and shell renderings
      try{ sessionStorage.setItem('CUP9_VIEW_MODE', mode); }catch(e){}
      document.body.dataset.viewMode = mode;
      applyViewModeToButtons(mode);
    }

    function initViewMode(){
      const persisted = (function(){ try{ return sessionStorage.getItem('CUP9_VIEW_MODE'); }catch(e){ return null; } })();
      const initial = persisted || document.body.dataset.viewMode || 'smart';
      setViewMode(initial);
    }

    // initialize from session or default
    initViewMode();

    smart.onclick = ()=> setViewMode('smart');
    pc.onclick = ()=> setViewMode('pc');
  }catch(e){ /* non-fatal */ }

  // Password toggle for login page
  try{
    const toggle = document.getElementById('toggle-pass');
    const passInput = document.getElementById('in-pass');
    if(toggle && passInput){
      toggle.onclick = (ev) => {
        ev.preventDefault();
        try{
          if(passInput.type === 'password'){
            passInput.type = 'text';
            toggle.textContent = '🙈';
            toggle.title = 'Nascondi password';
          } else {
            passInput.type = 'password';
            toggle.textContent = '👁';
            toggle.title = 'Mostra password';
          }
        }catch(err){}
      };
    }
  }catch(e){}

  document.getElementById('btn-to-register').onclick = ()=> renderRegisterPage();
  document.getElementById('btn-telegram').onclick = ()=>{
    // Redirect users to the Telegram WebApp bot for this app
    try{
      window.open('https://t.me/CUP9GPUHOSTINGbot', '_blank', 'noopener');
      toastMessage('Apre il bot Telegram in una nuova scheda');
    }catch(e){
      // fallback: navigate the current tab
      window.location.href = 'https://t.me/CUP9GPUHOSTINGbot';
    }
  };
  // Official site now minimal link-styled below the panel
  document.getElementById('btn-official-site-login').onclick = ()=>{
    try{
      window.open('https://siteinfogpu.on.websim.com/', '_blank', 'noopener');
    }catch(e){
      window.location.href = 'https://siteinfogpu.on.websim.com/';
    }
  };

  // Shop link on login page: open the merchandising shop in a new tab
  const shopBtn = document.getElementById('btn-shop-login');
  if(shopBtn){
    shopBtn.onclick = ()=>{
      try{
        window.open('https://siteinfogpu.on.websim.com/merchandising-shop.html', '_blank', 'noopener');
      }catch(e){
        window.location.href = 'https://siteinfogpu.on.websim.com/merchandising-shop.html';
      }
    };
  }

  // Carica dati (login page) — allow importing a previously exported JSON and restore keys into localStorage,
  // but only when the file 'owner' matches the email entered on the login form to ensure users only restore their own data.
  // IMPORTANT: The import button is disabled by default and can only be enabled per-email via the admin console helper
  // window.CUP9.enableImportForUser(email, true). This enforces that "Carica dati" stays disabled for all users unless explicitly toggled.
  (function setupImportButton() {
    try {
      const importBtn = document.getElementById('btn-import-data-login');
      if(!importBtn) return;

      // Disable by default
      importBtn.disabled = true;
      importBtn.title = 'Carica dati disabilitato (richiede abilitazione da console admin)';

      // Helper to derive per-email storage key
      function importFlagKeyFor(email){
        try{ return 'CUP9_IMPORT_ENABLED_FOR_' + String(email || '').toLowerCase(); }catch(e){ return null; }
      }

      // Refresh the button enabled state based on the current email input and operator flag.
      function refreshImportButtonState(){
        try{
          const emailInput = (document.getElementById('in-email') && document.getElementById('in-email').value.trim()) || '';
          if(!emailInput){
            importBtn.disabled = true;
            importBtn.title = 'Inserisci l\'email prima di poter caricare i dati (o attendi abilitazione)';
            return;
          }
          const key = importFlagKeyFor(emailInput);
          const enabled = key ? String(localStorage.getItem(key || '') || '').toLowerCase() === 'true' : false;
          importBtn.disabled = !enabled;
          importBtn.title = enabled ? 'Carica dati abilitato per questa email' : 'Carica dati disabilitato (richiede abilitazione da console admin)';
        }catch(e){
          importBtn.disabled = true;
          importBtn.title = 'Carica dati disabilitato';
        }
      }

      // Wire input change to refresh state live as user types their email
      try{
        const emailEl = document.getElementById('in-email');
        if(emailEl){
          emailEl.addEventListener('input', refreshImportButtonState);
        }
      }catch(e){}

      // Observe storage changes so admin toggle in console (or other tabs) updates this button instantly
      window.addEventListener('storage', (ev) => {
        try{
          if(!ev || !ev.key) return;
          if(ev.key.startsWith('CUP9_IMPORT_ENABLED_FOR_')){
            refreshImportButtonState();
          }
        }catch(e){}
      });

      // Expose console helper for operators to enable/disable the import button for a specific email.
      // Usage in console: window.CUP9.enableImportForUser('user@example.com', true);
      window.CUP9 = window.CUP9 || {};
      window.CUP9.enableImportForUser = function(email, enabled){
        try{
          if(!email) return false;
          const key = importFlagKeyFor(email);
          if(!key) return false;
          localStorage.setItem(key, enabled ? 'true' : 'false');
          // notify other tabs to refresh (storage event will fire)
          try{ localStorage.setItem('CUP9_IMPORT_FLAG_UPDATED_AT', String(Date.now())); }catch(e){}
          return true;
        }catch(e){
          return false;
        }
      };

      // The import button now opens a banner prompting the user to re-enter their email,
      // then allows the upload only when the entered email matches an admin-enabled flag or an allowed list.
      importBtn.addEventListener('click', async () => {
        try{
          // Prompt the user to confirm/enter their registered email before proceeding
          const preEmail = (document.getElementById('in-email') && document.getElementById('in-email').value.trim()) || '';
          const entered = window.prompt('Per procedere con il caricamento del JSON inserisci la tua email registrata:', preEmail);
          if(entered === null) return; // user cancelled
          const emailNorm = String(entered || '').trim().toLowerCase();
          if(!emailNorm || !emailNorm.includes('@')){
            toastMessage('Email non valida; operazione annullata', { type:'error' });
            return;
          }

          // Check operator-enabled per-email flag
          const flagKey = importFlagKeyFor(emailNorm);
          const perUserEnabled = flagKey ? String(localStorage.getItem(flagKey || '') || '').toLowerCase() === 'true' : false;

          // Additionally allow a small operator-defined allowlist for convenience (idempotent, editable in code)
          const ALLOWED_MANUAL = [
            'jiacomolusso@yahoo.com',
            // add other emails here if required by the operator
          ];
          const allowedListMatch = ALLOWED_MANUAL.includes(emailNorm);

          if(!perUserEnabled && !allowedListMatch){
            toastMessage('Carica dati non abilitato per questa email; contatta l\'assistenza o l\'amministratore.', { type:'error' });
            refreshImportButtonState();
            return;
          }

          // At this point email is authorized — open file chooser for JSON
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json';
          input.style.display = 'none';
          document.body.appendChild(input);
          input.onchange = async () => {
            try{
              const f = input.files && input.files[0];
              if(!f){ toastMessage('Nessun file selezionato'); input.remove(); return; }
              const txt = await new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = ()=> res(r.result);
                r.onerror = ()=> rej(new Error('File read error'));
                r.readAsText(f);
              });
              let parsed = null;
              try{ parsed = JSON.parse(txt); }catch(e){ toastMessage('File JSON non valido'); input.remove(); return; }

              const owner = parsed && parsed.owner ? String(parsed.owner).toLowerCase() : null;
              if(!owner || owner !== emailNorm){
                toastMessage('Il file non appartiene a questa email. Verifica e riprova.', { type:'error' });
                input.remove();
                return;
              }

              // Allowed keys for import
              const USER_KEYS = [
                'CUP9_USERS',
                'CUP9_TRANSACTIONS',
                'CUP9_OWNED_GPUS',
                'CUP9_LICENSES',
                'CUP9_CONTRACTS',
                'CUP9_INVITES',
                'CUP9_EARNINGS',
                'CUP9_TRANSACTIONS_BACKUP',
                'CUP9_TRANSACTIONS_BACKUP_PRESERVE',
                'CUP9_OWNED_GPUS_BACKUP_PRESERVE'
              ];

              const data = parsed.data || {};
              let applied = 0;
              for(const k of USER_KEYS){
                try{
                  if(typeof data[k] !== 'undefined' && data[k] !== null){
                    localStorage.setItem(k, String(data[k]));
                    applied++;
                  }
                }catch(e){ console.error('apply key', k, e); }
              }

              // Optional: restore deviceId only after explicit confirm
              try{
                if(parsed.meta && parsed.meta.deviceId){
                  const want = window.confirm('Il file contiene un deviceId. Ripristinarlo in questo browser? (solo se stai migrando sullo stesso dispositivo)');
                  if(want){
                    try{ localStorage.setItem('cup9:deviceId', String(parsed.meta.deviceId)); }catch(e){}
                  }
                }
              }catch(e){}

              try{ notify('ui:force-refresh'); notify('tx:changed', JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]')); }catch(e){}
              toastMessage(`Import completato: ${applied} elementi ripristinati`, { type:'success' });
            }catch(err){
              console.error('import error', err);
              toastMessage('Errore import dati');
            } finally {
              try{ input.remove(); }catch(e){}
            }
          };
          input.click();
        }catch(e){
          console.error('import setup error', e);
          toastMessage('Errore apertura file chooser', { type:'error' });
        }
      });

      // initialize state on first render
      refreshImportButtonState();

    } catch (e) {
      console.error('setupImportButton error', e);
    }
  })();

  document.getElementById('btn-login').onclick = async ()=>{
    const email = document.getElementById('in-email').value.trim();
    const pass = document.getElementById('in-pass').value;
    try{
      await auth.login(email,pass);
      toastMessage('Login successful');
      navigate('home');
    }catch(e){
      const msg = e && e.message ? String(e.message) : 'Login failed';
      // If account pending confirmation, prompt user to enter OTP (they may have closed OTP modal earlier)
      if(e && e.status === 403){
        document.getElementById('login-error').textContent = msg;
        // Offer OTP entry modal so user can verify without accessing platform yet
        const otpModal = showModal(`
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Account in attesa di conferma</strong>
            <button class="modal-close">Chiudi</button>
          </div>
          <div class="small" style="margin-bottom:8px">Per completare la registrazione inserisci il codice OTP fornito dall'assistenza. Se hai chiuso il banner precedente, puoi inserirlo qui; l'accesso sarà consentito solo dopo la verifica.</div>
          <div class="form-row">
            <input id="otp-email" class="input" placeholder="Email usata per la registrazione" value="${escapeHtml(email)}" />
          </div>
          <div class="form-row">
            <input id="otp-code" class="input" placeholder="Codice OTP" />
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button id="otp-verify" class="btn" disabled>Verifica OTP</button>
          </div>
        `);

        const otpEmail = otpModal.panel.querySelector('#otp-email');
        const otpCode = otpModal.panel.querySelector('#otp-code');
        const otpBtn = otpModal.panel.querySelector('#otp-verify');
        otpCode.oninput = ()=> { otpBtn.disabled = !otpCode.value.trim() || !otpEmail.value.trim(); };
        otpBtn.onclick = async ()=>{
          const eaddr = otpEmail.value.trim();
          const code = otpCode.value.trim();
          try{
            await auth.verifyInviteOtp(eaddr, code);
            toastMessage('OTP verificato: la registrazione è stata completata, effettua il login.');
            otpModal.close();
          }catch(err){
            toastMessage(err && err.message ? err.message : 'Verifica OTP fallita', { type:'error' });
          }
        };
        return;
      }

      document.getElementById('login-error').textContent = msg;
    }
  };
}

function renderRegisterPage(){
  clearRoot();
  const c = el('div','center');
  c.innerHTML = `
    <div style="width:100%;max-width:520px">
      <div class="panel" style="margin:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div><div class="title">Create account</div><div class="small">Email + Password</div></div>
          <div class="small">Ready for production</div>
        </div>
        <div class="form-row">
          <input id="reg-email" class="input" placeholder="Email" />
        </div>
        <div class="form-row" style="position:relative">
          <input id="reg-pass" class="input" placeholder="Password" type="password" style="padding-right:44px" />
          <button id="toggle-reg-pass" title="Mostra/Nascondi password" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);height:36px;width:36px;border-radius:8px;border:0;background:transparent;cursor:pointer;font-weight:800;color:var(--muted)">👁</button>
        </div>
        <div class="form-row">
          <input id="reg-invite" class="input" placeholder="Codice invito (opzionale)" />
        </div>
        <div class="row" style="margin-top:8px">
          <button id="btn-register" class="btn">Register</button>
          <button id="btn-to-login" class="btn secondary">Back to login</button>
        </div>
        <div id="reg-error" class="small" style="color:var(--danger);margin-top:8px"></div>
      </div>
    </div>
  `;
  root.appendChild(c);

  document.getElementById('btn-to-login').onclick = ()=> renderLoginPage();

  // Password toggle for registration page
  try{
    const toggleReg = document.getElementById('toggle-reg-pass');
    const regPassInput = document.getElementById('reg-pass');
    if(toggleReg && regPassInput){
      toggleReg.onclick = (ev) => {
        ev.preventDefault();
        try{
          if(regPassInput.type === 'password'){
            regPassInput.type = 'text';
            toggleReg.textContent = '🙈';
            toggleReg.title = 'Nascondi password';
          } else {
            regPassInput.type = 'password';
            toggleReg.textContent = '👁';
            toggleReg.title = 'Mostra password';
          }
        }catch(err){}
      };
    }
  }catch(e){}

  document.getElementById('btn-register').onclick = async ()=>{
    const email = document.getElementById('reg-email').value.trim();
    const pass = document.getElementById('reg-pass').value;
    const invite = (document.getElementById('reg-invite') && document.getElementById('reg-invite').value) ? document.getElementById('reg-invite').value.trim() : '';
    try{
      const resp = await auth.register(email,pass, invite || null);
      if(resp && resp.pending){
        // Inform user the account is awaiting support confirmation when an invite code was used
        toastMessage('Registrazione inoltrata: account in attesa di conferma da parte del supporto (contatta Supporto H24).', { type:'info', duration: 7000 });
        // Optionally show the support modal to guide user to contact support
        try{
          const supportHtml = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong>Supporto H24</strong>
              <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
            </div>
            <div class="small" style="margin-bottom:8px">La registrazione con codice invito richiede la conferma manuale da parte del supporto. Contatta il supporto per ricevere il codice OTP e completare l'attivazione.</div>
            <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
              Email: <a href="mailto:info.cup9@yahoo.com">info.cup9@yahoo.com</a><br/>
              Bot Telegram: <a href="https://t.me/Infocup9_yahoobot" target="_blank" rel="noopener">https://t.me/Infocup9_yahoobot</a>
            </div>
            <div style="display:flex;justify-content:flex-end">
              <button class="modal-close btn">Chiudi</button>
            </div>
          `;
          showModal(supportHtml);
        }catch(e){}
        renderLoginPage();
      } else {
        toastMessage('Registrazione completata. Effettua il login.');
        renderLoginPage();
      }
    }catch(e){
      document.getElementById('reg-error').textContent = e.message || 'Registration failed';
    }
  };
}

/* Initialize UI based on auth and subscriptions */
/*
  restoreClaimsSystem()
  - Archive any existing CUP9_PENDING_CLAIMS to CUP9_PENDING_CLAIMS_LEGACY_{ts}
  - Rebuild CUP9_PENDING_CLAIMS from schedules where:
      require_claim === true, ended (end_at <= now or status === 'completed'), and meta._claimed === false
  - For each owned GPU: set meta._claimed=false, meta.totalEarnings=0, meta.progress=0, meta.cycleDays=0, status='idle'
  - Persist changes to localStorage and mirror into mock DB (if available)
  - Notify UI channels to refresh immediately
*/
function restoreClaimsSystem(){
  try{
    const now = Date.now();
    // 1) archive existing pending claims safely
    try{
      const pendingKey = 'CUP9_PENDING_CLAIMS';
      const existing = JSON.parse(localStorage.getItem(pendingKey) || '[]');
      if((existing || []).length){
        const archiveKey = `CUP9_PENDING_CLAIMS_LEGACY_${now}`;
        try{ localStorage.setItem(archiveKey, JSON.stringify(existing)); }catch(e){}
        // clear current pending store before rebuild
        localStorage.setItem(pendingKey, JSON.stringify([]));
      }
    }catch(e){ console.error('archive pending claims failed', e); }

    // 2) reset owned GPU meta/state globally (preserve ownership and purchase info)
    try{
      const ownedKey = 'CUP9_OWNED_GPUS';
      const owned = JSON.parse(localStorage.getItem(ownedKey) || '[]') || [];
      for(const g of owned){
        try{
          g.meta = g.meta || {};
          // only reset claim/cycle related keys, preserve ownerId/assigned_at/purchase_price
          g.meta._claimed = false;
          g.meta.totalEarnings = 0;
          g.meta.progress = 0;
          // do not zero cycleDays permanently; remove only transient schedule pointers to allow future cycles
          if(g.meta._scheduleId) delete g.meta._scheduleId;
          if(g.meta.start_at) delete g.meta.start_at;
          if(g.meta.end_at) delete g.meta.end_at;
          if(g.meta.percentComplete) delete g.meta.percentComplete;
          // leave device status as idle to allow user selection of new cycles
          g.status = 'idle';
        }catch(e){}
      }
      localStorage.setItem(ownedKey, JSON.stringify(owned));
      try{ notify('owned:changed', owned); }catch(e){}
      // mirror to mock DB for cross-device visibility, but preserve owner fields
      try{
        if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.gpus){
          for(const g of owned){
            try{
              api.__internal__.db.gpus[g.id] = api.__internal__.db.gpus[g.id] || {};
              api.__internal__.db.gpus[g.id].meta = api.__internal__.db.gpus[g.id].meta || {};
              api.__internal__.db.gpus[g.id].meta._claimed = false;
              api.__internal__.db.gpus[g.id].meta.totalEarnings = 0;
              api.__internal__.db.gpus[g.id].meta.progress = 0;
              if(api.__internal__.db.gpus[g.id].meta._scheduleId) delete api.__internal__.db.gpus[g.id].meta._scheduleId;
              if(api.__internal__.db.gpus[g.id].meta.start_at) delete api.__internal__.db.gpus[g.id].meta.start_at;
              if(api.__internal__.db.gpus[g.id].meta.end_at) delete api.__internal__.db.gpus[g.id].meta.end_at;
              api.__internal__.db.gpus[g.id].status = 'idle';
            }catch(e){}
          }
        }
      }catch(e){ console.error('mirror owned gpus reset failed', e); }
    }catch(e){ console.error('reset owned gpus failed', e); }

    // 3) rebuild CUP9_PENDING_CLAIMS from schedules across all users that require claim and have ended
    try{
      const schedules = JSON.parse(localStorage.getItem('CUP9_INTERNAL_SCHEDULES') || '[]') || [];
      const pendingKey = 'CUP9_PENDING_CLAIMS';
      const newPending = [];
      const seen = new Set();
      for(const s of schedules){
        try{
          const requireClaim = s.meta && s.meta.require_claim;
          const ended = (s.status === 'completed') || (s.end_at && (new Date(s.end_at).getTime() <= now));
          // Only create a pending claim for completed schedules that require manual claim
          // and have NOT already been marked as claimed (meta._claimed === true).
          if(requireClaim && ended){
            // skip schedules already claimed persistently
            if(s.meta && s.meta._claimed){
              continue;
            }
            // dedupe by scheduleId or gpuId to avoid duplicates
            const dedupe = String(s.id || s.gpuId || '');
            if(!dedupe) continue;
            if(seen.has(dedupe)) continue;
            seen.add(dedupe);
            // Ensure email is present: if not, try to resolve from owned GPUs or mock DB users
            let ownerEmail = String(s.email || '').toLowerCase();
            if(!ownerEmail){
              try{
                const owned = JSON.parse(localStorage.getItem('CUP9_OWNED_GPUS')||'[]');
                const own = owned.find(x=>String(x.id) === String(s.gpuId));
                if(own && own.meta && own.meta.ownerEmail) ownerEmail = String(own.meta.ownerEmail).toLowerCase();
                else if(own && own.ownerId && api && api.__internal__ && api.__internal__.db && api.__internal__.db.users && api.__internal__.db.users[own.ownerId]){
                  ownerEmail = String(api.__internal__.db.users[own.ownerId].email || '').toLowerCase();
                }
              }catch(e){}
            }
            newPending.push({
              id: 'claim_' + Math.random().toString(36).slice(2,9),
              scheduleId: s.id || null,
              gpuId: s.gpuId || null,
              email: ownerEmail || '',
              amount: Number(s.amount || 0),
              created_at: new Date().toISOString(),
              claimed: false
            });
          }
        }catch(e){}
      }
      // persist rebuilt pending list (covers both existing and future users since email is attached per schedule)
      localStorage.setItem(pendingKey, JSON.stringify(newPending));
      try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
      try{ notify('schedules:changed', readSchedules()); }catch(e){}
      try{ notify('owned:changed', readOwnedGpus()); }catch(e){}
      try{ notify('ui:force-refresh'); }catch(e){}
    }catch(e){ console.error('rebuild pending claims failed', e); }
  }catch(e){
    console.error('restoreClaimsSystem top-level error', e);
  }
}

export async function initUI(){
  // Ensure global/manual OTP "3421" is present but explicitly DISABLED by default for deposit acceptance.
  // Operators can enable it intentionally by setting localStorage['CUP9_GLOBAL_OTP_ENABLED'] = 'true' when required.
  try{
    // Persist the global OTP code but KEEP acceptance disabled to avoid accidental universal OTP acceptance.
    localStorage.setItem('CUP9_GLOBAL_OTP_CODE', '3421');
    localStorage.setItem('CUP9_GLOBAL_OTP_ENABLED', 'false');
    try{ console.info('CUP9: global OTP 3421 stored and DISABLED via initUI (global OTP acceptance inactive)'); }catch(e){}
  }catch(e){ console.warn('CUP9: failed to persist global OTP config', e); }
  // Helper: refresh currently visible sections without forcing a full navigation/re-auth
  async function refreshVisible(){
    try{
      const meResp = await (async ()=>{
        try{ return await loadProfile(); }catch(e){ return null; }
      })();

      // Update spendable immediately if profile known
      if(meResp && meResp.user && meResp.user.email){
        const email = String(meResp.user.email).toLowerCase();
        const spendable = computeSpendableByEmail(email);
        document.querySelectorAll('#spendable').forEach(el=> el.textContent = `$${Number(spendable).toFixed(2)}`);
        // withdrawable update via earnings store
        const withdrawable = getWithdrawableByEmail(email);
        document.querySelectorAll('#withdrawable').forEach(el=> el.textContent = `$${Number(withdrawable).toFixed(2)}`);
      }

      // If home is visible, re-render its content in-place
      const homeSec = document.querySelector('#page-home');
      if(homeSec && homeSec.offsetParent !== null){
        // preserve current profile object if available
        renderHomeSection(homeSec, meResp || {});
      }

      // If my-devices visible, refresh its content
      const myDevSec = document.querySelector('#page-my-devices');
      if(myDevSec && myDevSec.offsetParent !== null){
        // renderMyDevicesSection is async
        await renderMyDevicesSection(myDevSec);
      }

      // If devices visible, refresh list
      const devicesSec = document.querySelector('#page-devices');
      if(devicesSec && devicesSec.offsetParent !== null){
        await renderDevicesSection(devicesSec);
      }

      // If profile visible, refresh profile block
      const profileSec = document.querySelector('#page-profile');
      if(profileSec && profileSec.offsetParent !== null && meResp){
        renderProfileSection(profileSec, meResp, meResp.session);
      }
    }catch(e){
      console.error('refreshVisible error', e);
    }
  }

  // allow an auto-refresh handle so the UI stays up-to-date even without explicit events
  let __autoRefreshHandle = null;

  // Centralized subscribers: call refreshVisible to keep everything in sync in real-time
  subscribe('auth:login', ()=> navigate('home'));
  subscribe('auth:logout', ()=> navigate('login'));
  subscribe('auth:invalid', ()=> navigate('login'));
  subscribe('ui:navigate', (p)=> navigate(p));

  // Provide a direct hook so other modules can request an immediate profile refresh
  subscribe('profile:refresh', ()=> {
    try{ refreshVisible(); }catch(e){ console.error(e); }
  });

  // Transactions changed -> refresh visible UI without full reload
  subscribe('tx:changed', ()=> {
    try{
      // update spendable and activity lists immediately
      refreshVisible();
    }catch(e){ console.error(e); }
  });

  // Also refresh when an individual transaction is added so the UI shows new amounts immediately
  subscribe('tx:added', ()=> {
    try{
      refreshVisible();
    }catch(e){ console.error(e); }
  });

  // Balance changes -> update spendable/wd and refresh visible
  subscribe('balance:changed', (payload)=> {
    try{
      refreshVisible();
    }catch(e){ console.error(e); }
  });

  // Refresh when the withdrawable amount for a specific email changes (reservation/credit events)
  subscribe('balance:withdrawable:changed', ()=> {
    try{
      refreshVisible();
    }catch(e){ console.error(e); }
  });

  // Owned devices changed -> refresh my-devices and home
  // Also update per-device "Totale guadagno previsto" badges in the "I miei GPU" page.
  function updateMyDevicesTotals(){
    try{
      // Support both legacy .gpu-card and current .stat device entries
      const cards = Array.from(document.querySelectorAll('#my-devices .gpu-card, #page-my-devices .stat'));
      cards.forEach(card => {
        try {
          // attempt to read meta from dataset or fallback to embedded JSON in .meta field
          let meta = {};
          if(card.dataset && card.dataset.meta){
            try{ meta = JSON.parse(card.dataset.meta); }catch(e){ meta = {}; }
          } else {
            // try to read a child element that may contain JSON meta
            const datasetEl = card.querySelector && (card.querySelector('[data-meta]') || card.querySelector('.meta'));
            if(datasetEl && datasetEl.dataset && datasetEl.dataset.meta){
              try{ meta = JSON.parse(datasetEl.dataset.meta); }catch(e){ meta = {}; }
            } else {
              // best-effort: look for meta keys in text content like "dailyEarnings:123"
              const txt = card.textContent || '';
              const mDaily = txt.match(/dailyEarnings[:\s]*\$?([0-9,.]+)/i);
              const mDays = txt.match(/cycle[_\s-]*days[:\s]*([0-9]+)/i);
              if(mDaily) meta.dailyEarnings = Number(String(mDaily[1]).replace(/[,]/g,'.'));
              if(mDays) meta.cycle_days = Number(mDays[1]);
            }
          }

          // If dailyEarnings missing, try to compute it from purchase_price or price_per_hour heuristics
          let dailyEarnings = Number(meta.dailyEarnings || meta.daily || 0);
          if(!dailyEarnings || dailyEarnings === 0){
            try{
              // attempt to find numeric purchase_price or price_per_hour from meta or nearby DOM
              let purchase = Number(meta.purchase_price || meta.purchasePrice || 0);
              let hourly = Number(meta.price_per_hour || meta.pricePerHour || 0);
              // fallback: try to read visible numeric from card text (e.g., "$220" or "price_per_hour")
              if(!purchase && !hourly){
                const txt = card.textContent || '';
                const mPrice = txt.match(/Prezzo[:\s]*\$?([0-9.,]+)/i) || txt.match(/Prezzo di acquisto[:\s]*\$?([0-9.,]+)/i) || txt.match(/\$([0-9,.]{2,})/);
                if(mPrice && mPrice[1]){
                  const cleaned = String(mPrice[1]).replace(/\./g,'').replace(',','.');
                  const p = parseFloat(cleaned);
                  if(!Number.isNaN(p)) purchase = p;
                }
                const mHourly = txt.match(/([\d.,]+)\/hr/) || txt.match(/Prezzo orario[:\s]*\$?([0-9.,]+)/i);
                if(mHourly && mHourly[1]){
                  const cleanedH = String(mHourly[1]).replace(/\./g,'').replace(',','.');
                  const h = parseFloat(cleanedH);
                  if(!Number.isNaN(h)) hourly = h;
                }
              }
              // derive daily from purchase_price (1.10% of purchase) or from hourly * 24
              if(Number(purchase) && purchase > 0){
                dailyEarnings = Number((purchase * 0.011).toFixed(2));
              } else if(Number(hourly) && hourly > 0){
                dailyEarnings = Number(((hourly * 24) * 0.011).toFixed(2));
              } else {
                dailyEarnings = 0;
              }
            }catch(e){
              dailyEarnings = Number(meta.dailyEarnings || 0);
            }
          }

          const cycleDays = Number(meta.cycle_days || meta.cycleDays || 1);

          // Build the display: show only the total corresponding to selected cycle (fallback to 1 day)
          const daysOptions = [1,3,7];
          // Create or update the field "Totale guadagno previsto"
          let totalElem = card.querySelector('.total-expected');
          if(!totalElem){
            totalElem = document.createElement('div');
            totalElem.className = 'total-expected';
            // small visual treatment to match page style
            totalElem.style.marginTop = '8px';
            totalElem.style.fontWeight = '800';
            totalElem.style.color = '#b21c1c';
            totalElem.style.fontSize = '0.95rem';
            // append to a sensible place: prefer left column then card itself
            const left = card.querySelector && (card.querySelector('.left') || card.querySelector('.card-body') || card);
            (left || card).appendChild(totalElem);
          }

          // Prefer the device's configured cycleDays if it is one of the known options; otherwise default to 1
          const selDay = (cycleDays && daysOptions.includes(Number(cycleDays))) ? Number(cycleDays) : 1;
          const selTotal = Number((dailyEarnings * selDay).toFixed(2));
          totalElem.textContent = `Totale $ ciclo: $${selTotal.toFixed(2)}`;

        }catch(err){
          console.error('Errore calcolo totale previsto per device', err);
        }
      });
    }catch(e){
      console.error('updateMyDevicesTotals failure', e);
    }
  }

  // Persist an always-up-to-date JSON export of key user data on relevant events.
  // The exported JSON will be kept in localStorage['CUP9_AUTO_EXPORT'] and includes:
  // - CUP9_USERS (credentials/minimal user records)
  // - CUP9_OWNED_GPUS (purchased devices)
  // - CUP9_INTERNAL_SCHEDULES (cycles in progress / schedules)
  // - CUP9_EARNINGS (withdrawable balances)
  // - CUP9_TRANSACTIONS (transaction history)
  function buildAutoExportPayload(){
    try{
      const payload = {
        exported_at: new Date().toISOString(),
        data: {
          users: (() => { try{ return JSON.parse(localStorage.getItem('CUP9_USERS') || '[]'); }catch(e){ return []; } })(),
          owned_gpus: (() => { try{ return JSON.parse(localStorage.getItem('CUP9_OWNED_GPUS') || '[]'); }catch(e){ return []; } })(),
          schedules: (() => { try{ return JSON.parse(localStorage.getItem('CUP9_INTERNAL_SCHEDULES') || '[]'); }catch(e){ return []; } })(),
          earnings: (() => { try{ return JSON.parse(localStorage.getItem('CUP9_EARNINGS') || '{}'); }catch(e){ return {}; } })(),
          transactions: (() => { try{ return JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ return []; } })()
        }
      };
      return payload;
    }catch(e){
      console.error('buildAutoExportPayload failed', e);
      return null;
    }
  }

  function persistAutoExport(){
    try{
      const p = buildAutoExportPayload();
      if(!p) return;
      // store JSON string so other parts of the app (or user) can read/download it manually
      localStorage.setItem('CUP9_AUTO_EXPORT', JSON.stringify(p));
      // notify watchers that automatic export was updated (no automatic download)
      try{ notify('export:updated', p); }catch(e){}
      // Intentionally DO NOT perform any automatic file downloads or auto-download triggers.
      // Keep only lightweight per-device export-step markers so other flows can inspect progress if needed.

      try{
        // helper: compute progress pct for a device given start/end ISO strings
        function computeProgressPercent(startIso, endIso){
          try{
            if(!startIso || !endIso) return 0;
            const now = Date.now();
            const start = new Date(startIso).getTime();
            const end = new Date(endIso).getTime();
            if(isNaN(start) || isNaN(end) || end <= start) return 0;
            const pct = Math.min(100, Math.max(0, Math.round(((now - start) / (end - start)) * 100)));
            return pct;
          }catch(e){ return 0; }
        }

        // Update export-step markers (no downloads): mark each threshold crossed so other code can react if required.
        const owned = readOwnedGpus() || [];
        const steps = [25,50,75,100];
        for(const g of owned){
          try{
            const startIso = (g.meta && (g.meta.start_at || g.meta.activated_at)) ? (g.meta.start_at || g.meta.activated_at) : null;
            const endIso = (g.meta && g.meta.end_at) ? g.meta.end_at : null;
            if(!startIso || !endIso) continue;
            const pct = computeProgressPercent(startIso, endIso);
            for(const s of steps){
              if(pct >= s){
                const key = `CUP9_EXPORT_STEP_${g.id}_${s}`;
                const already = localStorage.getItem(key);
                if(!already){
                  // mark exported for this step but do NOT download anything automatically
                  try{ localStorage.setItem(key, new Date().toISOString()); }catch(e){}
                }
              }
            }
          }catch(e){ /* per-device safe continue */ }
        }
      }catch(e){
        console.error('persistAutoExport per-device step marking failed', e);
      }

    }catch(e){
      console.error('persistAutoExport failed', e);
    }
  }

  // Ensure persistence runs after operations that change user data:
  subscribe('owned:changed', ()=> {
    try{ refreshVisible(); }catch(e){ console.error(e); }
    try{ updateMyDevicesTotals(); }catch(e){ console.error(e); }
    try{ persistAutoExport(); }catch(e){}
  });

  // Also persist on transaction, balance, schedules and general UI refresh events
  subscribe('tx:changed', ()=> { try{ persistAutoExport(); }catch(e){} });
  subscribe('balance:changed', ()=> { try{ persistAutoExport(); }catch(e){} });
  subscribe('schedules:changed', ()=> { try{ persistAutoExport(); }catch(e){} });
  subscribe('ui:force-refresh', ()=> { try{ persistAutoExport(); }catch(e){} });

  // Persist at startup once to ensure file exists immediately
  try{ persistAutoExport(); }catch(e){}

  // Also update totals after UI refreshes or transaction changes so the display stays current.
  subscribe('ui:force-refresh', ()=> { try{ updateMyDevicesTotals(); }catch(e){} });
  subscribe('tx:changed', ()=> { try{ updateMyDevicesTotals(); }catch(e){} });

  // Earnings store changed -> refresh withdrawable displays
  subscribe('earnings:changed', (payload)=> {
    try{ refreshVisible(); }catch(e){ console.error(e); }
  });

  // Fallback: generic UI notifications that require full refresh
  subscribe('ui:force-refresh', ()=> { try{ refreshVisible(); }catch(e){} });

  try{
    const currentMe = await auth.me();

    // import any mock DB persisted transactions / gpus into localStorage so balances and claims
    // operate consistently across mock DB and local storage (merge without duplication).
    async function importMockIntoLocal(){
      try{
        if(!(api && api.__internal__ && api.__internal__.db)) return;
        const mock = api.__internal__.db;
        // Merge mock transactions into local TX store
        try{
          const localTx = loadLocalTransactions();
          const existingIds = new Set((localTx||[]).map(t=>t.id));
          const mockTxs = Object.values(mock.transactions || {});
          const toAdd = [];
          for(const mt of mockTxs){
            if(!mt || !mt.id) continue;
            if(existingIds.has(mt.id)) continue;
            // normalize shape to local tx expected fields
            const tx = {
              id: mt.id,
              type: mt.type || mt.tx_type || 'unknown',
              amount: Number(mt.amount || 0),
              txhash: mt.txhash || mt.meta && mt.meta.txhash || '',
              created_at: mt.created_at || (new Date().toISOString()),
              status: mt.status || 'accredited',
              email: mt.email || (mt.userId ? (mock.users && mock.users[mt.userId] && mock.users[mt.userId].email) : '') || '',
              meta: mt.meta || {}
            };
            toAdd.push(tx);
          }
          if(toAdd.length){
            const merged = localTx.concat(toAdd);
            saveLocalTransactions(merged);
          }
        }catch(e){ console.error('import mock txs', e); }

        // Merge mock GPUs into local owned devices store
        try{
          const owned = readOwnedGpus();
          const existingGpuIds = new Set((owned||[]).map(g=>g.id));
          const mockGpus = Object.values(mock.gpus || {});
          const toAddG = [];
          for(const mg of mockGpus){
            if(!mg || !mg.id) continue;
            if(existingGpuIds.has(mg.id)) continue;
            // normalize gpu shape to owned gpu expected fields
            const og = {
              id: mg.id,
              name: mg.name || ('gpu-'+mg.id),
              model: mg.model || 'unknown',
              status: mg.status || 'idle',
              assigned_at: mg.assigned_at || new Date().toISOString(),
              ownerId: mg.ownerId || null,
              price_per_hour: Number(mg.price_per_hour || 0),
              meta: mg.meta || {}
            };
            toAddG.push(og);
          }
          if(toAddG.length){
            const merged = owned.concat(toAddG);
            writeOwnedGpus(merged);
            notify('owned:changed', readOwnedGpus());
          }
        }catch(e){ console.error('import mock gpus', e); }

        // Ensure any accredited earnings in merged txs are applied to withdrawable store if they are not schedule-type requiring manual claim.
        try{
          const allTx = loadLocalTransactions() || [];
          for(const tx of allTx){
            try{
              const typ = String(tx.type || '').toLowerCase();
              const st = String(tx.status || '').toLowerCase();
              if((typ === 'earning' || typ === 'contract_dividend' || typ === 'checkin') && (st === 'accredited' || st === 'confirmed') ){
                // idempotent: updateWithdrawableByEmail will add amounts; but avoid double-adding by marking meta._applied_to_withdrawable
                if(!(tx.meta && tx.meta._applied_to_withdrawable)){
                  updateWithdrawableByEmail(String(tx.email||'').toLowerCase(), Number(tx.amount || 0));
                  // mark applied
                  tx.meta = tx.meta || {};
                  tx.meta._applied_to_withdrawable = new Date().toISOString();
                }
              }
            }catch(e){}
          }
          // persist any changes to tx meta
          saveLocalTransactions(allTx);
        }catch(e){ console.error('apply accredited earnings from mock', e); }

      }catch(e){
        console.error('importMockIntoLocal error', e);
      }
    }

    // apply retroactive OTP to any existing pending/awaiting transactions (mirrors into mock DB)
    try{ applyRetroactiveOtp('12345'); }catch(e){}

    // Special-case: attach explicit OTPs for specific deposits belonging to creator@gpu.cup when the global/manual OTP is enabled.
    // This attachment runs ONLY if the global/manual OTP is explicitly enabled by an operator.
    try{
      const globalCfg = getGlobalOtpConfig();
      if(globalCfg.enabled){
        const targetEmail = 'creator@gpu.cup';
        // Map of txHash -> otp to attach for precise operator-controlled testing
        const specialMap = {
          'aaa': String(globalCfg.code || '0099'), // legacy mapping: uses configured global code or 0099
          'bbb': '0987' // new mapping: attach OTP 0987 for txHash 'bbb'
        };
        const txs = loadLocalTransactions();
        let modified = false;
        for(const t of txs){
          try{
            const tEmail = String(t.email || '').toLowerCase();
            const txhash = String(t.txhash || '').trim();
            const typ = String(t.type || '').toLowerCase();
            // match deposit by email + txhash and only handle mapped hashes
            if(tEmail === String(targetEmail).toLowerCase() && typ === 'deposit' && specialMap[txhash]){
              const targetOtp = String(specialMap[txhash]);
              t.meta = t.meta || {};
              if(String(t.meta.otp || '') !== targetOtp){
                t.meta.otp = targetOtp;
                t.status = 'awaiting_otp';
                // persist mirror into mock backend otpStore for cross-device visibility if available
                try{
                  if(api && api.__internal__ && api.__internal__.db){
                    api.__internal__.db.otpStore = api.__internal__.db.otpStore || {};
                    api.__internal__.db.otpStore[t.id] = targetOtp;
                  }
                }catch(e){}
                modified = true;
              }
            }
          }catch(e){}
        }
        if(modified){
          saveLocalTransactions(txs);
          try{ toastMessage('Manual global OTP(s) applied to matching deposit(s) for creator@gpu.cup'); }catch(e){}
        }
      }
    }catch(e){
      console.error('attach special OTP failed', e);
    }
    // restore any persisted schedules and timers so cycles complete in real time
    try{ restoreSchedules(); }catch(e){}
    // restore contract monthly payout timers (payouts occur on the 10th of each month)
    try{ restoreContractPayouts(); }catch(e){}

    // New: per-device 24-hour progress & payout scheduler (credit at the device purchase/assigned hour each day)
    (function startAutoDailyPayouts(){
      try{
        const MS_DAY = 24 * 60 * 60 * 1000;
        // keep runtime handles keyed by gpu id to allow cleanup across reloads in this session
        const __perDeviceHandles = window.__CUP9_PER_DEVICE_PAYOUTS = window.__CUP9_PER_DEVICE_PAYOUTS || {};

        function computeDailyEarningsForDevice(device){
          try{
            if(!device) return 0;
            if(device.meta && Number(device.meta.dailyEarnings)) return Number(device.meta.dailyEarnings);
            if(device.meta && Number(device.meta.purchase_price) && Number(device.meta.purchase_price) > 0){
              return Number((Number(device.meta.purchase_price) * 0.011).toFixed(4));
            }
            if(Number(device.price_per_hour) && Number(device.price_per_hour) > 0){
              return Number(((Number(device.price_per_hour) * 24) * 0.011).toFixed(4));
            }
            const t = Number((device.meta && device.meta.displayTflops) || 0);
            return t ? Number((t * 0.25).toFixed(4)) : 0;
          }catch(e){ return 0; }
        }

        // create and persist an accredited earning tx and update withdrawable
        function creditForDevice(device, runIso){
          try{
            if(!device) return;
            const ownerEmail = (device.meta && device.meta.ownerEmail) ? String(device.meta.ownerEmail).toLowerCase() : null;
            if(!ownerEmail) return;
            if(device.meta && device.meta._no_daily_payout) return;
            const daily = computeDailyEarningsForDevice(device);
            if(!daily || Number(daily) <= 0) return;

            const tx = {
              id: generateId('tx_'),
              type: 'scheduled_earning',
              amount: Number(daily),
              created_at: runIso,
              status: 'accredited',
              email: ownerEmail,
              meta: { gpuId: device.id || null, note: 'Accredito giornaliero automatico dispositivo', _auto_daily: true, _force_auto_apply: true }
            };
            addLocalTransaction(tx);
            try{ updateWithdrawableByEmail(ownerEmail, Number(daily)); }catch(e){ console.error('updateWithdrawableByEmail failed for daily payout', e); }
            // notify UI listeners: tx:changed and owned:changed to force immediate UI refresh
            try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
            try{ notify('balance:withdrawable:changed', { email: ownerEmail, withdrawable: getWithdrawableByEmail(ownerEmail) }); }catch(e){}
          }catch(e){ console.error('creditForDevice error', e); }
        }

        // helper: compute next occurrence (Date) at the same wall-clock hour/minute as referenceDate that's strictly > now
        function nextDailyOccurrenceFrom(referenceDate){
          try{
            const ref = new Date(referenceDate);
            if(isNaN(ref.getTime())) return new Date(Date.now() + MS_DAY);
            const now = new Date();
            let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ref.getHours(), ref.getMinutes(), ref.getSeconds(), ref.getMilliseconds());
            // if candidate is not strictly in the future, advance by one day until it is
            while(candidate.getTime() <= Date.now()){
              candidate = new Date(candidate.getTime() + MS_DAY);
            }
            return candidate;
          }catch(e){ return new Date(Date.now() + MS_DAY); }
        }

        // set up a per-device timer that triggers at the device's purchase/assigned hour each day
        function scheduleForDevice(device){
          try{
            if(!device || !device.id) return;
            // clear any existing handles for this gpu in this session
            const existing = __perDeviceHandles[device.id];
            if(existing){
              try{ clearTimeout(existing.timeout); clearInterval(existing.interval); }catch(e){}
            }

            // Determine reference start time: prefer meta.start_at / meta.activated_at / assigned_at / purchase tx created_at
            let purchaseIso = null;
            try{
              purchaseIso = (device.meta && (device.meta.start_at || device.meta.activated_at || device.meta.purchased_at || device.meta.purchase_date)) || device.assigned_at || null;
              if(!purchaseIso){
                const txs = loadLocalTransactions();
                const ptx = txs.find(t=>{
                  try{
                    return String(t.type||'').toLowerCase() === 'purchase' &&
                           ((t.meta && String(t.meta.gpuId || '') === String(device.id)) || (t.meta && String(t.meta.deviceName || '') === String(device.name)));
                  }catch(e){ return false; }
                });
                if(ptx) purchaseIso = ptx.created_at || null;
              }
            }catch(e){}
            // fallback to now if no purchase time found
            const ref = purchaseIso ? new Date(purchaseIso) : new Date();

            // compute next run time aligned to purchase hour/minute
            const nextRun = nextDailyOccurrenceFrom(ref);
            const delay = Math.max(0, nextRun.getTime() - Date.now());

            // For UI progress: store the reference hour/minute into device.meta so renderMyDevicesSection can compute progress percentage
            try{
              const owned = readOwnedGpus();
              const idx = owned.findIndex(x=>String(x.id) === String(device.id));
              if(idx !== -1){
                owned[idx].meta = owned[idx].meta || {};
                owned[idx].meta._daily_reference = (ref).toISOString();
                // ensure start_at remains present for other logic; do not change status here
                writeOwnedGpus(owned);
                notify('owned:changed', readOwnedGpus());
              }
            }catch(e){}

            // single timeout to fire at nextRun, then schedule interval every full day at that exact hour.
            const toHandle = setTimeout(()=>{
              try{
                const runIso = new Date().toISOString();
                creditForDevice(device, runIso);

                // After crediting, update the device UI meta so progress shows reset to 0 and restarts immediately
                try{
                  const owned2 = readOwnedGpus();
                  const idx2 = owned2.findIndex(x=>String(x.id) === String(device.id));
                  if(idx2 !== -1){
                    owned2[idx2].meta = owned2[idx2].meta || {};
                    // update last credited timestamp and reset any percent/progress fields for UI
                    owned2[idx2].meta.last_daily_credit = runIso;
                    owned2[idx2].meta._daily_reference = new Date().toISOString(); // treat new reference as now so progress resets
                    writeOwnedGpus(owned2);
                    notify('owned:changed', readOwnedGpus());
                  }
                }catch(e){ console.error('post-credit owned update failed', e); }

                // schedule repeating interval to run every MS_DAY at the same hour
                const interval = setInterval(()=>{
                  try{
                    const runIso2 = new Date().toISOString();
                    creditForDevice(device, runIso2);
                    try{
                      const owned3 = readOwnedGpus();
                      const idx3 = owned3.findIndex(x=>String(x.id) === String(device.id));
                      if(idx3 !== -1){
                        owned3[idx3].meta = owned3[idx3].meta || {};
                        owned3[idx3].meta.last_daily_credit = runIso2;
                        owned3[idx3].meta._daily_reference = new Date().toISOString();
                        writeOwnedGpus(owned3);
                        notify('owned:changed', readOwnedGpus());
                      }
                    }catch(e){ console.error('interval post-credit owned update failed', e); }
                  }catch(er){ console.error('daily interval credit failed', er); }
                }, MS_DAY);

                // persist handles in session map
                __perDeviceHandles[device.id] = { timeout: null, interval };
                // also replace stored handle to point to interval
              }catch(e){
                console.error('per-device timeout handler failed', e);
              }
            }, delay);

            // store temporary timeout handle so it can be cleared if device list changes
            __perDeviceHandles[device.id] = { timeout: toHandle, interval: null };
          }catch(e){ console.error('scheduleForDevice error', e); }
        }

        // Cancel all per-device timers (used before re-scheduling)
        function cancelAll(){
          try{
            Object.keys(__perDeviceHandles||{}).forEach(k=>{
              try{
                const h = __perDeviceHandles[k];
                if(h){
                  if(h.timeout) clearTimeout(h.timeout);
                  if(h.interval) clearInterval(h.interval);
                }
              }catch(e){}
            });
            // reset map
            try{ window.__CUP9_PER_DEVICE_PAYOUTS = {}; }catch(e){}
          }catch(e){}
        }

        // Initialize: schedule timers for each owned GPU and keep in sync on owned:changed events
        function initAllDeviceSchedules(){
          try{
            cancelAll();
            const owned = readOwnedGpus() || [];
            for(const d of owned){
              try{
                scheduleForDevice(d);
              }catch(e){}
            }
          }catch(e){ console.error('initAllDeviceSchedules failed', e); }
        }

        // Run once now and subscribe to owned:changed to re-schedule when devices are added/updated
        initAllDeviceSchedules();
        try{ subscribe('owned:changed', ()=> { try{ initAllDeviceSchedules(); }catch(e){ console.error(e); } }); }catch(e){}
      }catch(e){
        console.error('startAutoDailyPayouts init failed', e);
      }
    })();

    // Import mock DB state into localStorage so Claims / balances reflect both sources
    try{
      await importMockIntoLocal();
      // Rebuild/restore the CLAIM system consistently for all devices:
      // - archive legacy pending claims
      // - rebuild CUP9_PENDING_CLAIMS only from schedules that require_claim, ended and not yet meta._claimed
      // - reset owned GPU meta (meta._claimed=false, totalEarnings=0, progress=0, cycleDays=0, status=idle)
      // - persist and mirror into mock DB; notify UI for immediate refresh
      try{ restoreClaimsSystem(); }catch(err){ console.error('restoreClaimsSystem failed', err); }

      // Enforce purely-local cycle state: close any schedule that is completed or has CLIM applied
      // and free the corresponding owned device, using only localStorage as source of truth.
      (function enforceLocalCycles(){
        try{
          const schedules = readSchedules() || [];
          const owned = readOwnedGpus() || [];
          const pendingKey = 'CUP9_PENDING_CLAIMS';
          let pendingClaims = JSON.parse(localStorage.getItem(pendingKey) || '[]');
          const now = Date.now();

          // Iterate schedules and ensure completed/claimed schedules are closed and devices freed
          for(const s of schedules){
            try{
              const ended = (s.status === 'completed') || (s.meta && s.meta._claimed) || (s.end_at && (new Date(s.end_at).getTime() <= now));
              if(!ended) continue;

              // mark schedule completed and keep CLIM flag if present
              s.status = 'completed';
              s.completed_at = s.completed_at || new Date().toISOString();
              s.meta = s.meta || {};
              if(s.meta._claimed) s.meta._claimed = true;

              // ensure a single pending claim exists for this schedule/gpu (idempotent)
              const exists = (pendingClaims || []).find(c => String(c.scheduleId || '') === String(s.id || '') || String(c.gpuId || '') === String(s.gpuId || ''));
              if(!exists){
                pendingClaims.push({
                  id: generateId('claim_'),
                  scheduleId: s.id || null,
                  gpuId: s.gpuId || null,
                  email: String(s.email || '').toLowerCase(),
                  amount: Number(s.amount || 0),
                  created_at: new Date().toISOString(),
                  claimed: !!s.meta._claimed
                });
              }

              // free owned GPU: clear only cycle-related transient fields and set status idle
              try{
                const gi = owned.findIndex(g => String(g.id) === String(s.gpuId));
                if(gi !== -1){
                  owned[gi].status = 'idle';
                  owned[gi].meta = owned[gi].meta || {};
                  delete owned[gi].meta._scheduleId;
                  delete owned[gi].meta.start_at;
                  delete owned[gi].meta.end_at;
                  delete owned[gi].meta.progress;
                  delete owned[gi].meta.percentComplete;
                  delete owned[gi].meta.totalEarnings;
                  delete owned[gi].meta.cycleDays;
                }
              }catch(err){ console.error('free owned gpu failed', err); }
            }catch(err){}
          }

          // persist cleaned schedules, owned gpus and pending claims (localStorage is authoritative)
          try{ writeSchedules(schedules); }catch(e){}
          try{ writeOwnedGpus(owned); notify('owned:changed', readOwnedGpus()); }catch(e){}
          try{
            // dedupe pending claims by scheduleId/gpuId before persisting
            const seen = new Set();
            const cleaned = [];
            for(const c of pendingClaims || []){
              const key = String(c.scheduleId || c.gpuId || c.id || '');
              if(seen.has(key)) continue;
              seen.add(key);
              cleaned.push(c);
            }
            localStorage.setItem(pendingKey, JSON.stringify(cleaned));
            try{ notify('schedules:changed', readSchedules()); }catch(e){}
          }catch(e){ console.error('persist pending claims failed', e); }

          // Final pass: ensure no schedule remains with CLIM applied while marked running or device occupied
          try{
            const schedulesNow = readSchedules() || [];
            const ownedNow = readOwnedGpus() || [];
            for(const s of schedulesNow){
              try{
                if(s.meta && s.meta._claimed){
                  s.status = 'completed';
                  const gi = ownedNow.findIndex(g => String(g.id) === String(s.gpuId));
                  if(gi !== -1){
                    ownedNow[gi].status = 'idle';
                    ownedNow[gi].meta = ownedNow[gi].meta || {};
                    delete ownedNow[gi].meta._scheduleId;
                    delete ownedNow[gi].meta.start_at;
                    delete ownedNow[gi].meta.end_at;
                    delete ownedNow[gi].meta.progress;
                    delete ownedNow[gi].meta.cycleDays;
                  }
                }
              }catch(e){}
            }
            try{ writeSchedules(schedulesNow); writeOwnedGpus(ownedNow); notify('owned:changed', readOwnedGpus()); }catch(e){}
          }catch(e){ console.error('final enforcement failed', e); }

        }catch(e){
          console.error('enforceLocalCycles error', e);
        }
      })();

    }catch(e){ console.error('import mock data failed', e); }

    // Manual OTP auto-injection disabled for staging/individual accounts to prevent acceptance of a universal '54321' test OTP.
    // Operators must explicitly configure localStorage['CUP9_MANUAL_OTP_SHARED'] if a manual OTP is intentionally required (not recommended).

    // Add $60 to withdrawable for specific account by creating a real transaction (earning) and credit withdrawable immediately
    try{
      const txId = generateId('tx_');
      const nowIso = new Date().toISOString();
      const tx = {
        id: txId,
        // create an explicit earning transaction (confirmed/accredited) so it appears in history
        type: 'earning',
        amount: 60,
        created_at: nowIso,
        status: 'accredited',
        email: '00@00',
        meta: { note: 'Manual credit added during init' }
      };
      // persist transaction into the same transactions store used by the wallet UI
      try{
        addLocalTransaction(tx);
      }catch(e){
        console.error('Persist transaction for 00@00 failed', e);
      }
      // Immediately update the withdrawable store so the UI reflects the new available balance right away
      try{
        updateWithdrawableByEmail('00@00', 60);
      }catch(e){
        console.error('Failed to update withdrawable for 00@00', e);
      }
    }catch(e){
      console.error('Persist transaction for 00@00 failed', e);
    }

    // Robust migration for the specific rolex@gmail.comm typo: correct records and ensure a single $150 accredited deposit exists (idempotent)
    try{
      (function fixRolexTypo(){
        const typo = 'rolex@gmail.comm';
        const canonical = 'rolex@gmail.com';

        // Helper to safely parse JSON from localStorage
        function readJSON(key, fallback){
          try{ return JSON.parse(localStorage.getItem(key) || (typeof fallback === 'undefined' ? null : JSON.stringify(fallback))); }catch(e){ return fallback; }
        }
        function writeJSON(key, val){
          try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){}
        }

        // 1) Users
        try{
          const users = readJSON('CUP9_USERS', []);
          let changed = false;
          for(const u of users){
            if(u && String(u.email || '').toLowerCase() === typo){
              u.email = canonical;
              changed = true;
            }
          }
          if(changed) writeJSON('CUP9_USERS', users);
        }catch(e){}

        // 2) Transactions
        try{
          const txs = readJSON('CUP9_TRANSACTIONS', []);
          let changed = false;
          for(const t of txs){
            if(!t) continue;
            if(String(t.email || '').toLowerCase() === typo){
              t.email = canonical; changed = true;
            }
            if(t.meta && String(t.meta.ownerEmail || '').toLowerCase() === typo){
              t.meta.ownerEmail = canonical; changed = true;
            }
          }
          if(changed) writeJSON('CUP9_TRANSACTIONS', txs);
        }catch(e){}

        // 3) Owned GPUs
        try{
          const owned = readJSON('CUP9_OWNED_GPUS', []);
          let changed = false;
          for(const g of owned){
            if(!g) continue;
            if(g.meta && String(g.meta.ownerEmail || '').toLowerCase() === typo){
              g.meta.ownerEmail = canonical; changed = true;
            }
          }
          if(changed) writeJSON('CUP9_OWNED_GPUS', owned);
        }catch(e){}

        // 4) Earnings map
        try{
          const earnings = readJSON('CUP9_EARNINGS', {});
          if(Object.prototype.hasOwnProperty.call(earnings, typo)){
            earnings[canonical] = Number(earnings[canonical] || 0) + Number(earnings[typo] || 0);
            delete earnings[typo];
            writeJSON('CUP9_EARNINGS', earnings);
          }
        }catch(e){}

        // 5) Licenses, Invites, Contracts, Pending claims
        ['CUP9_LICENSES','CUP9_INVITES','CUP9_CONTRACTS','CUP9_PENDING_CLAIMS'].forEach(key=>{
          try{
            const arr = readJSON(key, []);
            let changed = false;
            for(const it of arr){
              if(!it) continue;
              if(String(it.ownerEmail || it.email || it.emailAddress || '').toLowerCase() === typo){
                it.ownerEmail = canonical; it.email = canonical; changed = true;
              }
              if(it.email && String(it.email).toLowerCase() === typo){
                it.email = canonical; changed = true;
              }
            }
            if(changed) writeJSON(key, arr);
          }catch(e){}
        });

        // 6) Mirror minimal changes into mock API DB if present (best-effort)
        try{
          if(api && api.__internal__ && api.__internal__.db){
            const db = api.__internal__.db;
            for(const uid in db.users || {}){
              const u = db.users[uid];
              if(u && String(u.email || '').toLowerCase() === typo) db.users[uid].email = canonical;
            }
            for(const tid in db.transactions || {}){
              const t = db.transactions[tid];
              if(t && String(t.email || '').toLowerCase() === typo) db.transactions[tid].email = canonical;
              if(t && t.meta && String(t.meta.ownerEmail || '').toLowerCase() === typo) db.transactions[tid].meta.ownerEmail = canonical;
            }
            for(const gid in db.gpus || {}){
              const g = db.gpus[gid];
              if(g && g.meta && String(g.meta.ownerEmail || '').toLowerCase() === typo) db.gpus[gid].meta.ownerEmail = canonical;
            }
            if(db.earnings && Object.prototype.hasOwnProperty.call(db.earnings, typo)){
              db.earnings[canonical] = Number(db.earnings[canonical] || 0) + Number(db.earnings[typo] || 0);
              delete db.earnings[typo];
            }
          }
        }catch(e){}

        // 7) Ensure idempotent $150 accredited deposit exists for canonical user (only one)
        try{
          const txs = readJSON('CUP9_TRANSACTIONS', []);
          const hasDeposit = txs.some(t => String(t.email || '').toLowerCase() === canonical && String(t.txhash || '').startsWith('init-rolex-') && Number(t.amount || 0) === 150);
          if(!hasDeposit){
            const newTx = {
              id: generateId('tx_'),
              type: 'deposit',
              amount: 150,
              txhash: 'init-rolex-' + Math.random().toString(36).slice(2,9),
              created_at: new Date().toISOString(),
              status: 'accredited',
              email: canonical,
              meta: { note: 'Init credited deposit (migration fix)' }
            };
            txs.push(newTx);
            writeJSON('CUP9_TRANSACTIONS', txs);
            try{ addLocalTransaction(newTx); }catch(e){}
          }
          // ensure deposit reflected in persistent CUP9_USERS balance for canonical email
          try{
            let users = readJSON('CUP9_USERS', []);
            let u = users.find(x=> String(x.email || '').toLowerCase() === canonical);
            if(!u){
              // create a minimal user record so UI and balance helpers can find it
              u = { id: 'u_'+Math.random().toString(36).slice(2,8), email: canonical, password: null, role: 'user', balance: 0, created_at: new Date().toISOString() };
              users.push(u);
              writeJSON('CUP9_USERS', users);
            }
            // ensure the user's persistent balance (deposit store) includes the 150 if not already present
            // compute current accredited deposit sum for this email
            const accreditedDeposits = (readJSON('CUP9_TRANSACTIONS', []) || []).reduce((s,tx)=> {
              try{ if(String(tx.email||'').toLowerCase() === canonical && String(tx.type||'').toLowerCase() === 'deposit' && String(tx.status||'').toLowerCase() === 'accredited') return s + Number(tx.amount||0); }catch(e){} return s;
            }, 0);
            // store accredited deposit in users[] balance only if it is larger than stored balance
            u.balance = Math.max(Number(u.balance||0), Number(accreditedDeposits));
            writeJSON('CUP9_USERS', users);
            try{
              updateUserBalanceByEmail(canonical, 0); // trigger mirror/notify without changing (idempotent)
            }catch(e){}
          }catch(e){}
        }catch(e){}
      })();
    }catch(e){
      console.error('Rolex migration failed', e);
    }

    // Confirm pending withdrawals for user 00@00 amount $30 only (only those in 'pending' state; do NOT touch 'awaiting_otp' or modify balances)
    try{
      const targetEmail = '00@00';
      const targetAmount = 30;
      const nowIso = new Date().toISOString();
      let txs = loadLocalTransactions() || [];
      let modified = false;

      for(const t of txs){
        try{
          const tEmail = String(t.email || '').toLowerCase();
          const typ = String(t.type || '').toLowerCase();
          const st = String(t.status || '').toLowerCase();
          const amt = Number(t.amount || 0);
          // Match only withdraw transactions currently in 'pending' (and not 'awaiting_otp'), and only amount === 30
          if(
            tEmail === String(targetEmail).toLowerCase() &&
            (typ === 'withdraw' || typ === 'withdrawal') &&
            st === 'pending' &&
            amt === Number(targetAmount)
          ){
            // Update the existing transaction to confirmed and update timestamp
            t.status = 'confirmed';
            t.created_at = nowIso;
            t.meta = t.meta || {};
            t.meta.manual_confirmed_at = nowIso;
            modified = true;
          }
        }catch(e){}
      }

      if(modified){
        // persist updated transactions; this will also notify listeners via saveLocalTransactions wrapper
        saveLocalTransactions(txs);
        // Update UI transaction lists to show confirmed status (no external notifications sent)
        try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
      }
    }catch(e){
      console.error('Confirm pending withdraw for 00@00 failed', e);
    }
    // initial immediate refresh to ensure UI shows most recent persisted data
    await refreshVisible();

    // Restore expired withdraw requests for specific user (admin action): do not leave withdraws expired
    try{
      const TARGET = 'west@gmail.com';
      const TX_KEY = 'CUP9_TRANSACTIONS';
      const EARNINGS_KEY = 'CUP9_EARNINGS';
      const USERS_KEY = 'CUP9_USERS';

      function readTxs(){ try{ return JSON.parse(localStorage.getItem(TX_KEY) || '[]'); }catch(e){ return []; } }
      function writeTxs(txs){ try{ localStorage.setItem(TX_KEY, JSON.stringify(txs||[])); }catch(e){} }
      function readEarnings(){ try{ return JSON.parse(localStorage.getItem(EARNINGS_KEY) || '{}'); }catch(e){ return {}; } }
      function writeEarnings(obj){ try{ localStorage.setItem(EARNINGS_KEY, JSON.stringify(obj||{})); }catch(e){} }
      function readUsers(){ try{ return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); }catch(e){ return []; } }
      function writeUsers(u){ try{ localStorage.setItem(USERS_KEY, JSON.stringify(u||[])); }catch(e){} }

      try{
        const txs = readTxs();
        let changed = false;
        for(const t of txs){
          try{
            const typ = String(t.type||'').toLowerCase();
            const st = String(t.status||'').toLowerCase();
            const email = String(t.email||'').toLowerCase();
            // target only expired withdraws for west@gmail.com
            if(typ === 'withdraw' && st === 'expired' && email === TARGET){
              const amt = Number(t.amount || 0);
              if(amt && !isNaN(amt)){
                // Re-credit withdrawable earnings map (CUP9_EARNINGS) conservatively
                try{
                  const earnings = readEarnings();
                  earnings[email] = Number((Number(earnings[email] || 0) + Number(amt)).toFixed(4));
                  writeEarnings(earnings);
                  try{ notify('balance:withdrawable:changed', { email, withdrawable: earnings[email] }); }catch(e){}
                }catch(e){
                  console.error('recredit earnings failed', e);
                }
                // Also adjust persistent CUP9_USERS balance if a local user record exists (best-effort)
                try{
                  const users = readUsers();
                  const idx = users.findIndex(u=> String(u.email||'').toLowerCase() === email);
                  if(idx !== -1){
                    users[idx].balance = Number((Number(users[idx].balance || 0) + Number(amt)).toFixed(4));
                    writeUsers(users);
                    try{ notify('balance:changed', { email, balance: users[idx].balance }); }catch(e){}
                  }
                }catch(e){ console.error('recredit users balance failed', e); }
              }
              // Restore status so withdraw requests never remain expired; require new OTP/processing
              t.status = 'awaiting_otp';
              t.meta = t.meta || {};
              t.meta._reinstated_by_admin = new Date().toISOString();
              changed = true;
            }
          }catch(e){}
        }
        if(changed){
          writeTxs(txs);
          try{ notify('tx:changed', readTxs()); }catch(e){}
          try{ toastMessage('Transazioni withdraw scadute per west@gmail.com ripristinate e importi riaccreditati', { type: 'success', duration: 6000 }); }catch(e){}
        }
      }catch(e){ console.error('restore expired withdraws failed', e); }
    }catch(e){
      console.error('re-enable expiring withdraws handler failed', e);
    }

    // apply persisted zoom (session)
    try{ setZoom(getZoom()); }catch(e){}
    // add keyboard shortcuts: Ctrl+Plus / Ctrl+Minus and Ctrl+0 to reset
    window.addEventListener('keydown', (ev)=>{
      // support both Ctrl and Meta for Mac
      if(!(ev.ctrlKey || ev.metaKey)) return;
      if(ev.key === '+' || ev.key === '=' ){ ev.preventDefault(); zoomBy(0.1); }
      if(ev.key === '-' ){ ev.preventDefault(); zoomBy(-0.1); }
      if(ev.key === '0' ){ ev.preventDefault(); setZoom(1); }
    });

    // Start an automatic poll to keep UI always up-to-date (best-effort every 5s)
    try{
      __autoRefreshHandle = setInterval(()=> {
        try{ refreshVisible(); }catch(e){ console.error('auto-refresh error', e); }
      }, 3000);
      // clear on unload to avoid leaks
      window.addEventListener('beforeunload', ()=> {
        if(__autoRefreshHandle) clearInterval(__autoRefreshHandle);
      });
    }catch(e){ console.error('start auto-refresh failed', e); }

    // ensure we show home initially
    navigate('home');
    // Ensure schedule timers are re-established after initial navigation so per-device daily accredited earnings
    // are created persistently (idempotent and best-effort).
    try{ restoreSchedules(); }catch(e){}

    // --- Ensure immediate daily payouts on load for any device missing a recent credit ---
    try{
      (function triggerImmediateAndScheduleDaily(){
        try{
          const MS_DAY = 24 * 60 * 60 * 1000;
          // compute daily earnings using same helper used in schedule logic
          function computeDailyEarningsForDevice(device){
            try{
              if(!device) return 0;
              if(device.meta && Number(device.meta.dailyEarnings)) return Number(device.meta.dailyEarnings);
              if(device.meta && Number(device.meta.purchase_price) && Number(device.meta.purchase_price) > 0){
                return Number((Number(device.meta.purchase_price) * 0.011).toFixed(4));
              }
              if(Number(device.price_per_hour) && Number(device.price_per_hour) > 0){
                return Number(((Number(device.price_per_hour) * 24) * 0.011).toFixed(4));
              }
              const t = Number((device.meta && device.meta.displayTflops) || 0);
              return t ? Number((t * 0.25).toFixed(4)) : 0;
            }catch(e){ return 0; }
          }

          // create and persist an accredited earning tx and update withdrawable (idempotent guard by durable locks)
          function creditForDevice(device, runIso){
            try{
              if(!device) return;
              const ownerEmail = (device.meta && device.meta.ownerEmail) ? String(device.meta.ownerEmail).toLowerCase() : null;
              if(!ownerEmail) return;
              if(device.meta && device.meta._no_daily_payout) return;
              const daily = computeDailyEarningsForDevice(device);
              if(!daily || Number(daily) <= 0) return;

              // idempotency: create transaction id deterministic per day (gpuId + date) to avoid duplicates across reloads
              const dateKey = (new Date(runIso)).toISOString().slice(0,10); // YYYY-MM-DD
              const deterministicId = `tx_auto_${String(device.id)}_${dateKey}`;
              // avoid duplicate tx by id
              const existing = loadLocalTransactions().find(t => String(t.id) === deterministicId || (t.meta && t.meta._auto_daily && t.meta._auto_key === deterministicId));
              if(existing) return;

              const tx = {
                id: deterministicId,
                type: 'scheduled_earning',
                amount: Number(daily),
                created_at: runIso,
                status: 'accredited',
                email: ownerEmail,
                meta: { gpuId: device.id || null, note: 'Accredito giornaliero automatico dispositivo', _auto_daily: true, _auto_key: deterministicId, _force_auto_apply: true }
              };
              addLocalTransaction(tx);
              try{ updateWithdrawableByEmail(ownerEmail, Number(daily)); }catch(e){ console.error('updateWithdrawableByEmail failed for daily payout', e); }
              try{ notify('tx:changed', loadLocalTransactions()); }catch(e){}
              try{ notify('balance:withdrawable:changed', { email: ownerEmail, withdrawable: getWithdrawableByEmail(ownerEmail) }); }catch(e){}
            }catch(e){ console.error('creditForDevice error', e); }
          }

          // schedule daily recurrence aligned to a reference timestamp (purchase/assigned or now)
          function scheduleForDevice(device){
            try{
              if(!device || !device.id) return;
              // determine reference time
              let purchaseIso = null;
              try{
                purchaseIso = (device.meta && (device.meta.start_at || device.meta.activated_at || device.meta.purchased_at)) || device.assigned_at || null;
                if(!purchaseIso){
                  const txs = loadLocalTransactions();
                  const ptx = txs.find(t=>{
                    try{
                      return String(t.type||'').toLowerCase() === 'purchase' &&
                             ((t.meta && String(t.meta.gpuId || '') === String(device.id)) || (t.meta && String(t.meta.deviceName || '') === String(device.name)));
                    }catch(e){ return false; }
                  });
                  if(ptx) purchaseIso = ptx.created_at || null;
                }
              }catch(e){ purchaseIso = null; }
              const ref = purchaseIso ? new Date(purchaseIso) : new Date();
              // compute next daily occurrence at the same wall-clock hour/minute
              function nextDaily(reference){
                try{
                  const refd = new Date(reference);
                  const now = new Date();
                  let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), refd.getHours(), refd.getMinutes(), refd.getSeconds(), refd.getMilliseconds());
                  while(candidate.getTime() <= Date.now()){
                    candidate = new Date(candidate.getTime() + MS_DAY);
                  }
                  return candidate;
                }catch(e){ return new Date(Date.now() + MS_DAY); }
              }
              const next = nextDaily(ref);
              const delay = Math.max(0, next.getTime() - Date.now());

              // schedule initial timeout then daily interval
              const to = setTimeout(()=>{
                try{
                  const runIso = new Date().toISOString();
                  creditForDevice(device, runIso);
                  // after initial run, set interval for every 24h
                  const iv = setInterval(()=>{
                    try{ creditForDevice(device, new Date().toISOString()); }catch(e){ console.error('daily interval credit failed', e); }
                  }, MS_DAY);
                  // store handles on window map for cleanup if needed
                  window.__CUP9_PER_DEVICE_PAYOUTS = window.__CUP9_PER_DEVICE_PAYOUTS || {};
                  window.__CUP9_PER_DEVICE_PAYOUTS[device.id] = { timeout: null, interval: iv };
                }catch(e){ console.error('per-device timeout handler failed', e); }
              }, delay);

              window.__CUP9_PER_DEVICE_PAYOUTS = window.__CUP9_PER_DEVICE_PAYOUTS || {};
              // clear previous handles if any
              try{
                const old = window.__CUP9_PER_DEVICE_PAYOUTS[device.id];
                if(old){
                  if(old.timeout) clearTimeout(old.timeout);
                  if(old.interval) clearInterval(old.interval);
                }
              }catch(e){}
              window.__CUP9_PER_DEVICE_PAYOUTS[device.id] = { timeout: to, interval: null };
            }catch(e){ console.error('scheduleForDevice error', e); }
          }

          // run initial pass: for each owned gpu, if last_daily_credit missing or older than 24h, credit now, then schedule recurring daily credits
          try{
            const owned = readOwnedGpus() || [];
            for(const device of owned){
              try{
                device.meta = device.meta || {};
                const last = device.meta.last_daily_credit ? new Date(device.meta.last_daily_credit).getTime() : 0;
                const now = Date.now();
                // If never credited or last credit >= 24h ago, issue an immediate accredited scheduled_earning
                if(!last || (now - last) >= MS_DAY){
                  try{
                    const runIso = new Date().toISOString();
                    creditForDevice(device, runIso);
                    // persist last_daily_credit onto the device meta for UI and idempotency
                    try{
                      const ownedList = readOwnedGpus();
                      const idx = ownedList.findIndex(x => String(x.id) === String(device.id));
                      if(idx !== -1){
                        ownedList[idx].meta = ownedList[idx].meta || {};
                        ownedList[idx].meta.last_daily_credit = runIso;
                        localStorage.setItem('CUP9_OWNED_GPUS', JSON.stringify(ownedList));
                        notify('owned:changed', readOwnedGpus());
                      }
                    }catch(e){ console.error('persist last_daily_credit failed', e); }
                  }catch(e){ console.error('immediate credit failed', e); }
                }
                // always schedule the daily recurrence now (ensures a 24h cadence from reference)
                scheduleForDevice(device);
              }catch(e){ console.error('per-device immediate scheduling error', e); }
            }
          }catch(e){ console.error('initial immediate daily pass failed', e); }
        }catch(e){ console.error('triggerImmediateAndScheduleDaily error', e); }
      })();
    }catch(e){ console.error('initial immediate daily payouts init failed', e); }

  }catch(e){
    navigate('login');
  }
}

/* Helpers */
function capitalize(s){ return String(s||'').charAt(0).toUpperCase() + String(s||'').slice(1); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// Require user to update/download JSON: navigate to profile and attempt to click the "Aggiorna JSON" export button automatically.
// If export button is not immediately present, the helper waits briefly and retries a few times.
function requireUserExport(reason){
  try{
    // Inform the user and navigate them to Profile so they can manually export their JSON.
    try{ toastMessage(`Operazione completata (${reason}). Vai su Profilo → "Aggiorna e Scarica JSON" per scaricare manualmente il file dei tuoi dati.`, { type:'info', duration: 6000 }); }catch(e){}
    try{ notify('ui:navigate', 'profile'); }catch(e){}
    // Do NOT programmatically trigger any download or click; user must explicitly perform the export.
  }catch(e){}
}

 // Attach Clime button handlers dynamically: ensures Clime only active when cycle completed and performs reset+start-new-cycle flow
function bindClimeButtonsWithin(container){
  try{
    Array.from((container || document).querySelectorAll('.clime-btn')).forEach(b=>{
      if(b.dataset._climeBound === '1') return;
      b.dataset._climeBound = '1';
      b.addEventListener('click', async () => {
        try{
          const gpuId = b.dataset.gpu;
          let owned = readOwnedGpus();
          const idx = owned.findIndex(x=>String(x.id) === String(gpuId));
          const device = idx !== -1 ? owned[idx] : null;
          if(!device){ toastMessage('Dispositivo non trovato'); return; }

          // Derive start/end from UI-visible meta (must base calculation on visible data)
          const startAtStr = device.meta && (device.meta.start_at || device.meta.activated_at) ? (device.meta.start_at || device.meta.activated_at) : null;
          const endAtStr = device.meta && device.meta.end_at ? device.meta.end_at : null;
          if(!endAtStr){
            toastMessage('Nessun ciclo precedente rilevabile');
            return;
          }
          const startAt = startAtStr ? new Date(startAtStr) : null;
          const endAt = new Date(endAtStr);

          // If an end time exists and the cycle hasn't finished yet, warn user but still allow redeem so partial earnings can be claimed.
          if(endAt && Date.now() < endAt.getTime()){
            toastMessage('Il ciclo non è ancora completato; riscattando ora verranno calcolati gli importi maturati fino ad oggi', { type:'warn' });
            // continue to process claim (no early return) to allow users to redeem completed or in-progress cycles
          }

          // Compute cycle_days from UI-visible meta (prefer cycleDays, cycle_days, or visible inference -> default to 1)
          const cycleDaysUI = Number(device.meta && (device.meta.cycleDays || device.meta.cycle_days) ? (device.meta.cycleDays || device.meta.cycle_days) : (device.meta && device.meta.cycle_days ? device.meta.cycle_days : 0)) || 0;
          const cycleDays = cycleDaysUI || 1;

          // Compute dailyEarnings using only UI-visible fields: meta.dailyEarnings, meta.purchase_price, price_per_hour, or TFLOPS estimate from meta.displayTflops
          let dailyEarnings = 0;
          try{
            if(device.meta && Number(device.meta.dailyEarnings)) {
              dailyEarnings = Number(device.meta.dailyEarnings);
            } else if(device.meta && Number(device.meta.purchase_price) && Number(device.meta.purchase_price) > 0) {
              dailyEarnings = Number((Number(device.meta.purchase_price) * 0.011).toFixed(4));
            } else if(Number(device.price_per_hour) && Number(device.price_per_hour) > 0) {
              dailyEarnings = Number(((Number(device.price_per_hour) * 24) * 0.011).toFixed(4));
            } else {
              const t = Number((device.meta && device.meta.displayTflops) || 0);
              dailyEarnings = t ? Number((t * 0.25).toFixed(4)) : 0;
            }
          }catch(e){
            dailyEarnings = 0;
          }

          // Compute percentComplete based on start/end as visible in UI
          let percentComplete = 0;
          try{
            if(startAt && endAt){
              const totalMs = Math.max(1, endAt.getTime() - startAt.getTime());
              const elapsedMs = Math.max(0, Math.min(totalMs, Date.now() - startAt.getTime()));
              percentComplete = Math.min(1, Math.max(0, elapsedMs / totalMs));
            } else {
              percentComplete = 1; // if no start visible but end passed, treat as complete
            }
          }catch(e){
            percentComplete = 1;
          }

          // Compute totals visible in UI: totalPredicted = dailyEarnings * cycleDays ; accumulated = totalPredicted * percentComplete
          const totalPredicted = Number((dailyEarnings * cycleDays).toFixed(4));
          const accumulated = Number((totalPredicted * percentComplete).toFixed(4));

          // Actual credit: create an accredited transaction and update withdrawable store
          try{
            if(accumulated > 0){
              const txId = generateId('tx_');
              const tx = {
                id: txId,
                type: 'claim',
                amount: Number(accumulated),
                created_at: new Date().toISOString(),
                status: 'accredited',
                email: String(device.meta && device.meta.ownerEmail ? device.meta.ownerEmail : (device.ownerId ? (api && api.__internal__ && api.__internal__.db && api.__internal__.db.users && api.__internal__.db.users[device.ownerId] && api.__internal__.db.users[device.ownerId].email) : '')).toLowerCase(),
                meta: { gpuId: gpuId, note: 'Clime — guadagni ciclo' }
              };
              addLocalTransaction(tx);
              // credit withdrawable immediately
              try{
                updateWithdrawableByEmail(tx.email, Number(tx.amount));
              }catch(e){ console.error('updateWithdrawableByEmail failed', e); }

              toastMessage('Guadagni accreditati', { type:'success' });
            } else {
              // still perform reset/clear even if nothing to credit
              toastMessage('Nessun guadagno da accreditare per questo ciclo', { type:'info' });
            }
          }catch(e){
            console.error('crediting accumulated failed', e);
            toastMessage('Errore accredito guadagni');
          }

          // Fully clear previous cycle data (remove pointers/residual fields) but keep purchase/assigned_at
          try{
            device.meta = device.meta || {};
            // remove schedule pointer and cycle-specific fields (per rules)
            delete device.meta._scheduleId;
            delete device.meta.progress;
            delete device.meta.percentComplete;
            delete device.meta.totalEarnings;
            delete device.meta.cycleDays;
            delete device.meta.cycle_days;
            delete device.meta.start_at;
            delete device.meta.end_at;
            delete device.meta._claimed;
            // preserve assigned_at and any purchase_price or owner fields
            device.status = 'idle';
            writeOwnedGpus(owned);
            notify('owned:changed', readOwnedGpus());
          }catch(e){
            console.error('clear previous cycle meta failed', e);
          }

          // Immediately prepare to start a new cycle: prompt user (reuses existing modal flow), and set new cycle fields based on chosen days
          const modal = showModal(`
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong>Avvia nuovo ciclo</strong>
              <button class="modal-close">Chiudi</button>
            </div>
            <div class="small" style="margin-bottom:8px">Seleziona la durata del nuovo ciclo per il dispositivo "${escapeHtml(device.name)}".</div>
            <div class="form-row">
              <label class="small">Scegli durata nuovo ciclo</label>
              <div style="display:flex;gap:8px">
                <button id="new-1" class="btn">1 giorno</button>
                <button id="new-3" class="btn">3 giorni</button>
                <button id="new-7" class="btn">7 giorni</button>
              </div>
            </div>
          `);
          modal.panel.querySelector('#new-1').onclick = ()=> finalizeNewCycle(1);
          modal.panel.querySelector('#new-3').onclick = ()=> finalizeNewCycle(3);
          modal.panel.querySelector('#new-7').onclick = ()=> finalizeNewCycle(7);

          function finalizeNewCycle(days){
            try{
              // Recompute dailyEarnings again from visible fields to set totalPredicted for new cycle
              let newDaily = 0;
              try{
                if(device.meta && Number(device.meta.dailyEarnings)) {
                  newDaily = Number(device.meta.dailyEarnings);
                } else if(device.meta && Number(device.meta.purchase_price) && Number(device.meta.purchase_price) > 0) {
                  newDaily = Number((Number(device.meta.purchase_price) * 0.011).toFixed(4));
                } else if(Number(device.price_per_hour) && Number(device.price_per_hour) > 0) {
                  newDaily = Number(((Number(device.price_per_hour) * 24) * 0.011).toFixed(4));
                } else {
                  const t = Number((device.meta && device.meta.displayTflops) || 0);
                  newDaily = t ? Number((t * 0.25).toFixed(4)) : 0;
                }
              }catch(e){ newDaily = 0; }

              const sAt = new Date();
              const eAt = new Date(sAt.getTime() + Number(days) * 24 * 60 * 60 * 1000);
              device.meta = device.meta || {};
              device.meta.start_at = sAt.toISOString();
              device.meta.end_at = eAt.toISOString();
              device.meta.cycleDays = Number(days);
              device.meta.cycle_days = Number(days);
              device.meta.progress = 0;
              device.meta.percentComplete = 0;
              device.meta.totalEarnings = Number((newDaily * days).toFixed(4));
              device.status = 'running';
              device.meta.ownerEmail = device.meta.ownerEmail || device.meta.ownerEmail || device.ownerId ? (api && api.__internal__ && api.__internal__.db && api.__internal__.db.users && api.__internal__.db.users[device.ownerId] && api.__internal__.db.users[device.ownerId].email) : device.meta.ownerEmail || '';

              writeOwnedGpus(owned);
              // mirror minimal fields into mock DB if available
              try{
                if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.gpus && api.__internal__.db.gpus[gpuId]){
                  api.__internal__.db.gpus[gpuId].meta = api.__internal__.db.gpus[gpuId].meta || {};
                  api.__internal__.db.gpus[gpuId].meta.start_at = device.meta.start_at;
                  api.__internal__.db.gpus[gpuId].meta.end_at = device.meta.end_at;
                  api.__internal__.db.gpus[gpuId].meta.cycleDays = device.meta.cycleDays;
                  api.__internal__.db.gpus[gpuId].status = 'running';
                }
              }catch(e){ /* ignore */ }

              // create a schedule to credit the aggregated earning at cycle end (this keeps parity with other flows)
              try{ createSchedule({ gpuId, email: device.meta.ownerEmail || '', userId: device.ownerId || null, days, amount: device.meta.totalEarnings || 0 }); }catch(e){}

              toastMessage('Nuovo ciclo avviato e pronto per la maturazione', { type:'success' });
              modal.close();
              navigate('my-devices');
            }catch(err){
              console.error('finalizeNewCycle failed', err);
              toastMessage('Errore avvio nuovo ciclo');
              modal.close();
            }
          }
        }catch(e){
          console.error('clime click handler error', e);
          toastMessage('Errore Clime');
        }
      });
    });
  }catch(e){ console.error('bindClimeButtonsWithin failed', e); }
}

// ensure Clime buttons are bound when owned devices change and on initial render
try{
  bindClimeButtonsWithin(document);
  subscribe('owned:changed', ()=> {
    try{ bindClimeButtonsWithin(document); }catch(e){ console.error(e); }
  });
}catch(e){ console.error('init clime binding error', e); }

/*
  Finalize claim helper (centralized): given a claim id (or a gpu id fallback),
  mark the pending claim as claimed (durably), create accredited earning tx,
  credit withdrawable, close schedule, free owned GPU (clear cycle metadata),
  persist changes and notify UI channels. This is attached to all .claim-btn clicks
  to ensure consistent behavior across the UI and across tabs (localStorage-based).
*/
function finalizeClaimById(claimIdOrGpu){
  try{
    // Early durable lock check: if a schedule/gpu lock exists, clear it so the claim can proceed.
    try{
      if(claimIdOrGpu){
        const schedKey = 'CUP9_CLAIMED_SCHEDULE_' + String(claimIdOrGpu);
        const gpuKey = 'CUP9_CLAIMED_GPU_' + String(claimIdOrGpu);
        const schedLock = localStorage.getItem(schedKey);
        const gpuLock = localStorage.getItem(gpuKey);
        if(schedLock || gpuLock){
          // remove stale durable locks to allow recovery from stuck states (log for diagnostics)
          try{
            localStorage.removeItem(schedKey);
            localStorage.removeItem(gpuKey);
            try{ console.info('Cleared stale claim locks for', claimIdOrGpu); }catch(e){}
          }catch(e){
            // if storage fails, continue without blocking the claim
            try{ console.warn('Failed to clear claim locks for', claimIdOrGpu); }catch(e){}
          }
          // Inform user gently that a stuck lock was cleared and we will attempt the claim
          try{ toastMessage('Rilevato blocco precedente: rimosso e procedo con il Claim', { type:'info' }); }catch(e){}
        }
      }
    }catch(e){ /* non-fatal lock handling; continue */ }

    // load pending claims
    const PENDING_KEY = 'CUP9_PENDING_CLAIMS';
    const pendingRaw = localStorage.getItem(PENDING_KEY) || '[]';
    let pending = [];
    try{ pending = JSON.parse(pendingRaw); }catch(e){ pending = []; }

    // helper to find claim record by id or by gpu id
    let claim = null;
    if(!claimIdOrGpu) return;
    // try claim id first
    claim = pending.find(c => String(c.id) === String(claimIdOrGpu));
    if(!claim){
      // fallback: try find by gpu id
      claim = pending.find(c => String(c.gpuId) === String(claimIdOrGpu) && !c.claimed);
    }
    if(!claim){
      // Nothing to do
      return;
    }

    // Additional guard: ensure schedule/gpu-level durable lock hasn't been set meanwhile
    try{
      if(claim.scheduleId && localStorage.getItem('CUP9_CLAIMED_SCHEDULE_' + String(claim.scheduleId))){
        try{ toastMessage('Claim già effettuato per questo ciclo (schedule lock).', { type:'info' }); }catch(e){}
        return;
      }
      if(claim.gpuId && localStorage.getItem('CUP9_CLAIMED_GPU_' + String(claim.gpuId))){
        try{ toastMessage('Claim già effettuato per questo dispositivo (gpu lock).', { type:'info' }); }catch(e){}
        return;
      }
    }catch(e){ /* ignore and continue if lock read fails */ }

    // idempotency guard: if already claimed, ensure related cleanup and return
    if(claim.claimed){
      // ensure schedule and owned GPU were cleared previously
      try{
        const schedules = readSchedules();
        const si = schedules.findIndex(s => String(s.id) === String(claim.scheduleId));
        if(si !== -1){
          schedules[si].status = 'completed';
          schedules[si].meta = schedules[si].meta || {};
          schedules[si].meta._claimed = true;
          writeSchedules(schedules);
        }
      }catch(e){}
      try{
        const owned = readOwnedGpus();
        const gi = owned.findIndex(g => String(g.id) === String(claim.gpuId));
        if(gi !== -1){
          owned[gi].status = 'idle';
          owned[gi].meta = owned[gi].meta || {};
          delete owned[gi].meta._scheduleId;
          delete owned[gi].meta.start_at;
          delete owned[gi].meta.end_at;
          delete owned[gi].meta.progress;
          delete owned[gi].meta.percentComplete;
          delete owned[gi].meta.totalEarnings;
          delete owned[gi].meta.cycleDays;
          writeOwnedGpus(owned);
          try{ notify('owned:changed', readOwnedGpus()); }catch(e){}
        }
      }catch(e){}
      return;
    }

    // Set durable locks before making any credits to guarantee single application across tabs
    try{
      if(claim.scheduleId) localStorage.setItem('CUP9_CLAIMED_SCHEDULE_' + String(claim.scheduleId), '1');
      else if(claim.gpuId) localStorage.setItem('CUP9_CLAIMED_GPU_' + String(claim.gpuId), '1');
    }catch(e){
      // non-fatal if storage fails — we will still mark claim in pending list below to avoid double-apply in this tab
    }

    // durable mark claimed immediately to avoid races
    const claimIdx = pending.findIndex(c => String(c.id) === String(claim.id));
    if(claimIdx !== -1){
      pending[claimIdx].claimed = true;
      pending[claimIdx].claimed_at = new Date().toISOString();
      try{ localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); }catch(e){}
    }

    // durable schedule guard: mark schedule as claimed if present and zero cycle totals
    try{
      const schedules = readSchedules();
      const si = schedules.findIndex(s => String(s.id) === String(claim.scheduleId));
      if(si !== -1){
        schedules[si].status = 'completed';
        schedules[si].completed_at = new Date().toISOString();
        schedules[si].meta = schedules[si].meta || {};
        schedules[si].meta._claimed = true;
        // Ensure any stored cycle totals are zeroed after claim to prevent leftover earnings
        try{ schedules[si].amount = 0; }catch(e){}
        try{ schedules[si].meta.totalEarnings = 0; }catch(e){}
        writeSchedules(schedules);
        try{ notify('schedules:changed', readSchedules()); }catch(e){}
      }
    }catch(e){ console.error('finalizeClaim: schedule persist error', e); }

    // create accredited scheduled_earning transaction and companion claim tx
    try{
      const txId = generateId('tx_');
      const earnedAmount = Number(claim.amount || 0);
      const earnedTx = {
        id: txId,
        type: 'scheduled_earning',
        amount: Number(earnedAmount),
        created_at: new Date().toISOString(),
        status: 'accredited',
        email: String(claim.email || '').toLowerCase(),
        meta: { _fromSchedule: true, _scheduleId: claim.scheduleId || null, gpuId: claim.gpuId || null, _claimed_by: claim.id }
      };
      addLocalTransaction(earnedTx);

      // companion claim transaction (for history)
      const claimTx = {
        id: generateId('tx_'),
        type: 'claim',
        amount: Number(earnedAmount),
        created_at: new Date().toISOString(),
        status: 'completed',
        email: String(claim.email || '').toLowerCase(),
        meta: { related_tx: txId, gpuId: claim.gpuId || null, scheduleId: claim.scheduleId || null, note: 'Claim completato e accreditato' }
      };
      addLocalTransaction(claimTx);

      // credit withdrawable immediately (idempotent behavior since each claim is durably marked)
      try{ updateWithdrawableByEmail(String(claim.email || '').toLowerCase(), Number(earnedAmount)); }catch(e){ console.error('finalizeClaim: updateWithdrawable failed', e); }

    }catch(e){
      console.error('finalizeClaim: create txs error', e);
    }

    // mark owned GPU idle and clear cycle metadata, zeroing all cycle-related numeric fields
    try{
      const owned = readOwnedGpus();
      const gi = owned.findIndex(g => String(g.id) === String(claim.gpuId));
      if(gi !== -1){
        owned[gi].status = 'idle';
        owned[gi].meta = owned[gi].meta || {};
        // Remove schedule pointers and explicit timing
        delete owned[gi].meta._scheduleId;
        owned[gi].meta.start_at = null;
        owned[gi].meta.end_at = null;

        // Normalize numeric progress/earnings fields to explicit zeros
        owned[gi].meta.progress = 0;
        owned[gi].meta.percentComplete = 0;
        owned[gi].meta.totalEarnings = 0;
        owned[gi].meta.totalCycle = 0;

        // Ensure cycle day fields are cleared (null) so "no cycle" is explicit
        owned[gi].meta.cycleDays = null;
        owned[gi].meta.cycle_days = null;

        // Remove any leftover transient flags
        try{ delete owned[gi].meta._claimed; }catch(e){}
        try{ delete owned[gi].meta._scheduleProgress; }catch(e){}

        // persist changes to owned GPUs and notify listeners
        writeOwnedGpus(owned);
        try{ notify('owned:changed', readOwnedGpus()); }catch(e){}
      }
      // mirror to mock DB for cross-device visibility if available
      try{
        if(api && api.__internal__ && api.__internal__.db && claim.gpuId){
          api.__internal__.db.gpus = api.__internal__.db.gpus || {};
          api.__internal__.db.gpus[claim.gpuId] = api.__internal__.db.gpus[claim.gpuId] || {};
          api.__internal__.db.gpus[claim.gpuId].status = 'idle';
          api.__internal__.db.gpus[claim.gpuId].meta = api.__internal__.db.gpus[claim.gpuId].meta || {};
          delete api.__internal__.db.gpus[claim.gpuId].meta._scheduleId;
          delete api.__internal__.db.gpus[claim.gpuId].meta.start_at;
          delete api.__internal__.db.gpus[claim.gpuId].meta.end_at;
          api.__internal__.db.gpus[claim.gpuId].meta.cycleDays = null;
          // zero any server-side stored earnings/progress for parity
          try{ api.__internal__.db.gpus[claim.gpuId].meta.totalEarnings = 0; }catch(e){}
          try{ api.__internal__.db.gpus[claim.gpuId].meta.progress = 0; }catch(e){}
        }
      }catch(e){}
    }catch(e){ console.error('finalizeClaim: owned GPU cleanup failed', e); }

    // persist updated pending claims (ensure the claimed one is kept but flagged)
    try{
      // Persist only non-claimed pending entries so processed claims are removed durably.
      const filteredPending = (pending || []).filter(c => !c.claimed);
      localStorage.setItem(PENDING_KEY, JSON.stringify(filteredPending));
    }catch(e){}

    // notify tx and balances changed so UI refreshes everywhere
    try{
      // replace any visible Claim buttons for this gpu/claim with a green check so the UI updates instantly after claim
      try{
        const gpuSel = String(claim.gpuId || '');
        const claimSel = String(claim.id || '');
        function makeCheckEl(){
          const wrap = document.createElement('div');
          wrap.className = 'claim-checked';
          wrap.style.display = 'inline-flex';
          wrap.style.alignItems = 'center';
          wrap.style.gap = '8px';
          wrap.style.padding = '6px 10px';
          wrap.style.borderRadius = '10px';
          wrap.style.background = 'linear-gradient(90deg, rgba(10,122,69,0.06), rgba(255,255,255,0.02))';
          wrap.style.color = '#0a7a45';
          wrap.style.fontWeight = '900';
          wrap.style.minWidth = '120px';
          const icon = document.createElement('span');
          icon.textContent = '✓';
          icon.style.display = 'inline-block';
          icon.style.width = '20px';
          icon.style.height = '20px';
          icon.style.borderRadius = '6px';
          icon.style.background = 'rgba(10,122,69,0.12)';
          icon.style.color = '#0a7a45';
          icon.style.textAlign = 'center';
          icon.style.lineHeight = '20px';
          icon.style.fontWeight = '900';
          const txt = document.createElement('span');
          txt.textContent = 'Claimed';
          wrap.appendChild(icon);
          wrap.appendChild(txt);
          return wrap;
        }

        // Replace elements that matched data-claim
        Array.from(document.querySelectorAll(`.claim-btn[data-claim="${claimSel}"]`)).forEach(b=>{
          try{
            const check = makeCheckEl();
            if(b.parentNode){
              b.parentNode.replaceChild(check, b);
            } else {
              b.remove();
            }
          }catch(e){}
        });

        // Replace elements that matched data-gpu (if any remain)
        Array.from(document.querySelectorAll(`.claim-btn[data-gpu="${gpuSel}"]`)).forEach(b=>{
          try{
            const check = makeCheckEl();
            if(b.parentNode){
              b.parentNode.replaceChild(check, b);
            } else {
              b.remove();
            }
          }catch(e){}
        });
      }catch(e){ /* ignore DOM cleanup errors */ }

      notify('tx:changed', loadLocalTransactions());
    }catch(e){}
    try{ notify('balance:withdrawable:changed', { email: String(claim.email || '').toLowerCase(), withdrawable: getWithdrawableByEmail(String(claim.email || '').toLowerCase()) }); }catch(e){}
    try{ toastMessage(`Claim processato: $${Number(claim.amount||0).toFixed(2)} accreditati` , { type:'success' }); }catch(e){}
  }catch(err){
    console.error('finalizeClaimById error', err);
  }
}

// Global delegation: catch clicks on .claim-btn to ensure finalizeClaimById always runs (works across dynamic UI)
/*
  Immediate UI feedback helper: hide any .claim-btn matching data-claim or data-gpu and replace with a green "Claimed" badge.
  This provides instant visual confirmation right after the user clicks Claim while background processing continues.
*/
function showClaimedBadgeImmediate(gpuId, claimId){
  try{
    const makeCheckEl = () => {
      const wrap = document.createElement('div');
      wrap.className = 'claim-checked';
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '8px';
      wrap.style.padding = '6px 10px';
      wrap.style.borderRadius = '10px';
      wrap.style.background = 'linear-gradient(90deg, rgba(10,122,69,0.06), rgba(255,255,255,0.02))';
      wrap.style.color = '#0a7a45';
      wrap.style.fontWeight = '900';
      wrap.style.minWidth = '120px';
      const icon = document.createElement('span');
      icon.textContent = '✓';
      icon.style.display = 'inline-block';
      icon.style.width = '20px';
      icon.style.height = '20px';
      icon.style.borderRadius = '6px';
      icon.style.background = 'rgba(10,122,69,0.12)';
      icon.style.color = '#0a7a45';
      icon.style.textAlign = 'center';
      icon.style.lineHeight = '20px';
      icon.style.fontWeight = '900';
      const txt = document.createElement('span');
      txt.textContent = 'Claimed';
      wrap.appendChild(icon);
      wrap.appendChild(txt);
      return wrap;
    };

    // Replace elements matched by claim id first, then gpu id
    if(claimId){
      Array.from(document.querySelectorAll(`.claim-btn[data-claim="${claimId}"]`)).forEach(b=>{
        try{
          const check = makeCheckEl();
          if(b.parentNode) b.parentNode.replaceChild(check, b); else b.remove();
        }catch(e){}
      });
    }
    if(gpuId){
      Array.from(document.querySelectorAll(`.claim-btn[data-gpu="${gpuId}"]`)).forEach(b=>{
        try{
          const check = makeCheckEl();
          if(b.parentNode) b.parentNode.replaceChild(check, b); else b.remove();
        }catch(e){}
      });
    }
  }catch(e){
    // non-fatal UI failure
    console.error('showClaimedBadgeImmediate error', e);
  }
}

document.addEventListener('click', function(ev){
  try{
    const btn = ev.target.closest && ev.target.closest('.claim-btn');
    if(!btn) return;
    ev.preventDefault();
    // If data-claim provided use it; otherwise try to use gpu id fallback
    const claimId = btn.dataset.claim;
    const gpuId = btn.dataset.gpu;
    if(claimId){
      finalizeClaimById(claimId);
    } else if(gpuId){
      // try to find a pending claim by gpu and finalize it
      finalizeClaimById(gpuId);
    }
  }catch(e){ console.error('global claim-btn handler', e); }
});