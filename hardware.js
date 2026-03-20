/* hardware.js - improved hardware page layout, accessibility, responsive grid and richer card details.
   Changes: larger responsive grid, card footer with specs, lazy-loading images, hover/tap affordances,
   keyboard-accessible modals, and small ARIA improvements. Other pages are unchanged.
*/

(function(){
  const formatMoney = (window.__cup9_utils && window.__cup9_utils.formatMoney) || (n=>'$' + (Number(n)||0).toFixed(2));

  // element creator helper
  function node(tag, opts){
    const el = document.createElement(tag || 'div');
    if (opts) {
      if (opts.cls) el.className = opts.cls;
      if (opts.text) el.textContent = opts.text;
      if (opts.html) el.innerHTML = opts.html;
      if (opts.attrs) Object.keys(opts.attrs).forEach(k => el.setAttribute(k, opts.attrs[k]));
    }
    return el;
  }

  // Plans (use local GPU image asset for visuals)
  const plans = [
    { key:'tier_mini', name:'Tier Mini', tflops: 2, price: 29, note: 'Entry', image: '/gpu-purchased.png' },
    { key:'starter_plus', name:'Starter Plus', tflops: 6, price: 59, note: 'Starter', image: '/gpu-purchased.png' },
    { key:'value_compute', name:'Value Compute', tflops: 20, price: 250, note: 'Ideale per test', image: '/gpu-purchased.png' },
    { key:'compute_classic', name:'Compute Classic', tflops: 45, price: 480, note: 'Uso generico', image: '/gpu-purchased.png' },
    { key:'performance', name:'Performance', tflops: 90, price: 900, note: 'Alte prestazioni', image: '/gpu-purchased.png' },
    { key:'pro_ai', name:'Pro AI', tflops: 160, price: 1700, note: 'AI workloads', image: '/gpu-purchased.png' },
    { key:'enterprise', name:'Enterprise', tflops: 320, price: 3200, note: 'Team e produzione', image: '/gpu-purchased.png' },
    { key:'ultra_enterprise', name:'Ultra Enterprise', tflops: 640, price: 6000, note: 'Massima potenza', image: '/gpu-purchased.png' }
  ];

  // safe append for overlays (keeps them inside page wrapper when possible)
  function appendOverlay(container, overlay){
    try {
      if (container && container.appendChild) container.appendChild(overlay);
      else document.body.appendChild(overlay);
    } catch(e){
      try { document.body.appendChild(overlay); } catch(e){}
    }
  }

  // keyboard utility to close modals on ESC
  function attachEscToClose(overlay, cleanup){
    function handler(e){ if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }

  // Expose hardwarePage used by app.js
  window.hardwarePage = function(){
    const page = node('div', { cls: 'page-content', attrs: { role: 'region', 'aria-label': 'Hardware catalog' } });

    // Hero
    const hero = node('div', { cls: 'hardware-hero' });
    const titleWrap = node('div');
    titleWrap.appendChild(node('div', { cls:'h-title', text: 'Hardware' }));
    titleWrap.appendChild(node('div', { cls:'small', text: 'Scegli la potenza giusta per il tuo workload' }));
    hero.appendChild(titleWrap);
    page.appendChild(hero);

    // Controls
    const controls = node('div', { cls: 'hardware-controls' });
    const searchWrap = node('div', { cls: 'hw-search' });
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Cerca tier, TFLOPS o prezzo';
    searchInput.className = 'input';
    searchInput.setAttribute('aria-label', 'Cerca hardware');
    searchWrap.appendChild(searchInput);

    const sortSelect = document.createElement('select'); sortSelect.className = 'hw-select';
    sortSelect.innerHTML = '<option value="recommended">Raccomandato</option><option value="tflops_desc">TFLOPS ↓</option><option value="price_asc">Prezzo ↑</option><option value="price_desc">Prezzo ↓</option>';
    controls.appendChild(searchWrap);
    controls.appendChild(sortSelect);
    page.appendChild(controls);

    // Grid (improved responsive columns)
    const grid = node('div', { cls: 'hardware-grid', attrs: { role: 'list' } });
    // tweak CSS via inline styles to guarantee column counts without editing CSS files
    grid.style.gridTemplateColumns = 'repeat(1, 1fr)';
    // responsive adjustments
    const applyGridCols = () => {
      try {
        if (window.innerWidth >= 1100) grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
        else if (window.innerWidth >= 720) grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
        else grid.style.gridTemplateColumns = 'repeat(1, 1fr)';
      } catch(e){}
    };
    applyGridCols();
    window.addEventListener && window.addEventListener('resize', applyGridCols);

    function openFullscreen(plan){
      const overlay = node('div', { cls: 'hw-overlay', attrs:{ tabindex: -1 } });
      overlay.style.zIndex = 120;
      const modal = node('div', { cls: 'hw-fullscreen card', attrs:{ role:'dialog', 'aria-label': plan.name, tabindex: 0 }});
      modal.style.maxWidth = '980px';
      const header = node('div', { cls:'fs-header' });
      header.appendChild(node('div', { cls:'h-title', text: plan.name }));
      const close = node('button', { cls:'btn', text: 'Chiudi' });
      close.onclick = ()=> { try { overlay.remove(); } catch(e){} };
      header.appendChild(close);
      modal.appendChild(header);

      const banner = node('div', { cls:'hw-banner' });
      banner.style.height = '280px';
      banner.style.display = 'flex';
      banner.style.alignItems = 'center';
      banner.style.justifyContent = 'center';
      banner.style.backgroundColor = 'transparent';

      // optimize image handling: lazy, role img, descriptive alt
      const img = document.createElement('img');
      img.src = plan.image || '/Screenshot_20260314_212313_Chrome.jpg';
      img.alt = `${plan.name} — ${plan.note}`;
      img.loading = 'lazy';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      banner.appendChild(img);
      modal.appendChild(banner);

      const body = node('div'); body.style.marginTop='12px';
      const specs = node('div');
      specs.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:160px"><div class="small">TFLOPS</div><div class="h-title">${plan.tflops} TFLOPS</div></div>
        <div style="flex:1;min-width:160px"><div class="small">Prezzo</div><div class="h-title">${formatMoney(plan.price)}</div></div>
        <div style="flex:1;min-width:160px"><div class="small">Tipo</div><div class="h-title">${plan.note}</div></div>
      </div>`;
      body.appendChild(specs);

      const estDaily = +(plan.price * 0.011).toFixed(2);
      body.appendChild(node('div', { cls:'small', text: `Stima giornaliera: ${formatMoney(estDaily)} · Stima mensile: ${formatMoney((estDaily*30).toFixed(2))}` }));

      // feature list for quick scanning
      const features = node('ul'); features.style.marginTop = '12px'; features.style.marginBottom = '6px';
      ['24/7 uptime', 'Supporto base', `${plan.tflops} TFLOPS garantiti`, 'Pagamento una-tantum'].forEach(f=>{
        const li = document.createElement('li'); li.className='small'; li.textContent = f; features.appendChild(li);
      });
      body.appendChild(features);

      const actions = node('div'); actions.style.display='flex'; actions.style.gap='10px'; actions.style.marginTop='14px';
      actions.style.flexWrap = 'wrap';
      const buy = node('button', { cls:'primary', text:'Acquista' });
      buy.onclick = async ()=>{
        const session = (window.getSession && window.getSession()) || (window.__cup9_session);
        if (!session) { (window.navigate && window.navigate('login')); return; }
        if (!confirm(`Confermi l'acquisto di ${plan.name} per ${formatMoney(plan.price)}?`)) return;

        try {
          // Compute spendable: sum of confirmed/accredited deposits minus confirmed purchases (never allow negative)
          const allTx = (window.txCol && window.txCol.getList ? window.txCol.getList() : []);
          const deposits = allTx.filter(t => t.type === 'deposit' && (String(t.status).toLowerCase() === 'confirmed' || String(t.status).toLowerCase() === 'accredited' || t.credited === true));
          const purchases = allTx.filter(t => t.type === 'purchase' && (String(t.status).toLowerCase() === 'confirmed' || String(t.status).toLowerCase() === 'accredited'));
          const totalDeposits = deposits.reduce((s,t)=>s + (Number(t.amount)||0),0);
          const totalPurchases = purchases.reduce((s,t)=>s + (Number(t.amount)||0),0);
          const spendable = Math.max(0, totalDeposits - totalPurchases);

          if (Number(spendable) < Number(plan.price)) {
            return alert(`Saldo depositi insufficiente. Saldo disponibile: ${formatMoney(spendable)} — prezzo: ${formatMoney(plan.price)}`);
          }

          // create a confirmed purchase transaction so balances remain consistent and no negative balances occur
          let purchaseRec = null;
          if (window.txCol) {
            purchaseRec = await window.txCol.create({
              user_id: session.id,
              type: 'purchase',
              amount: plan.price,
              status: 'confirmed',
              created_at: new Date().toISOString(),
              note: `Acquisto ${plan.name}`
            });
          }

          // create device only after purchase transaction recorded
          if (window.deviceCol) {
            await window.deviceCol.create({
              owner_id: session.id,
              name: plan.name,
              plan_key: plan.key,
              price: plan.price,
              tflops: plan.tflops,
              active: true,
              purchased: true,
              non_returnable: true,
              daily_yield: +(plan.price * 0.011),
              created_at: new Date().toISOString(),
              last_accrual: new Date().toISOString(),
              purchase_tx_id: purchaseRec && purchaseRec.id
            });
          }

          alert('Acquisto completato.');
        } catch(e){
          console.warn('buy failed', e);
          alert('Acquisto fallito');
        } finally {
          try { if (typeof window.__cup9gpu_forcePersist === 'function') window.__cup9gpu_forcePersist(); } catch(e){}
          overlay.remove();
          (window.render && window.render());
        }
      };
      const share = node('button', { cls:'btn', text:'Condividi link' });
      share.onclick = async ()=>{
        try {
          const base = (typeof window.baseUrl === 'string' && window.baseUrl) ? window.baseUrl : (window.location.origin + window.location.pathname);
          const link = `${base.replace(/\/$/, '')}?ref=${encodeURIComponent(plan.key)}`;
          await navigator.clipboard.writeText(link);
          alert('Link copiato: ' + link);
        } catch(e){ alert('Condivisione non disponibile'); }
      };
      const details = node('button', { cls:'btn', text:'Dettagli tecnici' });
      details.onclick = ()=> alert(`${plan.name}\n${plan.note}\nTFLOPS: ${plan.tflops}\nPrezzo: ${formatMoney(plan.price)}\nCaratteristiche: 24/7 uptime, supporto base`);

      actions.appendChild(buy); actions.appendChild(share); actions.appendChild(details);
      body.appendChild(actions);

      modal.appendChild(body);
      overlay.appendChild(modal);
      appendOverlay(page, overlay);

      // focus management and ESC close
      const detach = attachEscToClose(overlay, ()=> { overlay.remove(); detach(); });
      modal.focus && modal.focus();
    }

    // card builder with improved structure and accessibility
    function buildCard(p){
      const card = node('article', { cls: 'hw-card condensed', attrs:{ role:'listitem', tabindex: 0 } });
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.gap = '8px';
      card.style.overflow = 'hidden';

      // image container (keeps aspect and lazy-loading)
      const imgWrap = node('div', { cls: 'hw-banner' });
      imgWrap.style.height = '180px';
      imgWrap.style.display = 'flex';
      imgWrap.style.alignItems = 'center';
      imgWrap.style.justifyContent = 'center';
      imgWrap.style.backgroundColor = 'transparent';
      imgWrap.style.overflow = 'hidden';

      const img = document.createElement('img');
      img.src = p.image || '/Screenshot_20260314_212313_Chrome.jpg';
      img.alt = `${p.name} — ${p.note}`;
      img.loading = 'lazy';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      imgWrap.appendChild(img);
      card.appendChild(imgWrap);

      // content area
      const body = node('div', { cls: 'hw-body' });
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '8px';
      body.style.padding = '10px';

      const top = node('div');
      top.style.display = 'flex';
      top.style.justifyContent = 'space-between';
      top.style.alignItems = 'center';
      top.style.gap = '8px';

      const left = node('div');
      left.appendChild(node('div', { cls:'name', text: p.name }));
      left.appendChild(node('div', { cls:'sub', text: p.note }));

      const right = node('div');
      right.style.textAlign = 'right';
      right.appendChild(node('div', { cls:'price-badge', text: formatMoney(p.price) }));
      right.appendChild(node('div', { cls:'hw-stats', text: `${p.tflops} TFLOPS` }));

      top.appendChild(left);
      top.appendChild(right);
      body.appendChild(top);

      // footer: compact spec badges
      const footer = node('div');
      footer.style.display = 'flex';
      footer.style.justifyContent = 'space-between';
      footer.style.alignItems = 'center';
      footer.style.gap = '8px';

      const specList = node('div');
      specList.style.display='flex';
      specList.style.gap='6px';
      specList.style.flexWrap='wrap';
      const estDaily = +(p.price * 0.011).toFixed(2);
      const specs = [
        `${p.tflops} TFLOPS`,
        `+${formatMoney(estDaily)}/giorno`,
        p.non_returnable ? 'Permanente' : 'Standard'
      ];
      specs.forEach(s => {
        const sp = node('div', { cls: 'hw-chip', text: s });
        sp.style.fontSize = '12px';
        sp.style.padding = '8px';
        sp.style.minWidth = 'auto';
        specList.appendChild(sp);
      });

      const actions = node('div');
      actions.style.display='flex';
      actions.style.gap='8px';
      actions.style.alignItems='center';

      const detailsBtn = node('button', { cls:'btn', text:'Dettagli' });
      detailsBtn.onclick = ()=> openFullscreen(p);
      const buyBtn = node('button', { cls:'primary', text:'Acquista' });
      buyBtn.onclick = async ()=>{
        const session = (window.getSession && window.getSession()) || (window.__cup9_session);
        if (!session) { (window.navigate && window.navigate('login')); return; }
        if (!confirm(`Acquistare ${p.name} per ${formatMoney(p.price)}?`)) return;

        // Prevent duplicate purchases: check for a recent identical purchase tx
        try {
          const recent = (window.txCol && window.txCol.getList ? window.txCol.getList() : []).find(t =>
            String(t.user_id) === String(session.id) &&
            String(t.type) === 'purchase' &&
            String(t.note) === `Acquisto ${p.name}` &&
            (Date.now() - new Date(t.created_at).getTime()) < 60000
          );
          if (recent) return alert('Un acquisto simile è già in corso o è stato recentemente registrato, attendi qualche secondo.');
        } catch(e){ /* best-effort */ }

        // disable to avoid double-click race
        buyBtn.disabled = true;
        try {
          // compute spendable balance from confirmed/accredited deposits minus confirmed purchases
          const allTx = (window.txCol && window.txCol.getList ? window.txCol.getList() : []);
          const deposits = allTx.filter(t => t.type === 'deposit' && (String(t.status).toLowerCase() === 'confirmed' || String(t.status).toLowerCase() === 'accredited' || t.credited === true));
          const purchases = allTx.filter(t => t.type === 'purchase' && (String(t.status).toLowerCase() === 'confirmed' || String(t.status).toLowerCase() === 'accredited'));
          const totalDeposits = deposits.reduce((s,t)=>s + (Number(t.amount)||0),0);
          const totalPurchases = purchases.reduce((s,t)=>s + (Number(t.amount)||0),0);
          const spendable = Math.max(0, totalDeposits - totalPurchases);

          if (Number(spendable) < Number(p.price)) {
            return alert(`Saldo depositi insufficiente. Saldo disponibile: ${formatMoney(spendable)} — prezzo: ${formatMoney(p.price)}`);
          }

          // record confirmed purchase tx
          let purchaseRec = null;
          if (window.txCol) {
            purchaseRec = await window.txCol.create({
              user_id: session.id,
              type: 'purchase',
              amount: p.price,
              status: 'confirmed',
              created_at: new Date().toISOString(),
              note: `Acquisto ${p.name}`
            });
          }

          if (window.deviceCol) {
            await window.deviceCol.create({
              owner_id: session.id,
              name: p.name,
              plan_key: p.key,
              price: p.price,
              tflops: p.tflops,
              active: true,
              purchased: true,
              non_returnable: true,
              daily_yield: +(p.price * 0.011),
              created_at: new Date().toISOString(),
              last_accrual: new Date().toISOString(),
              purchase_tx_id: purchaseRec && purchaseRec.id
            });
          }

          alert('Acquisto completato.');
        } catch(e){
          console.warn('buy failed', e);
          alert('Acquisto fallito');
        } finally {
          try { if (typeof window.__cup9gpu_forcePersist === 'function') window.__cup9gpu_forcePersist(); } catch(e){}
          buyBtn.disabled = false;
          (window.render && window.render());
        }
      };

      actions.appendChild(detailsBtn);
      actions.appendChild(buyBtn);

      footer.appendChild(specList);
      footer.appendChild(actions);

      body.appendChild(footer);
      card.appendChild(body);

      // keyboard enter/space to open details
      card.addEventListener('keydown', (ev)=> {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openFullscreen(p); }
      });

      // small hover affordance for pointer users
      card.addEventListener('mouseover', ()=> { card.style.transform = 'translateY(-6px)'; card.style.transition = 'transform .16s ease'; });
      card.addEventListener('mouseout', ()=> { card.style.transform = ''; });

      return card;
    }

    function renderGrid(){
      grid.innerHTML = '';
      const q = (searchInput.value || '').trim().toLowerCase();
      let visible = plans.slice();
      if (q) visible = visible.filter(p => (p.name + ' ' + p.note + ' ' + p.tflops + ' ' + p.price).toLowerCase().includes(q));
      const mode = sortSelect.value;
      if (mode === 'tflops_desc') visible.sort((a,b)=>b.tflops-a.tflops);
      else if (mode === 'price_asc') visible.sort((a,b)=>a.price-b.price);
      else if (mode === 'price_desc') visible.sort((a,b)=>b.price-a.price);

      visible.forEach(p => grid.appendChild(buildCard(p)));

      if (visible.length === 0) {
        grid.appendChild(node('div', { cls:'empty-state', text:'Nessun piano corrisponde alla ricerca' }));
      }
    }

    searchInput.addEventListener('input', ()=> renderGrid());
    sortSelect.addEventListener('change', ()=> renderGrid());

    page.appendChild(grid);
    renderGrid();

    page.appendChild(node('div', { cls:'small-note', text:'Le GPU acquistate appariranno in "I miei dispositivi". Le risorse sono permanenti e non restituibili.' }));
    return page;
  };

  // myDevicesPage: lists devices owned by current session (unchanged behavior but better accessible)
  window.myDevicesPage = async function(){
    const wrap = node('div', { cls:'card' });
    wrap.appendChild(node('h3', { text:'I miei dispositivi' }));
    const session = (window.getSession && window.getSession()) || (window.__cup9_session);
    const devList = (window.deviceCol && window.deviceCol.getList ? window.deviceCol.getList().filter(d=>String(d.owner_id)===String(session && session.id)) : []);
    const listWrap = node('div', { cls:'list', attrs:{ role:'list' } });

    if (!devList || devList.length === 0) {
      listWrap.appendChild(node('div', { cls:'small', text:'Nessun dispositivo attivo' }));
    } else {
      devList.forEach(d => {
        const row = node('div', { cls:'tx', attrs:{ role:'listitem' } });
        const left = node('div');
        left.appendChild(node('div', { text: d.name || 'Dispositivo' }));
        const meta = node('div', { cls:'meta', text: d.trial ? 'Trial' : (d.non_returnable ? 'Permanente' : (d.active ? 'Attivo' : 'Disattivato')) });
        meta.style.fontSize = '13px'; meta.style.color = 'var(--muted)';
        left.appendChild(meta);

        const right = node('div'); right.style.textAlign = 'right';
        right.appendChild(node('div', { cls:'tx-amount', text: d.daily_yield ? formatMoney(d.daily_yield) : '-' }));
        const badge = node('div', { cls:'small', text: d.non_returnable ? 'Hardware permanente (non restituibile)' : (d.trial ? 'Trial' : 'Standard') });
        badge.style.color = 'var(--muted)'; badge.style.fontWeight = 700; right.appendChild(badge);

        row.appendChild(left); row.appendChild(right);
        listWrap.appendChild(row);
      });
    }

    wrap.appendChild(listWrap);
    return wrap;
  };

})();