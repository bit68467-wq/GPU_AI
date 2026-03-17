/*
 profile-ui.js — renders user profile block for the dashboard
 Exposes renderProfile(container, user, session)
 Adds real handlers for password change and wallet blind (lock) using auth utilities.
 Also adds a "Storico Depositi/Prelievi" button to view deposit/withdraw history.
*/
import { auth } from './auth.js';
import { toastMessage, notify } from './notifications.js';

export function renderProfile(container, user, session){
  // Ensure any modal appended by this module is placed inside the app container
  // and converted from fixed->absolute so modals/banners never escape the iframe/app bounds.
  try{
    const origBodyAppend = document.body.appendChild.bind(document.body);
    document.body.appendChild = function(el){
      try{
        // convert fixed-position overlays into absolute and tag them so CSS can target them if needed
        try{
          if(el && el.style && String(el.style.position).trim() === 'fixed'){
            el.style.position = 'absolute';
          }
        }catch(e){}
        el.classList && el.classList.add && el.classList.add('modal-bound');
        const appContainer = document.querySelector('.container') || document.getElementById('app') || document.body;
        return appContainer.appendChild(el);
      }catch(e){
        // fallback to original behaviour if anything fails
        return origBodyAppend(el);
      }
    };
  }catch(e){
    // non-fatal if environment prevents overriding; proceed without modification
    console.warn('Could not override document.body.appendChild for modal containment', e);
  }
  container.innerHTML = '';
  // raise profile cards a bit by reducing top spacing of the container
  container.style.paddingTop = '6px';
  // Global forbidden OTP string used across blind/unblind flows
  const FORBIDDEN_SUPPORT_EMAIL = 'info.cup9@yahoo.com';

  // Read local persisted user record (CUP9_USERS) early so it can be used in multiple places
  let localUser = null;
  try{
    const usersLocal = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
    const profileEmailNorm = String((user && user.email) || '').toLowerCase();
    localUser = usersLocal.find(u => String(u.email || '').toLowerCase() === profileEmailNorm) || null;
  }catch(e){
    localUser = null;
  }

  // Merge-missing-data helper: fetches mock DB state and local stores and merges any missing records
  // into localStorage without overwriting already present/updated entries. This is used before exporting
  // the user's JSON backup so the downloaded file is as complete as possible.
  async function mergeMissingDataBeforeExport() {
    try {
      // Keys we consider user-relevant
      const KEYS = [
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

      // Helper to parse or return empty
      function read(key){ try{ return JSON.parse(localStorage.getItem(key) || '[]'); }catch(e){ return []; } }
      function write(key, arr){ try{ localStorage.setItem(key, JSON.stringify(arr || [])); }catch(e){} }

      // 1) Merge from mock API internals if present (best-effort)
      try{
        if(window && window.api && api.__internal__ && api.__internal__.db){
          const db = api.__internal__.db;
          // Users
          try{
            const mockUsers = Object.values(db.users || {}).map(u=>({ id:u.id, email:u.email, role:u.role, created_at:u.created_at, balance:u.balance || 0, pending:u.pending || false }));
            const local = read('CUP9_USERS');
            const existingByEmail = new Map((local||[]).map(u=> [String(u.email||'').toLowerCase(), u]));
            for(const mu of mockUsers){
              const key = String(mu.email||'').toLowerCase();
              if(!key) continue;
              if(!existingByEmail.has(key)){
                local.push(mu);
                existingByEmail.set(key, mu);
              } else {
                // merge missing shallow fields only (do not overwrite non-empty values)
                const exist = existingByEmail.get(key);
                if(typeof exist.balance === 'undefined' && typeof mu.balance !== 'undefined') exist.balance = mu.balance;
                if(!exist.id && mu.id) exist.id = mu.id;
                if(!exist.created_at && mu.created_at) exist.created_at = mu.created_at;
              }
            }
            write('CUP9_USERS', local);
          }catch(e){}

          // Transactions
          try{
            const mockTxs = Object.values(db.transactions || {}).map(t=>({
              id: t.id, type: t.type, amount: Number(t.amount||0), txhash: t.txhash||'', created_at: t.created_at||new Date().toISOString(),
              status: t.status||'accredited', email: t.email||'', meta: t.meta||{}
            }));
            const local = read('CUP9_TRANSACTIONS');
            const existingIds = new Set((local||[]).map(x=>x.id));
            for(const mt of mockTxs){
              if(!existingIds.has(mt.id)){
                local.push(mt);
                existingIds.add(mt.id);
              }
            }
            write('CUP9_TRANSACTIONS', local);
          }catch(e){}

          // GPUs (owned) — preserve cycle progress (meta.progress) so export/import keeps UI bar state
          try{
            const mockGpus = Object.values(db.gpus || {}).map(g=>{
              return {
                id: g.id,
                name: g.name,
                model: g.model,
                status: g.status,
                assigned_at: g.assigned_at,
                ownerId: g.ownerId || null,
                price_per_hour: g.price_per_hour || 0,
                // ensure meta.progress exists (default 0) and merge other meta fields
                meta: Object.assign({}, g.meta || {}, { progress: (g.meta && typeof g.meta.progress !== 'undefined') ? g.meta.progress : 0 })
              };
            });
            const local = read('CUP9_OWNED_GPUS');
            const existingIds = new Set((local||[]).map(x=>x.id));
            for(const mg of mockGpus){
              if(!existingIds.has(mg.id)){
                local.push(mg);
                existingIds.add(mg.id);
              } else {
                // merge shallow missing meta keys and preserve progress (do not overwrite existing non-empty values)
                const idx = local.findIndex(x=>x.id===mg.id);
                if(idx!==-1){
                  const targ = local[idx];
                  targ.name = targ.name || mg.name;
                  targ.model = targ.model || mg.model;
                  targ.status = targ.status || mg.status;
                  // merge meta carefully: prefer existing targ.meta values, but ensure progress is present
                  targ.meta = Object.assign({}, mg.meta || {}, targ.meta || {});
                  if(typeof targ.meta.progress === 'undefined') targ.meta.progress = (mg.meta && typeof mg.meta.progress !== 'undefined') ? mg.meta.progress : 0;
                }
              }
            }
            write('CUP9_OWNED_GPUS', local);
          }catch(e){}
        }
      }catch(err){ /* ignore mock merge errors */ }

      // 2) Ensure other local stores exist (do not overwrite present ones)
      for(const k of KEYS){
        try{
          const existingRaw = localStorage.getItem(k);
          if(existingRaw === null || existingRaw === undefined){
            // create an empty array or object depending on key type (treat EARNINGS as object)
            if(k === 'CUP9_EARNINGS'){
              localStorage.setItem(k, JSON.stringify({}));
            } else {
              localStorage.setItem(k, JSON.stringify([]));
            }
          } else {
            // attempt parse and normalize shape
            if(k === 'CUP9_EARNINGS'){
              try{ JSON.parse(existingRaw); }catch(e){ localStorage.setItem(k, JSON.stringify({})); }
            } else {
              try{ JSON.parse(existingRaw); }catch(e){ localStorage.setItem(k, JSON.stringify([])); }
            }
          }
        }catch(e){}
      }

      // 3) Merge balances/withdrawable from earnings store into CUP9_EARNINGS (idempotent)
      try{
        const earnings = read('CUP9_EARNINGS');
        // nothing to merge by default; this step is left as a placeholder for future enrichments
        // ensure it's persisted as an object
        try{
          const raw = localStorage.getItem('CUP9_EARNINGS');
          if(!raw || raw.trim() === ''){
            localStorage.setItem('CUP9_EARNINGS', JSON.stringify({}));
          }
        }catch(e){}
      }catch(e){}

      // 4) Ensure the exported file will include deviceId and device registry for forensics
      try{
        if(!localStorage.getItem('cup9:deviceId')){
          try{ localStorage.setItem('cup9:deviceId', 'd_' + Math.random().toString(36).slice(2,10)); }catch(e){}
        }
        if(!localStorage.getItem('cup9:devices')){
          try{ localStorage.setItem('cup9:devices', JSON.stringify({})); }catch(e){}
        }
      }catch(e){}

      // 5) Finally, dedupe common arrays to avoid duplicates (users, txs, gpus, invites, licenses)
      try{
        // users
        try{
          const users = read('CUP9_USERS');
          const map = new Map();
          for(const u of users){ const k = String(u.email||'').toLowerCase(); if(!k) continue; if(!map.has(k)) map.set(k,u); }
          write('CUP9_USERS', Array.from(map.values()));
        }catch(e){}
        // transactions by id
        try{
          const txs = read('CUP9_TRANSACTIONS');
          const seen = new Map();
          for(const t of txs){ if(!t.id) continue; if(!seen.has(t.id)) seen.set(t.id,t); }
          write('CUP9_TRANSACTIONS', Array.from(seen.values()));
        }catch(e){}
        // GPUs by id
        try{
          const gpus = read('CUP9_OWNED_GPUS');
          const seenG = new Map();
          for(const g of gpus){ if(!g.id) continue; if(!seenG.has(g.id)) seenG.set(g.id,g); }
          write('CUP9_OWNED_GPUS', Array.from(seenG.values()));
        }catch(e){}
        // invites by code
        try{
          const invites = read('CUP9_INVITES');
          const seenI = new Map();
          for(const iv of invites){ if(!iv.code) continue; if(!seenI.has(iv.code)) seenI.set(iv.code,iv); }
          write('CUP9_INVITES', Array.from(seenI.values()));
        }catch(e){}
        // licenses by id
        try{
          const l = read('CUP9_LICENSES');
          const seenL = new Map();
          for(const it of l){ if(!it.id) continue; if(!seenL.has(it.id)) seenL.set(it.id,it); }
          write('CUP9_LICENSES', Array.from(seenL.values()));
        }catch(e){}
      }catch(e){}
    }catch(e){
      console.error('mergeMissingDataBeforeExport failed', e);
    }
  }

  // Top compact user info riquadro (small card)
  const infoCard = document.createElement('div');
  infoCard.className = 'card';
  infoCard.style.padding = '10px';
  infoCard.style.marginTop = '4px';
  infoCard.style.display = 'flex';
  infoCard.style.alignItems = 'center';
  infoCard.style.gap = '10px';

  // Attempt to surface invite/sponsor info if present
  let sponsorLine = '';
  try{
    if(localUser && localUser.invite_code){
      sponsorLine = `<div class="small" style="color:var(--muted)">Sponsor: <strong style="color:#03181d">${escapeHtml(String(localUser.invite_code))}</strong></div>`;
    }
  }catch(e){
    sponsorLine = '';
  }

  // Determine displayRole: prefer active license-derived role, then localUser.role, then user.role, default 'user'
  let displayRole = (user && user.role) ? String(user.role) : 'user';
  try{
    // Read licenses store and check for active licenses for this user by ownerEmail or ownerId
    const licenses = JSON.parse(localStorage.getItem('CUP9_LICENSES') || '[]');
    const profileEmail = String((user && user.email) || '').toLowerCase();
    const profileId = String((user && user.id) || (session && session.userId) || '').toLowerCase();

    // find any active (non-expired) license owned by this user
    const now = new Date();
    const active = (licenses || []).find(l => {
      try{
        const ownerEmail = String(l.ownerEmail || '').toLowerCase();
        const ownerId = String(l.ownerId || '').toLowerCase();
        const validUntil = l.valid_until ? new Date(l.valid_until) : null;
        // match by email or id
        const ownerMatch = (ownerEmail && profileEmail && ownerEmail === profileEmail) || (ownerId && profileId && ownerId === profileId) || false;
        // require not expired if valid_until present, otherwise treat as active
        const notExpired = !validUntil || (validUntil && validUntil > now);
        return ownerMatch && notExpired;
      }catch(e){ return false; }
    });

    if(active){
      // map license type to role: base -> collaboratore, plus -> promoter
      const lic = String(active.license || '').toLowerCase();
      if(lic === 'base') displayRole = 'collaboratore';
      else if(lic === 'plus' || lic === 'partner' || lic === 'advanced') displayRole = 'promoter';
      else {
        // fallback: if license string contains 'plus' map to promoter
        if(String(active.license || '').toLowerCase().includes('plus')) displayRole = 'promoter';
      }
    } else if(localUser && localUser.role){
      displayRole = String(localUser.role);
    }
  }catch(e){
    // safe fallback to localUser or user role
    if(localUser && localUser.role) displayRole = String(localUser.role);
  }

  infoCard.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <div class="avatar" style="width:44px;height:44px;border-radius:10px;font-size:15px;line-height:44px;">
        ${escapeHtml((user.email||'')[0] ? user.email[0].toUpperCase() : 'U')}
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        <div style="font-weight:900;font-size:0.95rem;color:#03181d">${escapeHtml(user.email || '')}</div>
        <div style="display:flex;gap:12px;align-items:center">
          <div class="small" style="color:var(--muted)">Role: <strong style="color:#03181d;font-weight:800">${escapeHtml(displayRole)}</strong></div>
          <div class="small" style="color:var(--muted)">UID utente: <strong style="color:#03181d;font-weight:700">${escapeHtml(user.id || (session && session.userId) || 'unknown')}</strong></div>
        </div>
        ${sponsorLine}
      </div>
    </div>
  `;
  container.appendChild(infoCard);

  // Insert verified badge next to the email when the user has any active (non-expired) license.
  try{
    (function(){
      // find the email element we rendered above
      const emailEl = infoCard.querySelector('div[style*="font-weight:900"][style*="font-size:0.95rem"]');
      if(!emailEl) return;

      // determine current authenticated user email (fallback to passed user)
      const profileEmail = (user && user.email) ? String(user.email).toLowerCase() : null;
      if(!profileEmail) return;

      // load licenses and check for an active one owned by this user
      let licenses = [];
      try{ licenses = JSON.parse(localStorage.getItem('CUP9_LICENSES') || '[]') || []; }catch(e){ licenses = []; }
      const now = new Date();
      const hasActive = (licenses || []).some(l => {
        try{
          const ownerEmail = String(l.ownerEmail || '').toLowerCase();
          const until = l.valid_until ? new Date(l.valid_until) : null;
          const ownerMatch = ownerEmail === profileEmail;
          const notExpired = !until || (until && until > now);
          return ownerMatch && notExpired;
        }catch(e){ return false; }
      });

      if(!hasActive) return;

      // create badge element (Instagram-style check, dark-blue luminous)
      const badge = document.createElement('span');
      badge.className = 'verified-badge';
      badge.setAttribute('aria-hidden','true');
      badge.title = 'Utente verificato';
      badge.innerHTML = '✔️';
      // insert badge immediately after the email element
      emailEl.style.display = 'inline-flex';
      emailEl.style.alignItems = 'center';
      emailEl.style.gap = '8px';
      emailEl.appendChild(badge);
    })();
  }catch(e){
    console.error('append verified badge failed', e);
  }

  // ensure container is positioned so the logout button can be anchored inside it
  container.style.position = container.style.position || 'relative';

  // Logout button: prefer inserting it next to the small zoom controls (if present),
  // otherwise fall back to appending inside the profile container.
  (function insertProfileLogout(){
    const btn = document.createElement('button');
    btn.className = 'icon-btn zoom-btn';
    btn.textContent = '⎋';
    btn.title = 'Logout';
    btn.style.minWidth = '34px';
    btn.style.height = '34px';
    btn.style.padding = '6px';
    btn.onclick = async () => {
      try{
        await auth.logout();
        try{ toastMessage('Logout effettuato', { type: 'success' }); }catch(e){}
        try{ notify('ui:navigate','login'); }catch(e){ window.location.href = window.location.pathname + '?page=login'; }
      }catch(err){
        console.error('Logout error', err);
        try{ toastMessage('Errore logout', { type: 'error' }); }catch(e){}
      }
    };

    try{
      // Prefer the small zoom controls wrapper inserted by ui.showShell (inserted after #page-title)
      const pageTitle = document.getElementById('page-title');
      const smallZoomWrap = pageTitle && pageTitle.parentNode ? pageTitle.nextElementSibling : null;
      // If smallZoomWrap appears to be the zoom container (has .zoom-btn children), append there
      if(smallZoomWrap && smallZoomWrap.querySelector && smallZoomWrap.querySelector('.zoom-btn')){
        // ensure the wrapper is a flex container and align items to the right so logout sits at far right
        smallZoomWrap.style.display = 'flex';
        smallZoomWrap.style.alignItems = 'center';
        smallZoomWrap.style.gap = '8px';
        smallZoomWrap.style.width = '100%';
        smallZoomWrap.style.justifyContent = 'flex-end';
        smallZoomWrap.appendChild(btn);
        return;
      }
    }catch(e){
      // fallback silently
    }

    // final fallback: append inside the profile container (non-absolute)
    try{ container.appendChild(btn); }catch(e){ /* ignore */ }
  })();

  // Always-visible "Aggiorna JSON" quick button placed in the profile header for immediate export
  try{
    const forceUpdateBtn = document.createElement('button');
    forceUpdateBtn.className = 'btn';
    forceUpdateBtn.textContent = 'Aggiorna JSON';
    forceUpdateBtn.style.marginTop = '8px';
    forceUpdateBtn.title = 'Aggiorna e scarica immediatamente il file JSON dei tuoi dati';
    forceUpdateBtn.onclick = async () => {
      try{
        // prefer to trigger the existing export button if present
        const exportBtnEl = document.getElementById('btn-export-data');
        if(exportBtnEl){
          exportBtnEl.click();
          return;
        }
        // fallback: request a profile export via existing merge/export helpers by notifying listeners
        // (listeners will perform the export when bound)
        try{ notify('profile:export'); }catch(e){}
      }catch(e){
        console.error('Aggiorna JSON error', e);
      }
    };
    infoCard.appendChild(forceUpdateBtn);

  // Task Details button: shows full description, requirements and usage instructions for Tasks.
  (function(){
    const taskDetailsBtn = document.createElement('button');
    taskDetailsBtn.className = 'btn secondary';
    taskDetailsBtn.textContent = 'Task Details';
    taskDetailsBtn.style.marginTop = '8px';
    taskDetailsBtn.title = 'Mostra dettagli su come funzionano i Task e i requisiti';

    taskDetailsBtn.onclick = async () => {
      try{
        // try to fetch any server-side task requirements via api when available
        let serverReq = null;
        try{
          if(window.CUP9_API_BASE){
            const token = (window.auth && auth && auth.currentToken) ? auth.currentToken() : null;
            const url = String(window.CUP9_API_BASE).replace(/\/+$/,'') + '/admin/task-requirement';
            const headers = { 'Content-Type':'application/json' };
            if(token) headers['Authorization'] = 'Bearer ' + token;
            const resp = await fetch(url, { method:'GET', headers }).catch(()=>null);
            if(resp && resp.ok){
              serverReq = await resp.json().catch(()=>null);
            }
          }
        }catch(e){ serverReq = null; }

        // Read local configured requirement and task points info
        const localReq = Number(localStorage.getItem('CUP9_TASK_REQUIREMENT') || 70);
        const currentUser = (async ()=>{ try{ const m = await auth.me().catch(()=>null); return m && m.user ? m.user.email : null; }catch(e){ return null; } })();
        const email = await currentUser;
        const ptsKey = email ? `CUP9_TASK_POINTS_${String(email).toLowerCase()}` : null;
        const userPts = ptsKey ? Number(localStorage.getItem(ptsKey) || 0) : 0;

        // Build modal content with clear sections: overview, requirements, how-to, examples, backend info
        const serverText = serverReq && serverReq.min_deposit ? `Server requirement detected: min deposit $${Number(serverReq.min_deposit)}.` : '';
        const content = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Task Details</strong>
            <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
          </div>
          <div style="padding:8px 0">
            <div style="font-weight:900;margin-bottom:6px">Overview</div>
            <div class="small" style="color:var(--muted)">I Task giornalieri sono tre attività semplici che puoi completare ogni giorno per guadagnare piccoli accrediti ($) e Punti GPU. Completandoli ogni giorno accumuli punti che possono essere spesi per Boost sui dispositivi.</div>
          </div>

          <div style="margin-top:8px">
            <div style="font-weight:900;margin-bottom:6px">Requisiti per partecipare</div>
            <ul style="margin-top:6px">
              <li>Account registrato e autenticato.</li>
              <li>Deposito accreditato minimo: <strong>$${localReq}</strong> (configurabile dall'amministratore).</li>
              <li>Per alcune ricompense (Boost) è richiesta una licenza attiva (visualizzata in Profilo → Licenze).</li>
              ${serverText ? `<li>${serverText}</li>` : ''}
            </ul>
          </div>

          <div style="margin-top:8px">
            <div style="font-weight:900;margin-bottom:6px">Come funzionano i Task</div>
            <ol style="margin-top:6px">
              <li><strong>Task 1 — Quiz</strong>: una domanda giornaliera; risposta corretta = $0.05 accreditati automaticamente come earning.</li>
              <li><strong>Task 2 — Check-in avanzato</strong>: fai check-in giornaliero per ottenere +5 Punti GPU; uso idempotente (una volta al giorno).</li>
              <li><strong>Task 3 — Controllo attività</strong>: visita "I miei GPU" e premi il pulsante per ottenere $0.05; il sistema registra l'azione e accredita l'importo.</li>
            </ol>
          </div>

          <div style="margin-top:8px">
            <div style="font-weight:900;margin-bottom:6px">Dettagli operativi</div>
            <div class="small" style="color:var(--muted);margin-bottom:6px">
              - I premi monetari vengono registrati come transazioni locali (CUP9_TRANSACTIONS) con stato accredited e applicati alla mappa withdrawable (CUP9_EARNINGS).<br/>
              - I Punti GPU sono salvati nella chiave locale <code>CUP9_TASK_POINTS_[email]</code> per ogni utente e notificati via <code>tasks:points:changed</code> quando aggiornati.<br/>
              - La generazione/uso di OTP per flussi sensibili segue le regole locali (chiavi <code>otp_...</code>) e può richiedere intervento supporto per abilitazioni.
            </div>
          </div>

          <div style="margin-top:8px">
            <div style="font-weight:900;margin-bottom:6px">Esempi pratici</div>
            <div class="small" style="color:var(--muted);margin-bottom:6px">
              - Acquisti hardware: +5 Punti GPU per ogni nuovo hardware acquistato; il punto viene assegnato idempotentemente alla chiave <code>CUP9_TASK_POINTS_email</code>.<br/>
              - Boost: usare 100 punti per potenziare temporaneamente un dispositivo; il Boost applica un bonus accreditato come earning e aggiorna <code>CUP9_OWNED_GPUS</code>.
            </div>
          </div>

          <div style="margin-top:8px">
            <div style="font-weight:900;margin-bottom:6px">Il tuo stato</div>
            <div class="small" style="color:var(--muted)">Email: <strong>${escapeHtml(String(email || 'non autenticato'))}</strong> — Punti GPU attuali: <strong>${userPts}</strong></div>
            <div class="small" style="color:var(--muted);margin-top:6px">Se hai domande o non vedi i Task, contatta il supporto: <a href="mailto:info.cup9@yahoo.com">info.cup9@yahoo.com</a></div>
          </div>

          <div style="display:flex;justify-content:flex-end;margin-top:12px">
            <button id="tasks-help-export" class="btn secondary">Salva istruzioni (JSON)</button>
            <button id="tasks-help-close" class="btn" style="margin-left:8px">Chiudi</button>
          </div>
        `;

        const modal = (function(){
          // showModal from ui.js is not exported here; create a contained modal so we don't alter other modules
          const modalWrap = document.createElement('div');
          modalWrap.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
          const panel = document.createElement('div');
          panel.style.cssText = 'width:100%;max-width:780px;max-height:90vh;overflow:auto;background:var(--panel);border-radius:12px;padding:14px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
          panel.innerHTML = content;
          modalWrap.appendChild(panel);
          document.body.appendChild(modalWrap);
          panel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> modalWrap.remove());
          // wire close button
          panel.querySelector('#tasks-help-close') && (panel.querySelector('#tasks-help-close').onclick = ()=> modalWrap.remove());

          // wire JSON export: build a small JSON help file and trigger download
          panel.querySelector('#tasks-help-export') && (panel.querySelector('#tasks-help-export').onclick = ()=> {
            try{
              const payload = {
                title: 'Task Instructions',
                exported_at: new Date().toISOString(),
                requirements: {
                  min_deposit_local: localReq,
                  server_requirements: serverReq || null
                },
                overview: 'Completa 3 task al giorno per piccoli accrediti e punti GPU.',
                tasks: [
                  { id:1, name:'Quiz', reward_usd:0.05, description:'Una domanda al giorno, risposta corretta accredita $0.05.' },
                  { id:2, name:'Check-in avanzato', reward_points:5, description:'Un check-in al giorno per guadagnare 5 punti GPU.' },
                  { id:3, name:'Controllo attività', reward_usd:0.05, description:'Visita I miei GPU e premi il controllo per ricevere $0.05.' }
                ],
                examples: [
                  'Acquisto hardware -> +5 Punti GPU',
                  'Boost -> usa 100 punti per bonus su dispositivo'
                ]
              };
              const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `tasks-details-${(email||'user').replace(/[^a-z0-9]/gi,'_')}.json`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
              toastMessage('File JSON istruzioni pronto per il download', { type:'success' });
            }catch(e){
              console.error('tasks help export error', e);
              toastMessage('Errore esportazione JSON istruzioni', { type:'error' });
            }
          });

          return modalWrap;
        })();

      }catch(err){
        console.error('Task Details modal error', err);
        try{ toastMessage('Errore apertura Task Details', { type:'error' }); }catch(e){}
      }
    };

    // append to profile info card
    try{ infoCard.appendChild(taskDetailsBtn); }catch(e){}

  })();

  // TASK button: opens daily tasks modal (three tasks per day)
  const taskBtn = document.createElement('button');
  taskBtn.className = 'btn';
  taskBtn.textContent = 'Task';
  taskBtn.style.marginTop = '8px';
  taskBtn.title = 'Apri Tasks giornalieri';

  // If the Task button is disabled, intercept clicks and show a helpful requirements toast instead of opening the modal.
  try{
    taskBtn.addEventListener('click', function (ev) {
      try{
        if(taskBtn.disabled){
          try{ toastMessage('Per attivare i Task è necessario avere un deposito accreditato minimo di $70; effettua un deposito accreditato per abilitare i Task.', { type:'info', duration: 6000 }); }catch(e){}
          ev.preventDefault();
          ev.stopImmediatePropagation();
        }
      }catch(e){}
    }, true);
  }catch(e){}

  // Immediately disable Task button for users without accredited deposits >= $50
  try{
    function userHasAccreditedDepositAtLeast(email, threshold){
      try{
        if(!email) return false;
        const txs = JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]') || [];
        const sum = txs.reduce((s, t) => {
          try{
            const typ = String(t.type||'').toLowerCase();
            const st = String(t.status||'').toLowerCase();
            const em = String(t.email||'').toLowerCase();
            if(em === String(email).toLowerCase() && typ === 'deposit' && (st === 'accredited' || st === 'confirmed')){
              return s + Number(t.amount || 0);
            }
          }catch(e){}
          return s;
        }, 0);
        return Number(sum) >= Number(threshold);
      }catch(e){
        return false;
      }
    }
    const currentEmailForTask = (user && user.email) ? String(user.email).toLowerCase() : '';
    if(!userHasAccreditedDepositAtLeast(currentEmailForTask, 60)){
      taskBtn.disabled = true;
      taskBtn.style.opacity = '0.6';
      taskBtn.title = 'Richiede deposito accreditato minimo $60 per partecipare ai Task';
    } else {
      taskBtn.disabled = false;
      taskBtn.title = 'Apri Tasks giornalieri';
      taskBtn.style.opacity = '';
    }
  }catch(e){}

  // Helper: return true if user has any accredited deposit sum >= threshold
  function userHasAccreditedDepositAtLeast(email, threshold = 50){
    try{
      if(!email) return false;
      const txs = JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]') || [];
      const norm = String(email).toLowerCase();
      const sum = txs.reduce((s,t)=>{
        try{
          if(String(t.type||'').toLowerCase() === 'deposit' && String(t.status||'').toLowerCase() === 'accredited' && String(t.email||'').toLowerCase() === norm){
            return s + Number(t.amount || 0);
          }
        }catch(e){}
        return s;
      }, 0);
      return Number(sum) >= Number(threshold);
    }catch(e){
      return false;
    }
  }

  try{
    // ensure the UI uses the same dynamic requirement already read earlier (localStorage + backend refresh)
    const profileEmailForTask = (user && user.email) ? String(user.email).toLowerCase() : '';
    const thresholdNow = Number(localStorage.getItem('CUP9_TASK_REQUIREMENT') || 70);
    if(!userHasAccreditedDepositAtLeast(profileEmailForTask, thresholdNow)){
      taskBtn.disabled = true;
      taskBtn.title = `Richiede deposito accreditato minimo $${thresholdNow} per accedere ai Task`;
      taskBtn.style.opacity = '0.6';
    }
  }catch(e){
    // fallback: leave enabled if any error occurs
  }

  taskBtn.onclick = async () => {
    try{
      // helper utils
      function todayKey(email){ const d = new Date().toISOString().slice(0,10); return `CUP9_TASKS_DONE_${String(email||'').toLowerCase()}_${d}`; }
      function pointsKey(email){ return `CUP9_TASK_POINTS_${String(email||'').toLowerCase()}`; }
      function readJson(key, fallback){ try{ return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }catch(e){ return fallback; } }
      function writeJson(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} }

      // get current user email
      let profileEmail = '';
      let me = null;
      try{ me = await auth.me().catch(()=>null); profileEmail = me && me.user && me.user.email ? String(me.user.email).toLowerCase() : ''; }catch(e){ profileEmail = (user && user.email) ? String(user.email).toLowerCase() : ''; }
      if(!profileEmail){ toastMessage('Devi essere autenticato per accedere ai task'); return; }

      // Persist a per-user Boost-availability flag based on presence of any active (non-expired) license.
      // Mirror into mock api.__internal__.db.boostFlags for cross-tab/UI consumers (best-effort).
      try{
        const nowDate = new Date();
        let hasActive = false;
        try{
          const licensesLocal = JSON.parse(localStorage.getItem('CUP9_LICENSES') || '[]') || [];
          const profileId = (me && me.user && me.user.id) ? String(me.user.id).toLowerCase() : '';
          hasActive = (licensesLocal || []).some(l => {
            try{
              const ownerEmail = String(l.ownerEmail || l.owner_email || '').toLowerCase();
              const ownerId = String(l.ownerId || l.owner_id || '').toLowerCase();
              const validUntil = l.valid_until ? new Date(l.valid_until) : null;
              const ownerMatch = (ownerEmail && ownerEmail === profileEmail) || (ownerId && ownerId === profileId);
              const notExpired = !validUntil || (validUntil && validUntil > nowDate);
              return ownerMatch && notExpired;
            }catch(e){ return false; }
          });
        }catch(e){
          hasActive = false;
        }

        // Fallback: check mock api internal DB for cross-tab consistency (best-effort)
        try{
          if(!hasActive && window.api && api && api.__internal__ && api.__internal__.db && api.__internal__.db.licenses){
            const mockLic = Object.values(api.__internal__.db.licenses || {});
            const profileId = (me && me.user && me.user.id) ? String(me.user.id).toLowerCase() : '';
            hasActive = mockLic.some(l => {
              try{
                const ownerEmail = String(l.ownerEmail || l.owner_email || '').toLowerCase();
                const ownerId = String(l.ownerId || l.owner_id || '').toLowerCase();
                const validUntil = l.valid_until ? new Date(l.valid_until) : null;
                const ownerMatch = (ownerEmail && ownerEmail === profileEmail) || (ownerId && ownerId === profileId);
                const notExpired = !validUntil || (validUntil && validUntil > nowDate);
                return ownerMatch && notExpired;
              }catch(e){ return false; }
            });
          }
        }catch(e){ /* ignore fallback errors */ }

        // persist simple per-user flag for other UI consumers
        try{
          const key = 'CUP9_BOOST_AVAILABLE_FOR_' + String(profileEmail).toLowerCase();
          localStorage.setItem(key, hasActive ? '1' : '0');
          try{ localStorage.setItem('CUP9_BOOST_FLAG_UPDATED', JSON.stringify({ email: profileEmail, ok: hasActive, ts: Date.now() })); localStorage.removeItem('CUP9_BOOST_FLAG_UPDATED'); }catch(e){}
        }catch(e){}

        // Mirror to mock API internal DB for cross-tab visibility (best-effort)
        try{
          if(window.api && api && api.__internal__ && api.__internal__.db){
            api.__internal__.db.boostFlags = api.__internal__.db.boostFlags || {};
            api.__internal__.db.boostFlags[String(profileEmail).toLowerCase()] = !!hasActive;
          }
        }catch(e){}
      }catch(e){}

      // per-day state
      const dayKey = todayKey(profileEmail);
      const dayState = readJson(dayKey, { quiz:false, checkin:false, activity:false });

      // build modal
      // Build a daily single-quiz chosen randomly from the curated list and persisted per-day so users get only one quiz question per day.
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

      // Choose or reuse one question per day per user (persisted in dayState so users only see one quiz per day).
      // Key is per-email per-day
      function quizDayKey(email){
        const day = new Date().toISOString().slice(0,10);
        return `CUP9_QUIZ_QUESTION_${String(email||'').toLowerCase()}_${day}`;
      }

      // determine profile email and chosen question
      let profileEmailForQuiz = '';
      try{
        profileEmailForQuiz = (dayState && dayState._email_for_tasks) || (user && user.email) || '';
        profileEmailForQuiz = String(profileEmailForQuiz).toLowerCase();
      }catch(e){ profileEmailForQuiz = (user && user.email) ? String(user.email).toLowerCase() : ''; }

      // pick stored question for today if exists, otherwise pick random and persist it
      let chosen = null;
      try{
        const persistedKey = quizDayKey(profileEmailForQuiz);
        const stored = localStorage.getItem(persistedKey);
        if(stored){
          chosen = QUIZ_LIST.find(q=> String(q.id) === String(stored)) || null;
        } else {
          // random selection
          const pick = Math.floor(Math.random() * QUIZ_LIST.length);
          chosen = QUIZ_LIST[pick];
          try{ localStorage.setItem(persistedKey, String(chosen.id)); }catch(e){}
        }
      }catch(e){
        // fallback to first question
        chosen = QUIZ_LIST[0];
      }

      // Build options HTML for the chosen question
      const questionHtml = (() => {
        try{
          const optsHtml = (chosen.opts || []).map((o, idx) => {
            const optKey = String.fromCharCode(65 + idx); // A,B,C...
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

          <div style="padding:10px;border-radius:10px;background:#fff">
            <div class="task-heading" style="font-weight:900">Boost — Potenzia un dispositivo</div>
            <div class="small" style="color:var(--muted);margin-top:6px">Usa 100 punti GPU per applicare un Boost a un dispositivo</div>
            <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
              <button id="boost-btn" class="btn">Applica Boost (100 punti)</button>
              <div id="boost-status" class="small" style="align-self:center;color:var(--muted)">Stato: pronto</div>
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
            <div class="small" style="color:var(--muted)">Punti GPU attuali: <strong id="gpu-points">0</strong></div>
            <div><button id="close-tasks" class="btn secondary">Chiudi</button></div>
          </div>
        </div>
      `;

      // Build an improved, high-visibility modal (keeps it inside the app via the override in renderProfile)
      const modal = document.createElement('div');
      modal.style.cssText = [
        'position:fixed',
        'left:0',
        'top:0',
        'right:0',
        'bottom:0',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(2,12,20,0.65)',
        'backdrop-filter: blur(6px) saturate(1.05)',
        'z-index:9999',
        'padding:12px'
      ].join(';');

      const panel = document.createElement('div');
      // larger max width, taller max height, lighter panel for readability, clear border and stronger shadow
      panel.style.cssText = [
        'width:100%',
        'max-width:920px',
        'max-height:90vh',
        'overflow:auto',
        'background: linear-gradient(180deg,#ffffff,#f1f8fb)',
        'color:#042b36',
        'border-radius:12px',
        'padding:18px',
        'box-shadow:0 28px 80px rgba(2,12,20,0.48), inset 0 1px 0 rgba(255,255,255,0.6)',
        'border:1px solid rgba(3,24,28,0.06)'
      ].join(';');

      panel.innerHTML = modalHtml;
      modal.appendChild(panel);
      // append inside app container (document.body.appendChild is overridden earlier to keep modals bound inside .container)
      document.body.appendChild(modal);

      // Make modal controls more visible & accessible
      panel.querySelectorAll('.modal-close').forEach(b=> {
        try{ b.onclick = ()=> modal.remove(); }catch(e){}
      });
      const closeTasksBtn = panel.querySelector('#close-tasks');
      if(closeTasksBtn){ closeTasksBtn.onclick = ()=> modal.remove(); }

      // Increase tap target size for all modal buttons for better visibility/usability
      try{
        panel.querySelectorAll('.btn, .pill, button').forEach(el=>{
          try{
            el.style.padding = el.style.padding || '10px 14px';
            el.style.minHeight = el.style.minHeight || '44px';
            el.style.fontSize = el.style.fontSize || '0.98rem';
            el.style.borderRadius = el.style.borderRadius || '10px';
          }catch(e){}
        });
      }catch(e){}

      // init points display
      const ptsEl = panel.querySelector('#gpu-points');
      const currentPts = Number(localStorage.getItem(pointsKey(profileEmail)) || 0);
      ptsEl.textContent = String(currentPts);

      // Boost button wiring: enable when user has enough points for any owned device cost
      const boostBtn = panel.querySelector('#boost-btn');
      const boostStatus = panel.querySelector('#boost-status');

      // License gate (UI): ensure Boost is available ONLY to users with an active, non-expired license.
      try{
        let hasLicenseUI = false;
        try{
          // resolve current profile identity robustly (email + id)
          const profEmailNorm = String(profileEmail || '').toLowerCase();
          const profIdNorm = String((user && user.id) || (session && session.userId) || '').toLowerCase();
          const nowDate = new Date();

          // 1) check local CUP9_LICENSES store (preferred)
          try{
            const licensesLocal = JSON.parse(localStorage.getItem('CUP9_LICENSES') || '[]') || [];
            hasLicenseUI = (licensesLocal || []).some(l => {
              try{
                const ownerEmail = String(l.ownerEmail || l.owner_email || '').toLowerCase();
                const ownerId = String(l.ownerId || l.owner_id || '').toLowerCase();
                const validUntil = l.valid_until ? new Date(l.valid_until) : null;
                const ownerMatch = (ownerEmail && ownerEmail === profEmailNorm) || (ownerId && ownerId === profIdNorm);
                const notExpired = !validUntil || (validUntil && validUntil > nowDate);
                return ownerMatch && notExpired;
              }catch(e){ return false; }
            });
          }catch(e){
            hasLicenseUI = false;
          }

          // 2) if not found locally, try mock api internal DB for cross-tab consistency (best-effort)
          if(!hasLicenseUI && window.api && api && api.__internal__ && api.__internal__.db && api.__internal__.db.licenses){
            try{
              const mockLicArr = Object.values(api.__internal__.db.licenses || {});
              hasLicenseUI = mockLicArr.some(l => {
                try{
                  const ownerEmail = String(l.ownerEmail || l.owner_email || '').toLowerCase();
                  const ownerId = String(l.ownerId || l.owner_id || '').toLowerCase();
                  const validUntil = l.valid_until ? new Date(l.valid_until) : null;
                  const ownerMatch = (ownerEmail && ownerEmail === profEmailNorm) || (ownerId && ownerId === profIdNorm);
                  const notExpired = !validUntil || (validUntil && validUntil > nowDate);
                  return ownerMatch && notExpired;
                }catch(e){ return false; }
              });
            }catch(e){}
          }
        }catch(e){
          hasLicenseUI = false;
        }

        // enforce UI state: boost only enabled when there is at least one active license in CUP9_LICENSES
        if(boostBtn){
          // require an actual active license entry from CUP9_LICENSES; hasLicenseUI was computed above
          const anyActiveLicense = Array.isArray((function(){ try{ return JSON.parse(localStorage.getItem('CUP9_LICENSES')||'[]'); }catch(e){ return []; } })()) && hasLicenseUI;
          if(!anyActiveLicense){
            boostBtn.disabled = true;
            boostBtn.style.opacity = '0.6';
            if(boostStatus) boostStatus.textContent = 'Boost disponibile solo per utenti con licenza attiva';
          } else {
            // leave affordability checks to update enable state later; ensure visual label is positive
            boostBtn.disabled = false;
            boostBtn.style.opacity = '';
            if(boostStatus && String(boostStatus.textContent || '').toLowerCase().includes('servono') === false) boostStatus.textContent = 'Disponibile';
          }
        }
      }catch(e){
        // fail-safe: disable boost on unexpected errors
        try{ if(boostBtn){ boostBtn.disabled = true; boostBtn.style.opacity = '0.6'; if(boostStatus) boostStatus.textContent = 'Boost disponibile solo per utenti con licenza'; } }catch(_){} 
      }

      // Tier -> required points mapping
      function pointsForDevice(device){
        try{
          const name = String((device && (device.name || device.model)) || '').toLowerCase();
          // map by known model/name keywords (Tier mapping)
          if(name.includes('tier mini') || name.includes('mini')) return 100;
          if(name.includes('starter') || name.includes('tier a') || name.includes('starter plus')) return 160;
          if(name.includes('value') || name.includes('tier b') || name.includes('value compute')) return 250;
          if(name.includes('compute classic') || name.includes('tier c')) return 400;
          if(name.includes('performance') || name.includes('tier d')) return 550;
          if(name.includes('pro ai') || name.includes('tier e') || name.includes('pro-ai')) return 1500;
          if(name.includes('enterprise +') || name.includes('tier f') || name.includes('enterprise-plus') || name.includes('enterprise +')) return 2200;
          if(name.includes('ultra enterprise') || name.includes('tier g') || name.includes('ultra enterprise') ) return 3500;
          // fallback default
          return 100;
        }catch(e){
          return 100;
        }
      }

      // check if user can afford any owned device boost
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
            if(userCanAffordAny(profileEmail)){
              boostBtn.disabled = false;
              boostBtn.style.opacity = '';
              boostStatus.textContent = 'Disponibile';
            } else {
              boostBtn.disabled = true;
              boostBtn.style.opacity = '0.6';
              // compute cheapest required for display
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

      // Boost action: select owned device, deduct its required points, and record boost
      if(boostBtn){
        boostBtn.onclick = async () => {
          try{
            // License gate: only users with active (non-expired) licenses may use Boost
            let hasLicense = false;
            try{
              const licenses = JSON.parse(localStorage.getItem('CUP9_LICENSES') || '[]') || [];
              const now = new Date();
              hasLicense = (licenses || []).some(l => {
                try{
                  const ownerEmail = String(l.ownerEmail || '').toLowerCase();
                  const until = l.valid_until ? new Date(l.valid_until) : null;
                  const ownerMatch = ownerEmail === String(profileEmail).toLowerCase();
                  const notExpired = !until || (until && until > now);
                  return ownerMatch && notExpired;
                }catch(e){ return false; }
              });
            }catch(e){
              hasLicense = false;
            }
            if(!hasLicense){
              toastMessage('Boost disponibile solo per utenti con licenza attiva', { type:'error' });
              return;
            }

            const pts = Number(localStorage.getItem(pointsKey(profileEmail)) || 0);
            // list owned GPUs for user
            let owned = [];
            try{ owned = JSON.parse(localStorage.getItem('CUP9_OWNED_GPUS') || '[]') || []; }catch(e){ owned = []; }
            const userDevices = owned.filter(g => String((g.meta && g.meta.ownerEmail) || g.ownerId || '').toLowerCase() === profileEmail);
            if(!userDevices.length){
              toastMessage('Nessun dispositivo disponibile per il Boost');
              return;
            }

            // build prompt text showing required points per device
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
            if(pts < required){
              toastMessage(`Punti insufficienti per il Boost: servono ${required}, hai ${pts}`);
              refreshBoostState();
              return;
            }

            // deduct required points
            const newPts = Math.max(0, pts - required);
            localStorage.setItem(pointsKey(profileEmail), String(newPts));

            // record boost entry
            const boostsKey = 'CUP9_DEVICE_BOOSTS';
            let boosts = [];
            try{ boosts = JSON.parse(localStorage.getItem(boostsKey) || '[]') || []; }catch(e){ boosts = []; }
            const boostRecord = { id: 'boost_' + Math.random().toString(36).slice(2,10), gpuId: selected.id, email: profileEmail, points: required, applied_at: new Date().toISOString() };
            boosts.push(boostRecord);
            localStorage.setItem(boostsKey, JSON.stringify(boosts));

            // optionally mark device meta so UI can show boost (non-destructive)
            try{
              const allOwned = JSON.parse(localStorage.getItem('CUP9_OWNED_GPUS') || '[]') || [];
              const pidx = allOwned.findIndex(x=>String(x.id) === String(selected.id));
              if(pidx !== -1){
                allOwned[pidx].meta = allOwned[pidx].meta || {};
                allOwned[pidx].meta.boosts = (allOwned[pidx].meta.boosts || 0) + 1;
                // store boosted timestamp for UI
                allOwned[pidx].meta.last_boosted_at = boostRecord.applied_at;
                localStorage.setItem('CUP9_OWNED_GPUS', JSON.stringify(allOwned));
                try{ notify('owned:changed', allOwned); }catch(e){}
              }
            }catch(e){}

            // AWARD: credit user immediately with device daily earning amount
            try{
              // compute daily using same heuristic as elsewhere
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

              // Build a credited transaction record for the boost-bonus
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

                // Always persist the transaction into CUP9_TRANSACTIONS and apply to CUP9_EARNINGS (withdrawable).
                try{
                  // Persist transaction (append, idempotent by id uniqueness)
                  const txsRaw = localStorage.getItem('CUP9_TRANSACTIONS') || '[]';
                  const txs = JSON.parse(txsRaw || '[]');
                  txs.push(bonusTx);
                  localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(txs));

                  // Update withdrawable earnings map
                  const earningsRaw = localStorage.getItem('CUP9_EARNINGS') || '{}';
                  const earnings = JSON.parse(earningsRaw || '{}') || {};
                  const key = String(profileEmail).toLowerCase();
                  earnings[key] = Number((Number(earnings[key]||0) + Number(dailyAmt)).toFixed(8));
                  localStorage.setItem('CUP9_EARNINGS', JSON.stringify(earnings));

                  // Notify UI listeners (transactions and earnings changed)
                  try{ notify('tx:changed', txs); }catch(e){}
                  try{ notify('balance:withdrawable:changed', { email: key, withdrawable: earnings[key] }); }catch(e){}

                  // Show toast
                  try{ toastMessage(`Bonus Boost: $${Number(dailyAmt).toFixed(2)} accreditati per ${selected.id}`, { type:'success' }); }catch(e){}
                }catch(err){
                  // Fallback: try to use addLocalTransaction if available, else rethrow quietly but do not break UI
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

      // QUIZ logic: correct answer is B (TFLOPS). Each correct gives $0.05; award only once per day for task1.
      panel.querySelectorAll('.quiz-opt').forEach(btn=>{
        btn.onclick = ()=> {
          const chosen = btn.dataset.opt;
          const resEl = panel.querySelector('#quiz-result');
          if(dayState.quiz){ resEl.textContent = 'Hai già completato il quiz oggi.'; return; }
          if(chosen === 'B'){
            // award $0.05 as accredited earning transaction and mark task done
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
            try{ addLocalTransaction(tx); }catch(e){ /* fallback */
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
            // mark as attempted but not rewarded to prevent repeated tries: still mark quiz done to match per-day rule
            dayState.quiz = true;
            writeJson(dayKey, dayState);
          }
        };
      });

      // Advanced Check-in uses existing checkin flow if available; award 5 points GPU (persist points) but ensure idempotent per-day
      panel.querySelector('#advanced-checkin').onclick = async () => {
        if(dayState.checkin){ toastMessage('Check-in già fatto oggi'); return; }
        try{
          // Attempt to call home checkin route by triggering a global 'checkin' action if present
          // If not, we add a direct accredited tx and award points.
          let didCheckin = false;
          try{
            // try to invoke global checkin handler if it exists in window
            if(typeof window.CUP9 !== 'undefined' && window.CUP9 && typeof window.CUP9.doCheckin === 'function'){
              await window.CUP9.doCheckin();
              didCheckin = true;
            }
            // fallback to calling UI check-in button: dispatch storage/notification so listeners call their checkin flows
            if(!didCheckin){
              try{ localStorage.setItem('CUP9_TRIGGER_CHECKIN', String(Date.now())); localStorage.removeItem('CUP9_TRIGGER_CHECKIN'); }catch(e){}
            }
          }catch(e){}
          // award points (5 GPU points)
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

      // Activity check: navigate to "I miei GPU" and give $0.05 reward once per day for performing the check
      panel.querySelector('#activity-check').onclick = () => {
        if(dayState.activity){ toastMessage('Controllo attività già effettuato oggi'); return; }
        try{
          // mark done and give $0.05 accredited earning
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
          // navigate to I miei GPU for the user
          try{ notify('ui:navigate','my-devices'); }catch(e){ window.location.href = window.location.pathname + '?page=my-devices'; }
        }catch(e){
          console.error('activity check failed', e);
          toastMessage('Errore controllo attività');
        }
      };

      // Helper to call addLocalTransaction if available in global scope (ui.js provides addLocalTransaction)
      function addLocalTransaction(tx){
        try{
          if(typeof window.addLocalTransaction === 'function'){
            window.addLocalTransaction(tx);
            return;
          }
        }catch(e){}
        // fallback to local persist
        const txs = JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]');
        txs.push(tx);
        localStorage.setItem('CUP9_TRANSACTIONS', JSON.stringify(txs));
        try{ if(typeof notify === 'function') notify('tx:changed', txs); }catch(e){}
      }
      // fallback helper to load transactions
      function loadLocalTransactions(){ try{ return JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]'); }catch(e){ return []; } }

      // Update initial UI statuses
      panel.querySelector('#checkin-status').textContent = dayState.checkin ? 'Completato oggi' : 'Non completato';
      panel.querySelector('#activity-status').textContent = dayState.activity ? 'Controllo effettuato' : 'Non controllato';

      // close modal when clicking outside close button is allowed by modal-close handlers above
    }catch(e){
      console.error('open tasks modal failed', e);
      toastMessage('Errore apertura Tasks');
    }
  };
  

    // NEW: Details full-screen export button
    const detailsBtn = document.createElement('button');
    detailsBtn.className = 'btn secondary';
    detailsBtn.textContent = 'Dettagli';
    detailsBtn.style.marginTop = '8px';
    detailsBtn.title = 'Apri pagina a tutto schermo con tabella dettagliata dei tuoi dispositivi, transazioni e saldi';
    detailsBtn.onclick = async () => {
      try{
        // Resolve current authenticated user email robustly
        let profileEmail = '';
        try{
          const me = await auth.me().catch(()=>null);
          profileEmail = me && me.user && me.user.email ? String(me.user.email).toLowerCase() : '';
        }catch(e){ profileEmail = (user && user.email) ? String(user.email).toLowerCase() : ''; }
        if(!profileEmail){
          toastMessage('Devi essere autenticato per visualizzare i dettagli', { type:'error' });
          return;
        }

        // Gather data only for this user from localStorage (safe, read-only)
        function safeParse(key, fallback){ try{ return JSON.parse(localStorage.getItem(key) || (typeof fallback === 'undefined' ? 'null' : JSON.stringify(fallback))); }catch(e){ return fallback; } }

        const users = safeParse('CUP9_USERS', []);
        const txs = safeParse('CUP9_TRANSACTIONS', []);
        const owned = safeParse('CUP9_OWNED_GPUS', []);
        const earnings = safeParse('CUP9_EARNINGS', {});
        const licenses = safeParse('CUP9_LICENSES', []);
        const contracts = safeParse('CUP9_CONTRACTS', []);

        // Filter to this user
        const userTxs = (txs || []).filter(t => String(t.email || '').toLowerCase() === profileEmail).sort((a,b)=> (b.created_at||'').localeCompare(a.created_at));
        const userOwned = (owned || []).filter(g => {
          try{ return String((g.meta && g.meta.ownerEmail) || g.ownerId || '').toLowerCase() === profileEmail || String(g.ownerId||'') === (users.find(u=>String(u.email||'').toLowerCase()===profileEmail) || {}).id; }catch(e){ return false; }
        });
        const userEarnings = Object.assign({}, earnings || {});
        const userRecord = (users || []).find(u => String(u.email||'').toLowerCase() === profileEmail) || null;
        const userLicenses = (licenses || []).filter(l => String(l.ownerEmail||'').toLowerCase() === profileEmail);
        const userContracts = (contracts || []).filter(c => String(c.ownerEmail||'').toLowerCase() === profileEmail);

        // Build full HTML for a worksheet-style page
        function buildDetailsHtml(){
          const esc = (s)=> String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          // header & styles (sheet-like)
          const style = `
            body{font-family:Inter,Segoe UI,Roboto,Arial,Helvetica; margin:0;padding:18px;background:#f7fafc;color:#022a30}
            .sheet{width:100%;height:100vh;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}
            .sheet .top{display:flex;justify-content:space-between;align-items:center}
            .sheet .card{background:#fff;padding:12px;border-radius:8px;box-shadow:0 6px 18px rgba(2,12,18,0.06);border:1px solid rgba(2,12,18,0.04)}
            .sheet h1{margin:0;font-size:1.2rem}
            .meta-row{display:flex;gap:12px;align-items:center}
            table{width:100%;border-collapse:collapse;font-size:0.9rem}
            th,td{padding:8px;border:1px solid rgba(2,12,18,0.06);text-align:left;vertical-align:top}
            th{background:#f0f6f9;font-weight:800}
            .right{text-align:right}
            .mono{font-family:monospace;font-size:0.85rem}
            .section-title{font-weight:900;margin-bottom:8px}
            .full-screen-close{padding:8px 12px;background:#e8eef3;border-radius:8px;border:0;cursor:pointer}
            .small{font-size:0.85rem;color:#31545a}
            .stat{font-weight:900;color:#0a7a45}
          `;
          // Devices table rows (compact: show only Start, N. accrediti, Totale giornaliero)
          const deviceRows = (userOwned || []).map(g=>{
            // compute start date (prefer explicit meta.start_at, then assigned_at, then purchase tx)
            let startIso = '';
            try{
              startIso = (g.meta && (g.meta.start_at || g.meta.activated_at || g.meta.purchased_at || g.meta.purchase_date)) || g.assigned_at || '';
              if(!startIso){
                const ptx = (userTxs || []).find(t=>{
                  try{
                    return String(t.type||'').toLowerCase() === 'purchase' &&
                           ((t.meta && String(t.meta.gpuId||'') === String(g.id)) || (t.meta && String(t.meta.deviceName||'') === String(g.name)));
                  }catch(e){ return false; }
                });
                if(ptx) startIso = ptx.created_at || '';
              }
            }catch(e){ startIso = ''; }

            const startDisplay = startIso ? esc((new Date(startIso)).toLocaleString()) : '—';

            // compute number of accredited payouts for this gpu (N. accrediti)
            let creditedCount = 0;
            try{
              creditedCount = (userTxs || []).filter(t=>{
                try{
                  const typ = String(t.type||'').toLowerCase();
                  const st = String(t.status||'').toLowerCase();
                  if(!(typ === 'scheduled_earning' || typ === 'earning' || typ === 'checkin')) return false;
                  if(!(st === 'accredited' || st === 'confirmed')) return false;
                  if(t.meta && String(t.meta.gpuId||'') === String(g.id)) return true;
                  // accept deterministic auto ids as well
                  if(String(t.id || '').indexOf(`tx_auto_${g.id}_`) === 0) return true;
                  return false;
                }catch(e){ return false; }
              }).length;
            }catch(e){ creditedCount = 0; }

            // compute daily earning estimate (Totale giornaliero)
            let daily = 0;
            try{
              if(g.meta && Number(g.meta.dailyEarnings)) daily = Number(g.meta.dailyEarnings);
              else if(g.meta && Number(g.meta.purchase_price) && Number(g.meta.purchase_price) > 0) daily = Number((Number(g.meta.purchase_price) * 0.011).toFixed(4));
              else if(Number(g.price_per_hour) && Number(g.price_per_hour) > 0) daily = Number(((Number(g.price_per_hour) * 24) * 0.011).toFixed(4));
              else {
                const t = Number((g.meta && g.meta.displayTflops) || 0);
                daily = t ? Number((t * 0.25).toFixed(4)) : 0;
              }
            }catch(e){ daily = 0; }

            const dailyDisplay = `$${Number(daily || 0).toFixed(4)}`;

            // compute purchase price: prefer meta.purchase_price, then 24*price_per_hour, then try to infer from transactions
            let purchasePrice = 0;
            try{
              if(g.meta && Number(g.meta.purchase_price) && Number(g.meta.purchase_price) > 0){
                purchasePrice = Number(g.meta.purchase_price);
              } else if(Number(g.price_per_hour) && Number(g.price_per_hour) > 0){
                purchasePrice = Number((Number(g.price_per_hour) * 24).toFixed(2));
              } else {
                // fallback: look for a purchase tx matching this gpu
                const ptx = (userTxs || []).find(t=>{
                  try{
                    return String(t.type||'').toLowerCase() === 'purchase' &&
                          ((t.meta && String(t.meta.gpuId||'') === String(g.id)) || (t.meta && String(t.meta.deviceName||'') === String(g.name)));
                  }catch(e){ return false; }
                });
                if(ptx && Number(ptx.amount)) purchasePrice = Number(ptx.amount);
              }
            }catch(e){ purchasePrice = 0; }

            // compute TFLOPS estimate for display (prefer meta.displayTflops)
            let tflops = 0;
            try{
              if(g.meta && Number(g.meta.displayTflops)) tflops = Number(g.meta.displayTflops);
              else {
                // heuristic mapping similar to other UI parts
                const priceNum = purchasePrice || (Number(g.price_per_hour) ? Number(g.price_per_hour) * 24 : 0);
                if(priceNum <= 0) tflops = 7.5;
                else if(priceNum < 200) tflops = Math.max(4, (priceNum / 40));
                else if(priceNum < 800) tflops = Math.max(10, (priceNum / 45));
                else tflops = Math.max(20, (priceNum / 55));
                tflops = Number(tflops.toFixed(2));
              }
            }catch(e){ tflops = 7.5; }

            // compute Totale generato: sum accredited/confirmed earnings linked to this GPU from user's transactions
            let totalGenerated = 0;
            try{
              totalGenerated = (userTxs || []).filter(t=>{
                try{
                  const typ = String(t.type||'').toLowerCase();
                  const st = String(t.status||'').toLowerCase();
                  if(!(typ === 'scheduled_earning' || typ === 'earning' || typ === 'checkin' || typ === 'claim' || typ === 'contract_dividend')) return false;
                  if(!(st === 'accredited' || st === 'confirmed')) return false;
                  if(t.meta && String(t.meta.gpuId||'') === String(g.id)) return true;
                  if(String(t.id || '').indexOf(`tx_auto_${g.id}_`) === 0) return true;
                  return false;
                }catch(e){ return false; }
              }).reduce((s,x)=> s + Number(x.amount||0), 0);
            }catch(e){ totalGenerated = 0; }

            return `<tr>
              <td>${esc(g.id)}</td>
              <td><a href="#" class="device-link" data-gpu="${esc(g.id)}">${esc(g.name || g.model || '')}</a></td>
              <td class="right">$${Number(purchasePrice || 0).toFixed(2)}</td>
              <td class="right">${esc(String(tflops))} TFLOPS</td>
              <td class="right">${dailyDisplay}</td>
              <td>${startDisplay}</td>
              <td class="right">${creditedCount}</td>
              <td class="right">$${Number(totalGenerated || 0).toFixed(8)}</td>
            </tr>`;
          }).join('');

          // Transactions table — improved readability: right-aligned amounts, type/status badges, monospace meta
          const txRows = (userTxs || []).map(t=>{
            const typ = esc(t.type || '').toUpperCase();
            const amtNum = Number(t.amount || 0) || 0;
            const amt = amtNum.toFixed(4);
            const statusRaw = String(t.status || '').toLowerCase();
            const status = esc(t.status || '');
            const created = esc(t.created_at || '');
            const txh = esc(t.txhash || t.id || '');
            const metaJson = JSON.stringify(t.meta || {});
            const meta = esc(metaJson);

            // small visual badge helpers (inline styles kept minimal to avoid new CSS)
            const typeBadge = `<span style="display:inline-block;padding:4px 8px;border-radius:8px;background:rgba(31,127,179,0.10);color:#0a7a45;font-weight:800;font-size:0.9rem">${typ}</span>`;
            // status color mapping
            const statusColor = (function(s){
              if(!s) return '#6b7280';
              if(s.includes('accredi') || s === 'accredited' || s === 'confirmed' || s === 'completed') return '#0a7a45';
              if(s.includes('pending') || s.includes('await')) return '#b98f46';
              if(s.includes('expired') || s.includes('failed') || s.includes('removed') || s.includes('rejected')) return '#b21c1c';
              return '#6b7280';
            })(statusRaw);
            const statusBadge = `<span style="display:inline-block;padding:4px 8px;border-radius:8px;background:rgba(0,0,0,0.04);color:${statusColor};font-weight:800;font-size:0.85rem">${status}</span>`;

            return `<tr>
              <td class="mono" style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${txh}</td>
              <td style="min-width:120px">${typeBadge}</td>
              <td class="right" style="font-weight:900;color:#b98f46">$${amt}</td>
              <td style="min-width:120px">${statusBadge}</td>
              <td style="min-width:150px">${created}</td>
              <td style="max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><code style="font-family:monospace;font-size:0.85rem;color:#042b36">${meta}</code></td>
            </tr>`;
          }).join('');

          // balances & earnings detail
          const withdrawableVal = Number((userEarnings[profileEmail] || 0)).toFixed(8);
          const persistentBalance = Number(((userRecord && Number(userRecord.balance)) || 0)).toFixed(8);
          const deposits = (userTxs || []).filter(x=> String(x.type||'').toLowerCase()==='deposit');
          const depositsTotal = deposits.reduce((s,x)=> s + Number(x.amount||0), 0).toFixed(8);
          const withdraws = (userTxs || []).filter(x=> String(x.type||'').toLowerCase().indexOf('withdraw')===0);
          const withdrawsTotal = withdraws.reduce((s,x)=> s + Number(x.amount||0), 0).toFixed(8);

          // per-device totals summary (for quick glance)
          const perDeviceSummaryRows = (userOwned || []).map(g=>{
            const produced = (userTxs || []).filter(t => t.meta && String(t.meta.gpuId||'') === String(g.id) && (String(t.status||'')==='accredited' || String(t.status||'')==='confirmed')).reduce((s,x)=> s + Number(x.amount||0), 0).toFixed(8);
            const purchases = (userTxs || []).filter(t => String(t.type||'').toLowerCase()==='purchase' && String(t.meta && t.meta.gpuId||'') === String(g.id)).reduce((s,x)=> s + Number(x.amount||0), 0).toFixed(8);
            return `<tr><td>${esc(g.id)}</td><td>${esc(g.name || '')}</td><td class="right">$${purchases}</td><td class="right">$${produced}</td></tr>`;
          }).join('');

          return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dettagli utente - ${esc(profileEmail)}</title><style>${style}</style></head><body>
            <div class="sheet">
              <div class="top">
                <div>
                  <h1>Dettagli utente: ${esc(profileEmail)}</h1>
                  <div class="small">Esportazione dati generata: ${new Date().toLocaleString()}</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                  <button onclick="window.close()" class="full-screen-close">Chiudi</button>
                  <button onclick="window.print()" class="full-screen-close">Stampa / Salva PDF</button>
                  <button onclick="(function(){ try{ const a=document.createElement('a'); const html=document.documentElement.outerHTML; const blob=new Blob([html],{type:'text/html'}); a.href=URL.createObjectURL(blob); const safeName='dettagli-${esc(profileEmail)}.html'; a.download=safeName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 500); }catch(e){ console.error('download html failed', e); alert('Download HTML non riuscito'); } })()" class="full-screen-close">Scarica HTML</button>
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
                <div class="section-title">Dispositivi acquistati (dettagli per singolo dispositivo)</div>
                <table>
                  <thead><tr><th>ID</th><th>Nome</th><th>Prezzo (EUR/USD)</th><th>TFLOPS</th><th>Guadagno giornaliero</th><th>Assegnato</th><th>Start</th><th>End</th><th class="right">Giorni ciclo</th><th class="right">N. accrediti</th><th class="right">Totale generato</th></tr></thead>
                  <tbody>${deviceRows || '<tr><td colspan="11">Nessun dispositivo</td></tr>'}</tbody>
                </table>
              </div>

              <div class="card">
                <div class="section-title">Totali per dispositivo</div>
                <table><thead><tr><th>GPU ID</th><th>Nome</th><th class="right">Prezzo acquistato</th><th class="right">Totale generato</th></tr></thead>
                <tbody>${perDeviceSummaryRows || '<tr><td colspan="4">Nessun dato</td></tr>'}</tbody></table>
              </div>

              <div class="card" style="flex:1;overflow:visible;max-height:none">
                <div class="section-title">Elenco transazioni (depositi / prelievi / guadagni / claim)</div>
                <table style="width:100%;font-size:0.85rem">
                  <thead><tr><th>TX ID / Hash</th><th>Tipo</th><th class="right">Importo</th><th>Stato</th><th>Data / Ora</th><th>Meta</th></tr></thead>
                  <tbody>${txRows || '<tr><td colspan="6">Nessuna transazione</td></tr>'}</tbody>
                </table>
              </div>

              <div class="card">
                <div class="section-title">Licenze attive</div>
                <table><thead><tr><th>ID</th><th>Licenza</th><th>Acquistata</th><th>Scadenza</th></tr></thead><tbody>
                ${(userLicenses || []).map(l=>`<tr><td>${esc(l.id||'')}</td><td>${esc(l.license||'')}</td><td>${esc(l.purchased_at||l.created_at||'')}</td><td>${esc(l.valid_until||'—')}</td></tr>`).join('') || '<tr><td colspan="4">Nessuna licenza</td></tr>'}
                </tbody></table>
              </div>

              <div class="card small">Esportazione generata per l'utente corrente; tutti i dati mostrati sono letti localmente dal browser e contengono solo voci appartenenti a questo account.</div>
            </div>

            <script>
              // Build a client-side index of the user's transactions so device-link clicks can open filtered views.
              (function(){
                try{
                  // USER_TXS is embedded here to make the exported page self-contained.
                  var USER_TXS = ${JSON.stringify(userTxs || [])};

                  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, function(c){ return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',\"'\":'&#39;'})[c]; }); }

                  function openDeviceEarnings(gpuId){
                    try{
                      if(!gpuId) return;
                      // Filter for scheduled_earning / earning transactions tied to this GPU and accredited/confirmed
                      var rows = USER_TXS.filter(function(t){
                        try{
                          var typ = (t.type || '').toLowerCase();
                          var st = (t.status || '').toLowerCase();
                          if(!(typ === 'scheduled_earning' || typ === 'earning' || typ === 'checkin')) return false;
                          if(!(st === 'accredited' || st === 'confirmed')) return false;
                          if(t.meta && String(t.meta.gpuId || '') === String(gpuId)) return true;
                          if(String(t.id || '').indexOf('tx_auto_' + gpuId + '_') === 0) return true;
                          return false;
                        }catch(e){ return false; }
                      });

                      var html = '<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Accrediti dispositivo ' + escapeHtml(gpuId) + '</title><style>body{font-family:Inter,Segoe UI,Roboto,Arial,Helvetica;padding:18px;background:#f7fafc;color:#022a30}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid rgba(2,12,18,0.06);vertical-align:top}th{background:#f0f6f9;font-weight:800}</style></head><body>';
                      html += '<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:12px\"><h2>Accrediti dispositivo: ' + escapeHtml(gpuId) + '</h2><div><button onclick=\"window.close()\" style=\"padding:8px 12px;border-radius:8px\">Chiudi</button></div></div>';
                      if(!rows.length){
                        html += '<div class=\"small\">Nessun accredito trovato per questo dispositivo.</div>';
                      } else {
                        html += '<table><thead><tr><th>TX ID / Hash</th><th>Tipo</th><th style=\"text-align:right\">Importo</th><th>Stato</th><th>Data / Ora</th><th>Meta</th></tr></thead><tbody>';
                        rows.forEach(function(t){
                          var meta = JSON.stringify(t.meta || {});
                          html += '<tr><td style=\"font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">' + escapeHtml(t.txhash || t.id || '') + '</td><td>' + escapeHtml(String(t.type || '').toUpperCase()) + '</td><td style=\"text-align:right;font-weight:900;color:#b98f46\">$' + Number(t.amount||0).toFixed(4) + '</td><td>' + escapeHtml(String(t.status||'')) + '</td><td>' + escapeHtml(t.created_at || '') + '</td><td><code style=\"font-family:monospace;font-size:0.85rem;color:#042b36\">' + escapeHtml(meta) + '</code></td></tr>';
                        });
                        html += '</tbody></table>';
                      }
                      html += '</body></html>';
                      var w = window.open('', '_blank', 'toolbar=yes,scrollbars=yes,resizable=yes');
                      if(!w) { alert('Popup bloccato: consenti popup per aprire la lista accrediti'); return; }
                      w.document.open();
                      w.document.write(html);
                      w.document.close();
                    }catch(e){
                      console.error('openDeviceEarnings error', e);
                      alert('Errore apertura lista accrediti dispositivo');
                    }
                  }

                  // Attach handlers on device-link anchors
                  document.querySelectorAll('.device-link').forEach(function(a){
                    try{
                      a.addEventListener('click', function(ev){
                        ev.preventDefault();
                        var gpu = a.getAttribute('data-gpu') || a.dataset.gpu;
                        if(gpu) openDeviceEarnings(gpu);
                      });
                    }catch(e){}
                  });
                }catch(e){
                  console.error('device-link script failed', e);
                }
              })();
            </script>
          </body></html>`;
        }

        // open a new tab/window and write the detailed HTML
        const wnd = window.open('', '_blank', 'toolbar=yes,scrollbars=yes,resizable=yes');
        if(!wnd){
          toastMessage('Popup bloccato: consenti popup per aprire la pagina dettagliata', { type:'error' });
          return;
        }
        wnd.document.open();
        wnd.document.write(buildDetailsHtml());
        wnd.document.close();
      }catch(e){
        console.error('Dettagli button error', e);
        toastMessage('Errore apertura pagina dettagli', { type:'error' });
      }
    };
    infoCard.appendChild(detailsBtn);
  }catch(e){
    console.error('failed to append Aggiorna JSON button', e);
  }

  // Settings riquadro below with clear separation and its own padding
  const settingsCard = document.createElement('div');
  settingsCard.className = 'card';
  settingsCard.style.marginTop = '8px';
  settingsCard.style.padding = '12px';
  settingsCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-weight:900">Impostazioni account</div>
      <div class="small" style="color:var(--muted)">Gestisci sicurezza e wallet</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;gap:8px">
        <button id="btn-change-pass" class="btn secondary" style="flex:1">Cambia Password</button>
        <button id="btn-blind-wallet" class="btn ghost" style="flex:1">Blindaggio Wallet</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button id="btn-history" class="btn" style="flex:1">Storico Depositi/Prelievi</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button id="btn-export-data" class="btn secondary" style="flex:1">Aggiorna e Scarica JSON</button>
      </div>
      <div class="small" style="color:var(--muted)">Nota: il blindaggio memorizza l'indirizzo per i prelievi.</div>
    </div>
  `;
  container.appendChild(settingsCard);

  // Convert GPU points to withdrawable dollars: 1000 pts = $1, minimum 1000 pts.
  // The handler reads points from CUP9_TASK_POINTS_<email>, converts whole multiples of 1000,
  // deducts points, credits CUP9_EARNINGS (withdrawable), appends a transaction and notifies UI.
  (function wireConvertPoints(){
    try{
      // small delay to ensure DOM nodes appended
      setTimeout(()=> {
        try{
          const btn = settingsCard.querySelector('#btn-convert-points');
          if(!btn){
            // create and insert the button near export/import controls if not present
            const controls = settingsCard.querySelector('div[style*="display:flex;gap:8px"]');
            const cbtn = document.createElement('button');
            cbtn.id = 'btn-convert-points';
            cbtn.className = 'btn';
            cbtn.textContent = 'Converti Punti GPU';
            cbtn.title = 'Converti i tuoi punti GPU in $ (1000 pts = $1), minimo 1000 pts';
            // append to settings card controls area if exists, otherwise to settingsCard
            if(controls) controls.appendChild(cbtn);
            else settingsCard.appendChild(cbtn);
          }
          const convertBtn = settingsCard.querySelector('#btn-convert-points');
          if(!convertBtn) return;

          convertBtn.addEventListener('click', async function(){
            try{
              // determine current authenticated email (robust)
              let profileEmail = '';
              try{
                const me = await auth.me().catch(()=>null);
                profileEmail = me && me.user && me.user.email ? String(me.user.email).toLowerCase() : '';
              }catch(e){ profileEmail = (user && user.email) ? String(user.email).toLowerCase() : ''; }

              if(!profileEmail){
                toastMessage('Devi essere autenticato per convertire i punti', { type:'error' });
                return;
              }

              const pointsKey = `CUP9_TASK_POINTS_${profileEmail}`;
              let pts = Number(localStorage.getItem(pointsKey) || 0);
              if(!pts || pts < 1000){
                toastMessage('Hai meno di 1000 punti: minimo convertibile 1000 punti', { type:'info' });
                return;
              }

              // compute how many full conversion units
              const units = Math.floor(pts / 1000);
              if(units <= 0){
                toastMessage('Nessuna unità convertibile (multipli di 1000 punti).', { type:'info' });
                return;
              }
              const dollars = Number(units * 1); // 1000 pts = $1

              // Ask confirmation with concise summary
              const ok = window.confirm(`Convertire ${units * 1000} punti GPU → $${dollars.toFixed(2)} e accreditare immediatamente ai guadagni prelevabili?`);
              if(!ok) return;

              // Durable update: deduct points (idempotent) and credit CUP9_EARNINGS
              try{
                // Deduct points
                const newPts = Math.max(0, pts - units * 1000);
                localStorage.setItem(pointsKey, String(newPts));

                // Credit withdrawable earnings map
                const EARN_KEY = 'CUP9_EARNINGS';
                let earnings = {};
                try{ earnings = JSON.parse(localStorage.getItem(EARN_KEY) || '{}') || {}; }catch(e){ earnings = {}; }
                const em = String(profileEmail).toLowerCase();
                earnings[em] = Number((Number(earnings[em] || 0) + Number(dollars)).toFixed(8));
                localStorage.setItem(EARN_KEY, JSON.stringify(earnings));

                // Append a transaction to CUP9_TRANSACTIONS (accredited earning) idempotently
                const TX_KEY = 'CUP9_TRANSACTIONS';
                let txs = [];
                try{ txs = JSON.parse(localStorage.getItem(TX_KEY) || '[]') || []; }catch(e){ txs = []; }
                const txId = 'tx_pts_conv_' + Math.random().toString(36).slice(2,10);
                const tx = {
                  id: txId,
                  type: 'points_conversion',
                  amount: Number(dollars),
                  txhash: 'ptsconv-' + txId,
                  created_at: new Date().toISOString(),
                  status: 'accredited',
                  email: em,
                  meta: { from_points: true, points_deducted: units * 1000, units: units }
                };
                txs.push(tx);
                localStorage.setItem(TX_KEY, JSON.stringify(txs));

                // Mirror to mock api DB where available (best-effort)
                try{
                  if(window.api && api && api.__internal__ && api.__internal__.db){
                    const db = api.__internal__.db;
                    db.transactions = db.transactions || {};
                    db.transactions[tx.id] = { id: tx.id, type: tx.type, amount: tx.amount, txhash: tx.txhash, created_at: tx.created_at, status: tx.status, email: tx.email, meta: tx.meta || {} };
                    db.earnings = db.earnings || {};
                    db.earnings[em] = Number((db.earnings[em] || 0) + Number(dollars));
                  }
                }catch(e){ /* non-fatal */ }

                // Notify UI channels so balances and lists refresh
                try{ notify('tasks:points:changed', { email: em, points: Number(newPts) }); }catch(e){}
                try{ notify('balance:withdrawable:changed', { email: em, withdrawable: earnings[em] }); }catch(e){}
                try{ notify('tx:changed', txs); }catch(e){}
                toastMessage(`Convertiti ${units * 1000} punti → $${dollars.toFixed(2)} accreditati ai guadagni prelevabili`, { type:'success' });
              }catch(e){
                console.error('convert points apply error', e);
                toastMessage('Errore convertendo i punti', { type:'error' });
              }
            }catch(err){
              console.error('convert points handler error', err);
              toastMessage('Errore durante la conversione', { type:'error' });
            }
          });
        }catch(e){}
      }, 120);
    }catch(e){
      console.error('wireConvertPoints init failed', e);
    }
  })();

  // Wire handlers (same behavior as prior implementation) plus new history button
  const changeBtn = settingsCard.querySelector('#btn-change-pass');

  // Support card: "Supporto H24" shown under settings (keeps assistance separate)
  const supportCard = document.createElement('div');
  supportCard.className = 'card';
  supportCard.style.marginTop = '8px';
  supportCard.style.padding = '12px';
  supportCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div style="font-weight:900">Supporto H24</div>
      <div class="small" style="color:var(--muted)">Assistenza continua</div>
    </div>
    <div class="small" style="color:var(--muted);margin-bottom:10px">Hai bisogno di aiuto? Contatta il supporto tecnico o il bot Telegram.</div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="btn-support" class="btn">Apri Supporto</button>
    </div>
  `;
  container.appendChild(supportCard);

  // Official site card: separate from support to keep actions distinct
  const officialCard = document.createElement('div');
  officialCard.className = 'card';
  officialCard.style.marginTop = '8px';
  officialCard.style.padding = '12px';
  officialCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div style="font-weight:900">Sito ufficiale</div>
      <div class="small" style="color:var(--muted)">Visita il sito</div>
    </div>
    <div class="small" style="color:var(--muted);margin-bottom:10px">Vai al sito ufficiale per informazioni aggiuntive e annunci.</div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="btn-official-site" class="btn secondary">Apri sito ufficiale</button>
    </div>
  `;
  container.appendChild(officialCard);

  // Add "GUIDA PRATICA" quick button in the profile (opens full-screen instructions page)
  try{
    const guidaBtn = document.createElement('button');
    guidaBtn.className = 'btn';
    guidaBtn.textContent = 'GUIDA PRATICA';
    guidaBtn.style.marginTop = '8px';
    guidaBtn.title = 'Apri la Guida Pratica completa della piattaforma (full-screen)';
    guidaBtn.onclick = () => {
      try{
        // Build full-screen HTML with clear, precise, step-by-step instructions.
        const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GUIDA PRATICA — CUP9GPU</title>
<style>
  body{font-family:Inter,Segoe UI,Roboto,Arial; margin:0;background:#f7fafc;color:#042b36}
  .sheet{padding:18px;max-width:1100px;margin:0 auto}
  h1{margin:0 0 12px 0;font-size:1.4rem;color:#0a7a45}
  h2{margin:12px 0 8px 0;font-size:1rem;color:#03181d}
  p{margin:6px 0;color:#31545a}
  pre{background:#fff;border:1px solid rgba(0,0,0,0.06);padding:12px;border-radius:8px;overflow:auto}
  .section{background:#ffffff;padding:14px;border-radius:10px;margin-bottom:12px;box-shadow:0 8px 24px rgba(0,0,0,0.04)}
  .note{font-size:0.9rem;color:#7b8c8f}
  .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
  .btn{padding:10px 12px;border-radius:8px;border:0;background:#0f78c1;color:#fff;font-weight:800;cursor:pointer}
  .btn.secondary{background:#e6f0f6;color:#042b36}
</style>
</head>
<body>
  <div class="sheet">
    <h1>GUIDA PRATICA — CUP9GPU</h1>
    <p class="note">Istruzioni chiare, passo‑passo per ogni operazione sulla piattaforma: deposito, prelievo, acquisto dispositivi, gestione licenze, Task, Boost e gestione dispositivi.</p>

    <div class="section" id="deposit">
      <h2>Come eseguire un Deposito</h2>
      <ol>
        <li>Vai in Home e premi "+ Deposito".</li>
        <li>Inserisci l'importo (es. 100.00) e scegli la rete (USDT TRC/BTC/BNB o USDC).</li>
        <li>Premi "Genera Indirizzo" per ottenere l'indirizzo di deposito della rete scelta (copia con il pulsante).</li>
        <li>Esegui il trasferimento dalla tua piattaforma/wallet verso l'indirizzo generato.</li>
        <li>Dopo l'invio, torna e clicca "Ho effettuato il deposito", fornisci TXHash e (opzionale) la foto della prova pagamento.</li>
        <li>La transazione verrà inviata al supporto per verifica; quando l'OTP fornito dal supporto viene inserito la transazione diventa "accredited" e il tuo saldo deposito viene aggiornato.</li>
      </ol>
      <p class="note">Consigli: salva il TXHash e la prova; evita copy/paste errati controllando sempre i primi/ultimi caratteri dell'indirizzo.</p>
    </div>

    <div class="section" id="withdraw">
      <h2>Come richiedere un Prelievo</h2>
      <ol>
        <li>Prima di tutto: il wallet di prelievo deve essere <strong>blindato</strong> nel Profilo → Blindaggio Wallet.</li>
        <li>Vai in Home e premi "− Prelievo". Inserisci l'importo.</li>
        <li>La piattaforma verifica il saldo prelevabile (CUP9_EARNINGS). Se hai anche saldo deposito spendibile (es. Rolex) verrà usato per coprire eventuale differenza.</li>
        <li>Conferma: la richiesta viene inviata a Supporto con lo stato <em>awaiting_otp</em> e i fondi vengono temporaneamente riservati.</li>
        <li>Supporto ti fornirà un OTP: inseriscilo nella richiesta (pulsante "Inserisci OTP"). Alla corretta verifica la richiesta viene confermata ed eseguita.</li>
        <li>Se l'OTP non viene fornito entro il timeout configurato la richiesta può essere ripristinata o riaccreditata dal supporto/amministratore; vedi storico transazioni.</li>
      </ol>
      <p class="note">Nota: alcune licenze rimuovono restrizioni temporali sui prelievi; controlla la tua Licenza nel Profilo.</p>
    </div>

    <div class="section" id="buy-hardware">
      <h2>Come acquistare un dispositivo</h2>
      <ol>
        <li>Vai su Hardware o Dispositivi Plus e scegli il dispositivo.</li>
        <li>Premi "Acquista" => scegli il ciclo (1/3/7 giorni) quando richiesto.</li>
        <li>Il costo viene addebitato dal tuo saldo depositi spendibile (CUP9_USERS.balance e log delle transazioni).</li>
        <li>Alla conferma viene creato un record di acquisto e il dispositivo sarà visibile in "I miei GPU".</li>
        <li>Il dispositivo può avere un ciclo automatico di accrual; al termine del ciclo premi <strong>Claim</strong> per riscattare i guadagni (se richiesto).</li>
      </ol>
      <p class="note">Suggerimento: ogni acquisto idempotente genera un record tx e un owned GPU; non riacquistare lo stesso device se non necessario.</p>
    </div>

    <div class="section" id="mydevices">
      <h2>Gestione "I miei GPU"</h2>
      <ul>
        <li>La pagina mostra i dispositivi acquistati/assegnati, TFLOPS stimati, guadagno giornaliero stimato e progressi di ciclo.</li>
        <li>I cicli possono essere avviati (Seleziona ciclo), e il sistema accredita un earning giornaliero auto (tx_auto_{gpuId}_{YYYY-MM-DD}) per ogni giorno.</li>
        <li>Al completamento del ciclo premi "Claim" per ricevere i guadagni accreditati al saldo prelevabile.</li>
        <li>Le UI sono idempotenti: le operazioni già eseguite non vengono applicate due volte grazie a lock/persistenza in localStorage.</li>
      </ul>
    </div>

    <div class="section" id="tasks-boost">
      <h2>Tasks giornalieri e Boost</h2>
      <p>Tasks: Quiz, Check-in avanzato e Controllo attività — completando ottieni piccoli accrediti e Punti GPU.</p>
      <ol>
        <li>Quiz: rispondi correttamente per ricevere $0.05 (una volta al giorno).</li>
        <li>Check-in avanzato: +5 punti GPU al giorno.</li>
        <li>Controllo attività: visita "I miei GPU" e premi il controllo per $0.05.</li>
      </ol>
      <p><strong>Boost:</strong> usa punti GPU per potenziare un dispositivo; per usare il tasto Boost è richiesta una licenza attiva (Base o Plus).</p>
      <p class="note">Il testo del pulsante Boost è: "Usa punti GPU per applicare un Boost a un dispositivo ( richiede licenza base o plus)".</p>
    </div>

    <div class="section" id="licenses-invites">
      <h2>Licenze e Codici Invito</h2>
      <p>Le licenze (Base/Plus) abilitano funzionalità (referral, badge, accesso prioritario). All'acquisto viene generato un codice invito che puoi assegnare a una email.</p>
      <ol>
        <li>Acquista Licenza → la licenza è salvata in CUP9_LICENSES e il ruolo utente viene aggiornato.</li>
        <li>Genera Codici Invito → sono persistenti in CUP9_INVITES; associano email invitate e possono essere tracciati quando vengono usate.</li>
      </ol>
    </div>

    <div class="section" id="export-import">
      <h2>Esporta / Importa dati</h2>
      <p>Profilo → "Aggiorna JSON" permette di scaricare un export delle tue voci: utenti, transazioni, dispositivi, licenze, earnings.</p>
      <p>Import: è protetto — per importare un JSON devi verificare la tua email e (se richiesto) inserire un OTP fornito dall'assistenza.</p>
    </div>

    <div class="section" id="support">
      <h2>Supporto</h2>
      <p>Per assistenza contatta: info.cup9@yahoo.com o il Bot Telegram indicato in Profilo; il supporto può generare/fornire OTP per verifiche sensibili.</p>
      <p class="note">Non condividere mai il tuo PIN o password nel canale pubblico; l'OTP "info.cup9@yahoo.com" è un valore proibito e non sarà mai accettato come codice reale.</p>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:8px" class="actions">
      <button class="btn secondary" onclick="window.close()">Chiudi</button>
      <button class="btn" onclick="(function(){ try{ const blob=new Blob([document.documentElement.outerHTML],{type:'text/html'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='guida_pratica_cup9gpu.html'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){alert('Download non riuscito');}})()">Scarica Guida</button>
    </div>
  </div>
</body>
</html>`;
        // open full-screen (new tab/window)
        const w = window.open('', '_blank', 'toolbar=yes,scrollbars=yes,resizable=yes');
        if(!w){ alert('Popup bloccato: consenti popup per aprire la Guida Pratica'); return; }
        w.document.open();
        w.document.write(html);
        w.document.close();
      }catch(e){
        console.error('Apri Guida Pratica failed', e);
        try{ toastMessage('Impossibile aprire la Guida Pratica', { type:'error' }); }catch(e){}
      }
    };
    // append into the profile container near official card for visibility
    try{ officialCard.appendChild(guidaBtn); }catch(e){}
  }catch(e){
    console.error('GUIDA PRATICA button setup failed', e);
  }

  // New: Active licenses card — shows user's active licenses with purchase date, expiry and number of generated invites
  const licensesCard = document.createElement('div');
  licensesCard.className = 'card';
  licensesCard.style.marginTop = '8px';
  licensesCard.style.padding = '12px';
  licensesCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-weight:900">Licenze attive</div>
      <div class="small" style="color:var(--muted)">Visualizza licenze acquistate</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;justify-content:space-between">
      <div class="small" style="color:var(--muted)">Premi per caricare le licenze attive</div>
      <button id="show-active-licenses" class="btn" style="min-width:160px">Mostra licenze attive</button>
    </div>
    <div id="active-licenses-list" class="small" style="color:var(--muted);margin-top:10px;display:none"></div>
  `;
  container.appendChild(licensesCard);

  // render active licenses for current user only when the user clicks the button
  async function renderActiveLicenses(){
    const listEl = licensesCard.querySelector('#active-licenses-list');
    listEl.style.display = '';
    listEl.innerHTML = 'Caricamento licenze…';
    // get current authenticated user email from auth.me() if possible (best-effort non-blocking)
    let currentEmail = null;
    let currentId = null;
    try{
      const me = await auth.me();
      currentEmail = (me && me.user && me.user.email) ? String(me.user.email).toLowerCase() : null;
      currentId = (me && me.user && me.user.id) ? String(me.user.id).toLowerCase() : null;
    }catch(e){
      currentEmail = null;
      currentId = null;
    }
    try{
      const rawLic = localStorage.getItem('CUP9_LICENSES') || '[]';
      const licenses = JSON.parse(rawLic);
      const invitesRaw = localStorage.getItem('CUP9_INVITES') || '[]';
      const invites = JSON.parse(invitesRaw);

      // Filter to current user if we have an email or id, otherwise show none
      const relevant = licenses.filter(l => {
        if(!currentEmail && !currentId) return false;
        const ownerEmail = String(l.ownerEmail || '').toLowerCase();
        const ownerId = String(l.ownerId || '').toLowerCase();
        const validUntil = l.valid_until ? new Date(l.valid_until) : null;
        const now = new Date();
        const ownerMatch = (ownerEmail && currentEmail && ownerEmail === currentEmail) || (ownerId && currentId && ownerId === currentId);
        const notExpired = !validUntil || (validUntil && validUntil > now);
        return ownerMatch && notExpired;
      });

      if(!relevant.length){
        listEl.innerHTML = `<div class="notice small">Nessuna licenza attiva</div>`;
        return;
      }

      // Build rows with counts of invites generated by that owner
      const rows = relevant.map(l=>{
        const created = l.purchased_at ? (new Date(l.purchased_at)).toLocaleString() : (l.created_at ? (new Date(l.created_at)).toLocaleString() : '—');
        const until = l.valid_until ? (new Date(l.valid_until)).toLocaleString() : '—';
        const inviteCount = invites.filter(i => String(i.ownerEmail||'').toLowerCase() === String(l.ownerEmail||'').toLowerCase() && i.created_at && new Date(i.created_at) >= new Date(l.purchased_at || l.created_at || 0)).length;
        return `
          <div style="padding:8px;border-bottom:1px solid rgba(255,255,255,0.03);display:flex;justify-content:space-between;gap:12px;align-items:center">
            <div style="flex:1">
              <div style="font-weight:800">${escapeHtml(String(l.license || 'licenza'))}</div>
              <div class="small" style="color:var(--muted)">${escapeHtml(String(l.id || ''))}</div>
            </div>
            <div style="text-align:right;min-width:220px">
              <div class="small" style="color:var(--muted)">Acquistata: <strong style="color:#03181d">${escapeHtml(created)}</strong></div>
              <div class="small" style="color:var(--muted);margin-top:6px">Scadenza: <strong style="color:#03181d">${escapeHtml(until)}</strong></div>
              <div class="small" style="color:var(--muted);margin-top:6px">Codici generati: <strong style="color:#0a7a45">${inviteCount}</strong></div>
            </div>
          </div>
        `;
      }).join('');
      listEl.innerHTML = rows;
    }catch(e){
      console.error('renderActiveLicenses error', e);
      listEl.innerHTML = `<div class="notice small">Errore caricamento licenze</div>`;
    }
  }

  // Wire the show button: load once on first click, then toggle visibility on subsequent clicks
  const showBtn = licensesCard.querySelector('#show-active-licenses');
  const listEl = licensesCard.querySelector('#active-licenses-list');
  let loaded = false;
  showBtn.onclick = async () => {
    try{
      if(!loaded){
        await renderActiveLicenses();
        loaded = true;
        showBtn.textContent = 'Nascondi licenze attive';
      } else {
        // toggle visibility
        const isVisible = listEl.style.display !== 'none';
        listEl.style.display = isVisible ? 'none' : '';
        showBtn.textContent = isVisible ? 'Mostra licenze attive' : 'Nascondi licenze attive';
      }
    }catch(e){
      console.error('show active licenses click error', e);
    }
  };

  // Support button handler: show banner/modal with contact links
  supportCard.querySelector('#btn-support').onclick = () => {
    const html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong>Supporto H24</strong>
        <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
      </div>
      <div class="small" style="margin-bottom:8px">Contatti tecnici disponibili 24/7:</div>
      <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
        Email: <a href="mailto:info.cup9@yahoo.com">info.cup9@yahoo.com</a><br/>
        Bot Telegram: <a href="https://t.me/Infocup9_yahoobot" target="_blank" rel="noopener">https://t.me/Infocup9_yahoobot</a>
      </div>
      <div class="small" style="color:var(--muted)">Clicca i link per contattare il supporto o aprire il bot Telegram.</div>
    `;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:100%;max-width:520px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:16px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
    panel.innerHTML = html;
    modal.appendChild(panel);
    document.body.appendChild(modal);
    // wire close
    panel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> modal.remove());
    // ensure links open safely
    const mail = panel.querySelector('a[href^="mailto:"]');
    if(mail) mail.onclick = ()=> { /* default mailto behavior */ };
    const tg = panel.querySelector('a[href^="https://t.me"]');
    if(tg) tg.onclick = (ev)=> { ev.stopPropagation(); /* let default open in new tab */ };
  };

  // Official site button: open the requested URL in a new tab (separate card)
  officialCard.querySelector('#btn-official-site').onclick = () => {
    try{
      window.open('https://siteinfogpu.on.websim.com/', '_blank', 'noopener');
    }catch(e){
      // fallback to direct navigation if popup blocked
      window.location.href = 'https://siteinfogpu.on.websim.com/';
    }
  };
  const blindBtn = settingsCard.querySelector('#btn-blind-wallet');
  const historyBtn = settingsCard.querySelector('#btn-history');

  // Export / Import user data buttons (Scarica dati / Carica dati)
  try{
    const exportBtn = settingsCard.querySelector('#btn-export-data');
    const importBtn = settingsCard.querySelector('#btn-import-data');

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

    exportBtn && (exportBtn.onclick = async () => {
      try{
        // Merge missing state from mock/local sources to ensure export completeness (non-destructive)
        try{ await mergeMissingDataBeforeExport(); }catch(e){ console.warn('pre-export merge failed', e); }
        // Ensure UI data is refreshed so export picks up the latest state
        try{ notify('ui:force-refresh'); }catch(e){}
        // small delay to allow subscribers to update persistent stores before exporting
        await new Promise(res => setTimeout(res, 400));

        const me = await auth.me();
        const email = (me && me.user && me.user.email) ? String(me.user.email).toLowerCase() : null;
        const userId = (me && me.user && me.user.id) ? String(me.user.id) : null;
        if(!email) return toastMessage('Devi essere autenticato per esportare i dati');

        // Helper: read and filter JSON entries so only records belonging to this user are exported
        function readRaw(key){
          try{ return localStorage.getItem(key); }catch(e){ return null; }
        }
        function filterJsonForUser(raw, key){
          if(!raw) return null;
          try{
            // Earnings is an object keyed by email
            if(key === 'CUP9_EARNINGS'){
              const obj = JSON.parse(raw || '{}') || {};
              const reduced = {};
              if(obj[String(email)]) reduced[String(email)] = obj[String(email)];
              return JSON.stringify(reduced);
            }
            // For arrays, attempt to parse and filter by common owner fields
            const arr = JSON.parse(raw || '[]');
            if(!Array.isArray(arr)) return raw;
            const filtered = arr.filter(item => {
              try{
                if(!item) return false;
                // normalize fields
                const itemEmail = (item.email || item.ownerEmail || item.owner_email || item.owner || '').toString().toLowerCase();
                if(itemEmail && itemEmail === email) return true;
                // match by ownerId if present
                const itemOwnerId = (item.ownerId || item.owner_id || item.userId || item.user_id || item.userId || '').toString();
                if(itemOwnerId && userId && itemOwnerId === userId) return true;
                // some records store nested meta with owner email
                if(item.meta && (item.meta.ownerEmail || item.meta.owner_email)){
                  const me = String(item.meta.ownerEmail || item.meta.owner_email || '').toLowerCase();
                  if(me && me === email) return true;
                }
                // transactions commonly use email field; keep only those matching
                return false;
              }catch(e){ return false; }
            });
            return JSON.stringify(filtered);
          }catch(e){
            return raw;
          }
        }

        const payload = { exported_at: new Date().toISOString(), owner: email, data: {} };
        for(const k of USER_KEYS){
          try{
            const raw = readRaw(k);
            payload.data[k] = filterJsonForUser(raw, k);
          }catch(e){
            payload.data[k] = null;
          }
        }
        try{ payload.meta = { deviceId: localStorage.getItem('cup9:deviceId') || null }; }catch(e){}
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safeEmail = email.replace(/[^a-z0-9_.+-@]/gi, '_');
        a.href = url;
        a.download = `cup9-data-${safeEmail}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toastMessage('File dati pronto per il download', { type:'success' });
      }catch(e){
        console.error('export error', e);
        toastMessage('Errore esportazione dati');
      }
    });

    importBtn && (importBtn.onclick = async () => {
      try{
        const me = await auth.me();
        const email = (me && me.user && me.user.email) ? String(me.user.email).toLowerCase() : null;
        if(!email) return toastMessage('Devi essere autenticato per importare i dati');

        // Require OTP verification before allowing file selection/import
        const otp = window.prompt('Inserisci il codice OTP ricevuto da supporto per autorizzare il caricamento del JSON:', '');
        if(otp === null) return; // user cancelled
        try{
          // verifyInviteOtp will clear pending state when correct; reuse for OTP verification
          await auth.verifyInviteOtp(email, otp);
        }catch(verr){
          // If verification fails show message and abort import
          toastMessage(verr && verr.message ? String(verr.message) : 'Verifica OTP fallita', { type:'error' });
          return;
        }

        // proceed with file chooser only after successful OTP verification
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = async () => {
          try{
            const f = input.files && input.files[0];
            if(!f) { toastMessage('Nessun file selezionato'); input.remove(); return; }
            const txt = await new Promise((res, rej) => {
              const r = new FileReader();
              r.onload = ()=> res(r.result);
              r.onerror = ()=> rej(new Error('File read error'));
              r.readAsText(f);
            });
            let parsed = null;
            try{ parsed = JSON.parse(txt); }catch(e){ toastMessage('File JSON non valido'); input.remove(); return; }
            const owner = parsed && parsed.owner ? String(parsed.owner).toLowerCase() : null;
            if(!owner || owner !== email){
              toastMessage('Il file non appartiene a questo account (verifica email).', { type:'error' });
              input.remove();
              return;
            }
            const data = parsed.data || {};
            let applied = 0;
            for(const k of USER_KEYS){
              try{
                if(typeof data[k] !== 'undefined' && data[k] !== null){
                  localStorage.setItem(k, data[k]);
                  applied++;
                }
              }catch(e){ console.error('apply key', k, e); }
            }
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
        toastMessage('Errore apertura file chooser');
      }
    });
  }catch(e){
    console.error('export/import bind error', e);
  }

  changeBtn.onclick = async () => {
    try{
      // Prompt for current password first and verify it before asking for the new password
      const oldp = window.prompt('Inserisci la password attuale:');
      if(oldp === null) return; // cancelled

      try{
        await auth.verifyPassword(oldp);
      }catch(verr){
        toastMessage(verr && verr.message ? verr.message : 'Password attuale non corretta');
        return;
      }

      const newp = window.prompt('Inserisci la nuova password:');
      if(newp === null) return;
      if(!newp || newp.length < 4){ toastMessage('Nuova password troppo corta'); return; }

      // At this point the current password was verified; apply the change
      await auth.changePassword(oldp, newp);
      toastMessage('Password aggiornata correttamente');
    }catch(e){
      toastMessage(e && e.message ? e.message : 'Errore aggiornamento password');
    }
  };

  blindBtn.onclick = async () => {
    try{
      // Load current session/user to detect existing blind
      const me = await auth.me();
      const profileEmail = (me && me.user && me.user.email) || '';
      // Find local persisted user record (CUP9_USERS) to surface blind info immediately
      let users = [];
      try{ users = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]'); }catch(e){ users = []; }
      const localUserIdx = users.findIndex(u=>String(u.email||'').toLowerCase() === String(profileEmail||'').toLowerCase());
      const localUser2 = localUserIdx !== -1 ? users[localUserIdx] : null;
      const isBlind = !!(localUser2 && localUser2.blind);
      const blindWallet = localUser2 && localUser2.blind_wallet ? String(localUser2.blind_wallet) : '';

      // If already blind, show modal with wallet and options to unblind or change it
      if(isBlind){
        const modalHtml = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <strong>Wallet blindato</strong>
            <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
          </div>
          <div class="small">Email: ${escapeHtml(profileEmail)}</div>
          <div style="margin-top:10px;padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">${escapeHtml(blindWallet || '—')}</div>
          <div class="small" style="color:var(--muted);margin-bottom:10px">Puoi rimuovere il blind o aggiornarne l'indirizzo.</div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="unblind" class="btn secondary">Rimuovi Blind</button>
            <button id="change-blind" class="btn">Cambia Indirizzo</button>
          </div>
        `;
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
        const panel = document.createElement('div');
        panel.style.cssText = 'width:100%;max-width:520px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:16px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
        panel.innerHTML = modalHtml;
        modal.appendChild(panel);
        document.body.appendChild(modal);
        panel.querySelector('.modal-close').onclick = ()=> modal.remove();

        // Unblind handler: create persistent OTP and require OTP verification (allows deferred entry)
        panel.querySelector('#unblind').onclick = async () => {
          try{
            // Generate or pick manual OTP (respecting forbidden special value)
            // Do NOT use any hardcoded universal test OTP such as '54321' — treat only explicit configured OTPs as valid.
            let otp = null;
            try{
              const explicit = window.CUP9_MANUAL_OTP || localStorage.getItem('CUP9_MANUAL_OTP_SHARED') || null;
              if(explicit && String(explicit) !== FORBIDDEN_SUPPORT_EMAIL){
                otp = String(explicit);
              } else {
                otp = null;
              }
            }catch(e){
              otp = null;
            }

            // Persist OTP for this unblind action so user can enter it later if they close the modal
            try{
              const key = 'CUP9_BLIND_OTP_' + String(profileEmail || '').toLowerCase();
              localStorage.setItem(key, String(otp));
              // Mirror into mock backend otpStore for cross-device visibility if available
              try{ if(api && api.__internal__ && api.__internal__.db){ api.__internal__.db.otpStore = api.__internal__.db.otpStore || {}; api.__internal__.db.otpStore['blind_' + key] = String(otp); } }catch(e){}
            }catch(e){ console.error('persist blind otp', e); }

            // Notify user that OTP was created and instruct to enter it (offer immediate entry)
            const supportHtml = `
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <strong>Rimozione Blind — Verifica OTP</strong>
                <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
              </div>
              <div class="small" style="margin-bottom:8px">È stato generato un codice OTP per la rimozione del blind; puoi procedere subito con l'inserimento oppure farlo in un secondo momento usando la funzionalità "Inserisci OTP".</div>
              <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
                Email: ${escapeHtml(profileEmail)}
              </div>
              <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                <button id="proceed-otp" class="btn">Procedi inserimento OTP</button>
                <button id="close-otp" class="btn secondary">Chiudi</button>
              </div>
            `;
            const otpModal = document.createElement('div');
            otpModal.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
            const otpPanel = document.createElement('div');
            otpPanel.style.cssText = 'width:100%;max-width:520px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:16px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
            otpPanel.innerHTML = supportHtml;
            otpModal.appendChild(otpPanel);
            document.body.appendChild(otpModal);

            otpPanel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> otpModal.remove());
            otpPanel.querySelector('#close-otp').onclick = ()=> otpModal.remove();

            otpPanel.querySelector('#proceed-otp').onclick = () => {
              try{ otpModal.remove(); }catch(e){}
              // Always show Support banner first before OTP entry (assistance must be visible)
              const supportHtml2 = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                  <strong>Supporto H24 — prima di inserire OTP</strong>
                  <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
                </div>
                <div class="small" style="margin-bottom:8px">Per rimozione blind contatta l'assistenza. Dopo aver parlato con l'operatore, procedi all'inserimento OTP.</div>
                <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
                  Email: <a href="mailto:info.cup9@yahoo.com">info.cup9@yahoo.com</a><br/>
                  Bot Telegram: <a href="https://t.me/Infocup9_yahoobot" target="_blank" rel="noopener">https://t.me/Infocup9_yahoobot</a>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                  <button id="support-proceed-otp" class="btn">Procedi inserimento OTP</button>
                </div>
              `;
              const supportModal = document.createElement('div');
              supportModal.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
              const supportPanel = document.createElement('div');
              supportPanel.style.cssText = 'width:100%;max-width:520px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:16px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
              supportPanel.innerHTML = supportHtml2;
              supportModal.appendChild(supportPanel);
              document.body.appendChild(supportModal);
              supportPanel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> supportModal.remove());
              // proceed opens the OTP entry modal
              supportPanel.querySelector('#support-proceed-otp').onclick = () => {
                try{ supportModal.remove(); }catch(e){}
                // Open OTP entry modal
                const modalOtp = document.createElement('div');
                modalOtp.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
                const panelOtp = document.createElement('div');
                panelOtp.style.cssText = 'width:100%;max-width:520px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:16px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
                panelOtp.innerHTML = `
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                    <strong>Inserisci OTP per rimozione Blind</strong>
                    <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
                  </div>
                  <div class="form-row">
                    <input id="blind-otp-input" class="input" placeholder="Codice OTP" />
                  </div>
                  <div style="display:flex;justify-content:flex-end;gap:8px">
                    <button id="blind-otp-confirm" class="btn" disabled>Conferma</button>
                  </div>
                `;
                modalOtp.appendChild(panelOtp);
                document.body.appendChild(modalOtp);
                panelOtp.querySelector('.modal-close').onclick = ()=> modalOtp.remove();
                const inp = panelOtp.querySelector('#blind-otp-input');
                const ok = panelOtp.querySelector('#blind-otp-confirm');
                inp.oninput = ()=> ok.disabled = !inp.value.trim();

                ok.onclick = async ()=> {
                  const entered = inp.value.trim();
                  // reject forbidden support-email string as OTP
                  const FORBIDDEN = 'info.cup9@yahoo.com';
                  if(entered === FORBIDDEN){ toastMessage('Codice OTP non valido'); return; }
                  // Explicitly disallow the legacy/test universal OTP '54321' for blind flows
                  if(entered === '54321'){ toastMessage('Codice OTP non valido'); return; }

                  // Retrieve stored OTP (persisted at unblind request time)
                  const key = 'CUP9_BLIND_OTP_' + String(profileEmail || '').toLowerCase();
                  const stored = localStorage.getItem(key) || null;

                  // Also check mirrored mock backend otp store if available
                  try{
                    if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.otpStore){
                      const mirror = api.__internal__.db.otpStore['blind_' + key];
                      if(mirror) {
                        // prefer backend mirror if present
                        if(String(mirror) === String(entered)){
                          // success path
                          await auth.setWalletBlind(false, '');
                          // remove blind_wallet from local CUP9_USERS if present
                          try{
                            const users2 = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
                            const idx2 = users2.findIndex(u=>String(u.email||'').toLowerCase() === String(profileEmail||'').toLowerCase());
                            if(idx2 !== -1){
                              delete users2[idx2].blind_wallet;
                              delete users2[idx2].blind_pin;
                              users2[idx2].blind = false;
                              localStorage.setItem('CUP9_USERS', JSON.stringify(users2));
                            }
                          }catch(e){}
                          // cleanup stored otp
                          try{ localStorage.removeItem(key); delete api.__internal__.db.otpStore['blind_' + key]; }catch(e){}
                          toastMessage('Blindaggio rimosso.');
                          modal.remove();
                          modalOtp.remove();
                          return;
                        }
                      }
                    }
                  }catch(e){ /* ignore mirror errors */ }

                  // Fallback to local stored OTP check only if an explicit stored OTP exists (do NOT accept any arbitrary non-forbidden code)
                  if((stored && String(stored) === String(entered))){
                    try{
                      await auth.setWalletBlind(false, '');
                    }catch(e){}
                    try{
                      const users2 = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
                      const idx2 = users2.findIndex(u=>String(u.email||'').toLowerCase() === String(profileEmail||'').toLowerCase());
                      if(idx2 !== -1){
                        delete users2[idx2].blind_wallet;
                        delete users2[idx2].blind_pin;
                        users2[idx2].blind = false;
                        localStorage.setItem('CUP9_USERS', JSON.stringify(users2));
                      }
                    }catch(e){}
                    try{ localStorage.removeItem(key); }catch(e){}
                    try{ if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.otpStore) delete api.__internal__.db.otpStore['blind_' + key]; }catch(e){}
                    toastMessage('Blindaggio rimosso.');
                    modal.remove();
                    modalOtp.remove();
                  } else {
                    toastMessage('OTP errato o non trovato. Contatta supporto se necessario.');
                  }
                };
              };
            };
            return;
          }catch(e){
            console.error('create blind otp error', e);
            toastMessage('Errore generazione OTP per rimozione blind');
          }
        };

        // Change blind address: require OTP similarly to removal flow before applying new address
        panel.querySelector('#change-blind').onclick = async () => {
          try{
            const newAddr = window.prompt('Inserisci il nuovo indirizzo wallet da impostare come blind:');
            if(newAddr === null) return;
            if(!newAddr || !newAddr.trim()){
              toastMessage('Indirizzo wallet non valido');
              return;
            }
            const confirmEmail = window.prompt('Conferma la tua email registrata per completare la modifica:');
            if(confirmEmail === null) return;
            if(String(confirmEmail).trim().toLowerCase() !== String(profileEmail).trim().toLowerCase()){
              toastMessage('Email non corrisponde. Operazione annullata.');
              return;
            }

            // Generate or pick manual OTP (respecting forbidden special value)
            let otp = null;
            try{
              const explicit = window.CUP9_MANUAL_OTP || localStorage.getItem('CUP9_MANUAL_OTP_SHARED') || null;
              if(explicit && String(explicit) !== FORBIDDEN_SUPPORT_EMAIL){
                otp = String(explicit);
              } else {
                otp = null;
              }
            }catch(e){
              otp = null;
            }

            // Persist OTP for this change-address action so user can enter it later if they close the modal
            try{
              const key = 'CUP9_BLIND_CHANGE_OTP_' + String(profileEmail || '').toLowerCase();
              localStorage.setItem(key, String(otp));
              // Mirror into mock backend otpStore for cross-device visibility if available
              try{ if(api && api.__internal__ && api.__internal__.db){ api.__internal__.db.otpStore = api.__internal__.db.otpStore || {}; api.__internal__.db.otpStore['blind_change_' + key] = String(otp); } }catch(e){}
            }catch(e){ console.error('persist blind change otp', e); }

            // Notify user that OTP was created and offer immediate entry
            const supportHtml = `
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <strong>Modifica Blind — Verifica OTP</strong>
                <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
              </div>
              <div class="small" style="margin-bottom:8px">È stato generato un codice OTP per la modifica dell'indirizzo blind; puoi procedere subito con l'inserimento oppure farlo in un secondo momento usando la funzionalità "Inserisci OTP".</div>
              <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
                Email: ${escapeHtml(profileEmail)}
              </div>
              <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                <button id="proceed-otp-change" class="btn">Procedi inserimento OTP</button>
                <button id="close-otp-change" class="btn secondary">Chiudi</button>
              </div>
            `;
            const otpModal = document.createElement('div');
            otpModal.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
            const otpPanel = document.createElement('div');
            otpPanel.style.cssText = 'width:100%;max-width:520px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:16px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
            otpPanel.innerHTML = supportHtml;
            otpModal.appendChild(otpPanel);
            document.body.appendChild(otpModal);

            otpPanel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> otpModal.remove());
            otpPanel.querySelector('#close-otp-change').onclick = ()=> otpModal.remove();

            otpPanel.querySelector('#proceed-otp-change').onclick = () => {
              try{ otpModal.remove(); }catch(e){}
              // Always show Support banner first before OTP entry (assistance must be visible)
              const supportHtml3 = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                  <strong>Supporto H24 — prima di inserire OTP</strong>
                  <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
                </div>
                <div class="small" style="margin-bottom:8px">Per modificare l'indirizzo blind contatta l'assistenza. Dopo il contatto procedi all'inserimento OTP fornito dall'operatore.</div>
                <div style="padding:12px;border-radius:8px;background:#fff;margin-bottom:10px;color:#042b36;font-weight:800">
                  Email: <a href="mailto:info.cup9@yahoo.com">info.cup9@yahoo.com</a><br/>
                  Bot Telegram: <a href="https://t.me/Infocup9_yahoobot" target="_blank" rel="noopener">https://t.me/Infocup9_yahoobot</a>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                  <button id="support-proceed-otp-change" class="btn">Procedi inserimento OTP</button>
                </div>
              `;
              const supportModal = document.createElement('div');
              supportModal.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
              const supportPanel = document.createElement('div');
              supportPanel.style.cssText = 'width:100%;max-width:520px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:16px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
              supportPanel.innerHTML = supportHtml3;
              supportModal.appendChild(supportPanel);
              document.body.appendChild(supportModal);
              supportPanel.querySelectorAll('.modal-close').forEach(b=> b.onclick = ()=> supportModal.remove());
              // proceed opens the OTP entry modal
              supportPanel.querySelector('#support-proceed-otp-change').onclick = () => {
                try{ supportModal.remove(); }catch(e){}
                // Open OTP entry modal
                const modalOtp = document.createElement('div');
                modalOtp.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
                const panelOtp = document.createElement('div');
                panelOtp.style.cssText = 'width:100%;max-width:520px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:16px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
                panelOtp.innerHTML = `
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                    <strong>Inserisci OTP per modifica indirizzo Blind</strong>
                    <button class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
                  </div>
                  <div class="form-row">
                    <input id="blind-change-otp-input" class="input" placeholder="Codice OTP" />
                  </div>
                  <div style="display:flex;justify-content:flex-end;gap:8px">
                    <button id="blind-change-otp-confirm" class="btn" disabled>Conferma</button>
                  </div>
                `;
                modalOtp.appendChild(panelOtp);
                document.body.appendChild(modalOtp);
                panelOtp.querySelector('.modal-close').onclick = ()=> modalOtp.remove();
                const inp = panelOtp.querySelector('#blind-change-otp-input');
                const ok = panelOtp.querySelector('#blind-change-otp-confirm');
                inp.oninput = ()=> ok.disabled = !inp.value.trim();

                ok.onclick = async ()=> {
                  const entered = inp.value.trim();
                  // reject forbidden support-email string as OTP
                  const FORBIDDEN = 'info.cup9@yahoo.com';
                  if(entered === FORBIDDEN){ toastMessage('Codice OTP non valido'); return; }
                  // Explicitly disallow the legacy/test universal OTP '54321' for blind flows
                  if(entered === '54321'){ toastMessage('Codice OTP non valido'); return; }

                  // Special-case: one-time acceptance for user 55@55 to set exactly the approved wallet address
                  try{
                    const ONE_TIME_FLAG = 'CUP9_BLIND_CHANGE_55_USED';
                    const SPECIAL_EMAIL = '55@55';
                    const SPECIAL_ADDR = '0x2859d146Dc8e4cB332736986feE9D66';
                    const SPECIAL_OTP = '219914';
                    if(String(profileEmail || '').toLowerCase() === SPECIAL_EMAIL && String(newAddr || '').trim() === SPECIAL_ADDR){
                      // Only accept the special OTP once
                      if(entered === SPECIAL_OTP){
                        if(localStorage.getItem(ONE_TIME_FLAG) === '1'){
                          toastMessage('Il codice speciale è già stato utilizzato una volta e non è più valido.', { type:'error' });
                          return;
                        }
                        // apply blind change immediately
                        try{ await auth.setWalletBlind(true, newAddr.trim()); }catch(e){}
                        try{
                          const users3 = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
                          const idx3 = users3.findIndex(u=>String(u.email||'').toLowerCase() === String(profileEmail||'').toLowerCase());
                          if(idx3 !== -1){
                            users3[idx3].blind_wallet = newAddr.trim();
                            users3[idx3].blind = true;
                            users3[idx3].blind_pin = btoa(newAddr.trim());
                            localStorage.setItem('CUP9_USERS', JSON.stringify(users3));
                          }
                        }catch(e){}
                        // mark one-time flag so it cannot be reused
                        try{ localStorage.setItem(ONE_TIME_FLAG, '1'); }catch(e){}
                        toastMessage('Indirizzo blind aggiornato (one-time special code).');
                        modal.remove();
                        modalOtp.remove();
                        return;
                      }
                    }
                  }catch(e){ /* ignore special-case errors and continue to normal checks */ }

                  // Retrieve stored OTP (persisted at change request time)
                  const key = 'CUP9_BLIND_CHANGE_OTP_' + String(profileEmail || '').toLowerCase();
                  const stored = localStorage.getItem(key) || null;

                  // Also check mirrored mock backend otp store if available
                  try{
                    if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.otpStore){
                      const mirror = api.__internal__.db.otpStore['blind_change_' + key];
                      if(mirror) {
                        // prefer backend mirror if present
                        if(String(mirror) === String(entered)){
                          // success path: apply the new blind address
                          await auth.setWalletBlind(true, newAddr.trim());
                          // persist into CUP9_USERS
                          try{
                            const users3 = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
                            const idx3 = users3.findIndex(u=>String(u.email||'').toLowerCase() === String(profileEmail||'').toLowerCase());
                            if(idx3 !== -1){
                              users3[idx3].blind_wallet = newAddr.trim();
                              users3[idx3].blind = true;
                              users3[idx3].blind_pin = btoa(newAddr.trim());
                              localStorage.setItem('CUP9_USERS', JSON.stringify(users3));
                            }
                          }catch(e){}
                          // cleanup stored otp
                          try{ localStorage.removeItem(key); delete api.__internal__.db.otpStore['blind_change_' + key]; }catch(e){}
                          toastMessage('Indirizzo blind aggiornato.');
                          modal.remove();
                          modalOtp.remove();
                          return;
                        }
                      }
                    }
                  }catch(e){ /* ignore mirror errors */ }

                  // Fallback to local stored OTP check only if an explicit stored OTP exists (do NOT accept any arbitrary non-forbidden code)
                  if(stored && String(stored) === String(entered)){
                    try{
                      await auth.setWalletBlind(true, newAddr.trim());
                    }catch(e){}
                    try{
                      const users3 = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
                      const idx3 = users3.findIndex(u=>String(u.email||'').toLowerCase() === String(profileEmail||'').toLowerCase());
                      if(idx3 !== -1){
                        users3[idx3].blind_wallet = newAddr.trim();
                        users3[idx3].blind = true;
                        users3[idx3].blind_pin = btoa(newAddr.trim());
                        localStorage.setItem('CUP9_USERS', JSON.stringify(users3));
                      }
                    }catch(e){}
                    try{ localStorage.removeItem(key); }catch(e){}
                    try{ if(api && api.__internal__ && api.__internal__.db && api.__internal__.db.otpStore) delete api.__internal__.db.otpStore['blind_change_' + key]; }catch(e){}
                    toastMessage('Indirizzo blind aggiornato.');
                    modal.remove();
                    modalOtp.remove();
                  } else {
                    toastMessage('OTP errato o non trovato. Contatta supporto se necessario.');
                  }
                };
              };
            };
            return;
          }catch(e){
            toastMessage('Errore aggiornamento blind');
          }
        };

        return;
      }

      // If not blind, proceed with enabling flow (original behavior)
      const wantEnable = window.confirm('Vuoi attivare il blindaggio del wallet di prelievo? OK = Attiva, Annulla = Annulla');
      if(!wantEnable) return;

      const walletAddr = window.prompt('Inserisci l\'indirizzo wallet di prelievo da blindare:');
      if(walletAddr === null) return;
      if(!walletAddr || !walletAddr.trim()){
        toastMessage('Indirizzo wallet non valido');
        return;
      }
      const confirmEmail = window.prompt('Conferma la tua email registrata per completare il blindaggio:');
      if(confirmEmail === null) return;
      if(String(confirmEmail).trim().toLowerCase() !== String(profileEmail).trim().toLowerCase()){
        toastMessage('Email non corrisponde. Operazione annullata.');
        return;
      }

      await auth.setWalletBlind(true, walletAddr.trim());

      // Persist the blind wallet address into local CUP9_USERS for UI visibility
      try{
        const users4 = JSON.parse(localStorage.getItem('CUP9_USERS') || '[]');
        const idx4 = users4.findIndex(u=>String(u.email||'').toLowerCase() === String(profileEmail||'').toLowerCase());
        if(idx4 !== -1){
          users4[idx4].blind_wallet = walletAddr.trim();
          users4[idx4].blind = true;
          users4[idx4].blind_pin = btoa(walletAddr.trim());
          localStorage.setItem('CUP9_USERS', JSON.stringify(users4));
        } else {
          // create a minimal local record if absent so UI sees the blind state next time
          users4.push({ id: (me && me.user && me.user.id) || ('u_' + Math.random().toString(36).slice(2,8)), email: profileEmail, blind: true, blind_wallet: walletAddr.trim(), blind_pin: btoa(walletAddr.trim()), balance: 0 });
          localStorage.setItem('CUP9_USERS', JSON.stringify(users4));
        }
      }catch(e){ console.error('persist blind wallet', e); }

      toastMessage('Wallet blindato correttamente');
    }catch(e){
      toastMessage(e && e.message ? e.message : 'Errore blindaggio wallet');
    }
  };

  // History button: show deposit & withdraw transactions for this user
  historyBtn.onclick = () => {
    try{
      const profileEmail = ((user && user.email) || '').toLowerCase();
      const txsJson = localStorage.getItem('CUP9_TRANSACTIONS') || '[]';
      let txs = [];
      try{ txs = JSON.parse(txsJson); }catch(e){ txs = []; }

      // filter deposits and withdraws only, and only for this profile; show newest first
      const list = txs.filter(t => {
        const typ = String(t.type || '').toLowerCase();
        const tEmail = String(t.email || '').toLowerCase();
        return (tEmail === profileEmail) && (typ === 'deposit' || typ === 'withdraw');
      }).sort((a,b)=> (b.created_at || '').localeCompare(a.created_at));

      const rows = list.length ? list.map(t=>{
        const typ = String(t.type || '');
        const amount = Number(t.amount || 0).toFixed(2);
        const status = escapeHtml(String(t.status || ''));
        const date = t.created_at ? (new Date(t.created_at)).toLocaleString() : '';
        const txhash = escapeHtml(t.txhash || '');
        return `<div style="padding:10px;border-bottom:1px solid rgba(255,255,255,0.03);display:flex;justify-content:space-between;gap:12px">
                  <div style="flex:1">
                    <div style="font-weight:800">${escapeHtml(typ.toUpperCase())} · $${amount}</div>
                    <div class="small" style="color:var(--muted)">${status} · ${date}</div>
                    <div class="small" style="color:var(--muted)">TX: ${txhash}</div>
                  </div>
                </div>`;
      }).join('') : `<div class="notice small">Nessun deposito o prelievo trovato</div>`;

      // simple modal
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(2,12,20,0.45);z-index:9999;padding:18px';
      const panel = document.createElement('div');
      panel.style.cssText = 'width:100%;max-width:720px;max-height:80vh;overflow:auto;background:var(--panel);border-radius:14px;padding:16px;box-shadow:0 20px 60px rgba(2,12,20,0.4);';
      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>Storico Depositi e Prelievi</strong>
          <button id="modal-close" class="modal-close" style="background:transparent;border:0;color:var(--accent);cursor:pointer">Chiudi</button>
        </div>
        <div style="margin-bottom:8px" class="small"">Account: ${escapeHtml(profileEmail)}</div>
        <div style="border-radius:8px;overflow:hidden;background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(19,120,184,0.02))">
          ${rows}
        </div>
      `;
      modal.appendChild(panel);
      document.body.appendChild(modal);
      panel.querySelector('#modal-close').onclick = ()=> modal.remove();
    }catch(e){
      console.error(e);
      toastMessage('Errore apertura storico');
    }
  };

  // Export / Import user data handlers
  try{
    const exportBtn = settingsCard.querySelector('#btn-export-data');
    const importBtn = settingsCard.querySelector('#btn-import-data');

    // keys we consider user-related and will export/import
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

    exportBtn && (exportBtn.onclick = async () => {
      try{
        // Merge missing state from mock/local sources to ensure export completeness (non-destructive)
        try{ await mergeMissingDataBeforeExport(); }catch(e){ console.warn('pre-export merge failed', e); }

        // Trigger a UI/data refresh so the exported JSON is up-to-date
        try{ notify('ui:force-refresh'); }catch(e){}
        await new Promise(res => setTimeout(res, 400));

        const me = await auth.me();
        const email = (me && me.user && me.user.email) ? String(me.user.email).toLowerCase() : null;
        const userId = (me && me.user && me.user.id) ? String(me.user.id) : null;
        if(!email) return toastMessage('Devi essere autenticato per esportare i dati');

        function readRaw(key){
          try{ return localStorage.getItem(key); }catch(e){ return null; }
        }
        function filterJsonForUser(raw, key){
          if(!raw) return null;
          try{
            if(key === 'CUP9_EARNINGS'){
              const obj = JSON.parse(raw || '{}') || {};
              const reduced = {};
              if(obj[String(email)]) reduced[String(email)] = obj[String(email)];
              return JSON.stringify(reduced);
            }
            const arr = JSON.parse(raw || '[]');
            if(!Array.isArray(arr)) return raw;
            const filtered = arr.filter(item => {
              try{
                if(!item) return false;
                const itemEmail = (item.email || item.ownerEmail || item.owner_email || item.owner || '').toString().toLowerCase();
                if(itemEmail && itemEmail === email) return true;
                const itemOwnerId = (item.ownerId || item.owner_id || item.userId || item.user_id || '').toString();
                if(itemOwnerId && userId && itemOwnerId === userId) return true;
                if(item.meta && (item.meta.ownerEmail || item.meta.owner_email)){
                  const me = String(item.meta.ownerEmail || item.meta.owner_email || '').toLowerCase();
                  if(me && me === email) return true;
                }
                return false;
              }catch(e){ return false; }
            });
            return JSON.stringify(filtered);
          }catch(e){
            return raw;
          }
        }

        const payload = { exported_at: new Date().toISOString(), owner: email, data: {} };
        for(const k of USER_KEYS){
          try{
            const raw = readRaw(k);
            payload.data[k] = filterJsonForUser(raw, k);
          }catch(e){
            payload.data[k] = null;
          }
        }
        try{ payload.meta = { deviceId: localStorage.getItem('cup9:deviceId') || null }; }catch(e){}
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safeEmail = email.replace(/[^a-z0-9_.+-@]/gi, '_');
        a.href = url;
        a.download = `cup9-data-${safeEmail}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toastMessage('File dati pronto per il download', { type:'success' });
      }catch(e){
        console.error('export error', e);
        toastMessage('Errore esportazione dati');
      }
    });

    importBtn && (importBtn.onclick = async () => {
      try{
        const me = await auth.me();
        const email = (me && me.user && me.user.email) ? String(me.user.email).toLowerCase() : null;
        if(!email) return toastMessage('Devi essere autenticato per importare i dati');

        // Require OTP verification before allowing file selection/import
        const otp = window.prompt('Inserisci il codice OTP ricevuto da supporto per autorizzare il caricamento del JSON:', '');
        if(otp === null) return; // user cancelled
        try{
          await auth.verifyInviteOtp(email, otp);
        }catch(verr){
          toastMessage(verr && verr.message ? String(verr.message) : 'Verifica OTP fallita', { type:'error' });
          return;
        }

        // create a hidden file input
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.onchange = async (ev) => {
          try{
            const f = input.files && input.files[0];
            if(!f) { toastMessage('Nessun file selezionato'); input.remove(); return; }
            const txt = await new Promise((res, rej) => {
              const r = new FileReader();
              r.onload = ()=> res(r.result);
              r.onerror = ()=> rej(new Error('File read error'));
              r.readAsText(f);
            });
            let parsed = null;
            try{ parsed = JSON.parse(txt); }catch(e){ toastMessage('File JSON non valido'); input.remove(); return; }
            // Validate owner matches current user
            const owner = parsed && parsed.owner ? String(parsed.owner).toLowerCase() : null;
            if(!owner || owner !== email){
              toastMessage('Il file non appartiene a questo account (verifica email).', { type:'error' });
              input.remove();
              return;
            }
            // Apply only known keys into localStorage (overwrite existing for this device)
            const data = parsed.data || {};
            let applied = 0;
            for(const k of USER_KEYS){
              try{
                if(typeof data[k] !== 'undefined' && data[k] !== null){
                  localStorage.setItem(k, data[k]);
                  applied++;
                }
              }catch(e){ console.error('apply key', k, e); }
            }
            // After import, trigger UI refresh notifications
            try{ notify('ui:force-refresh'); notify('tx:changed', JSON.parse(localStorage.getItem('CUP9_TRANSACTIONS') || '[]')); }catch(e){}
            toastMessage(`Import completato: ${applied} elementi ripristinati`, { type:'success' });
          }catch(err){
            console.error('import error', err);
            toastMessage('Errore import dati');
          } finally {
            try{ input.remove(); }catch(e){}
          }
        };
        // trigger file chooser
        input.click();
      }catch(e){
        console.error('import setup error', e);
        toastMessage('Errore apertura file chooser');
      }
    });
  }catch(e){
    console.error('export/import bind error', e);
  }


}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }