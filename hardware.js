/* hardware.js
   Extracted hardware-related UI: hardwarePage and myDevicesPage.
   Depends on globals provided by app.js and utils.js (txCol, deviceCol, getSession, navigate, formatMoney, etc.).
   Uses window.__cup9_utils.formatMoney and window.__cup9_utils.generateOTP when needed.
*/

(function(){
  // helper accessors (fall back to no-op implementations to avoid runtime errors)
  const formatMoney = (window.__cup9_utils && window.__cup9_utils.formatMoney) || (n=>String(n));
  const generateOTP = (window.__cup9_utils && window.__cup9_utils.generateOTP) || (()=>'000000');

  // hardwarePage implementation (extracted)
  window.hardwarePage = function(){
    // small plan catalog (kept in sync with previous app.js content)
    const plans = [
      { key:'value_compute', name:'Value Compute', tflops: 20, price: 250, note: 'Ideale per test' },
      { key:'compute_classic', name:'Compute Classic', tflops: 45, price: 480, note: 'Uso generico' },
      { key:'performance', name:'Performance', tflops: 90, price: 900, note: 'Alte prestazioni' },
      { key:'pro_ai', name:'Pro AI', tflops: 160, price: 1700, note: 'AI workloads' },
      { key:'enterprise', name:'Enterprise', tflops: 320, price: 3200, note: 'Team e produzione' },
      { key:'ultra_enterprise', name:'Ultra Enterprise', tflops: 640, price: 6000, note: 'Massima potenza' },
    ];

    const el = (tag, content)=>{
      const d = document.createElement('div');
      d.className = tag;
      if (typeof content === 'string') d.textContent = content;
      else if (content instanceof HTMLElement) d.appendChild(content);
      else if (Array.isArray(content)) content.forEach(c=> d.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
      return d;
    };

    const page = document.createElement('div'); page.className='page-content';
    const hero = document.createElement('div'); hero.className='hardware-hero';
    hero.appendChild(el('div',[ el('div.h-title','Catalogo GPU'), el('div.small','Scegli un piano — rendimento 1.10% giornaliero per GPU attiva') ]));
    const heroActions = document.createElement('div');
    const helpBtn = document.createElement('button'); helpBtn.className='btn'; helpBtn.textContent='Guida';
    helpBtn.onclick = ()=>alert('Seleziona un piano e usa il tuo saldo spendibile per acquistare. Le GPU sono non restituibili.');
    heroActions.appendChild(helpBtn);
    hero.appendChild(heroActions);
    page.appendChild(hero);

    const controls = document.createElement('div'); controls.className = 'hardware-controls';
    const searchWrap = document.createElement('div'); searchWrap.className = 'hw-search';
    const searchInput = document.createElement('input'); searchInput.placeholder = 'Cerca per nome o TFLOPS...';
    searchInput.type = 'search';
    searchWrap.appendChild(searchInput);
    const select = document.createElement('select'); select.className = 'hw-select';
    select.innerHTML = '<option value="recommended">Raccomandato</option><option value="price_asc">Prezzo ↑</option><option value="price_desc">Prezzo ↓</option><option value="tflops_desc">TFLOPS ↓</option>';
    controls.appendChild(searchWrap); controls.appendChild(select);
    page.appendChild(controls);

    const grid = document.createElement('div'); grid.className = 'hardware-grid';

    function openFullscreen(plan){
      const overlay = document.createElement('div'); overlay.className = 'hw-overlay';
      const fs = document.createElement('div'); fs.className = 'hw-fullscreen card';
      const header = document.createElement('div'); header.className = 'fs-header';
      const leftBlock = document.createElement('div'); leftBlock.style.display='flex'; leftBlock.style.gap='12px'; leftBlock.style.alignItems='center';
      const chip = document.createElement('div'); chip.className='fs-chip'; chip.textContent = `${plan.tflops}T`;
      const info = document.createElement('div');
      info.appendChild(el('div.h-title', plan.name));
      info.appendChild(el('div.small', `${plan.note} · ${plan.tflops} TFLOPS`));
      leftBlock.appendChild(chip); leftBlock.appendChild(info);
      header.appendChild(leftBlock);
      const closeBtn = document.createElement('button'); closeBtn.className='btn'; closeBtn.textContent='Chiudi';
      closeBtn.onclick = ()=>document.body.removeChild(overlay);
      header.appendChild(closeBtn);
      fs.appendChild(header);

      const body = document.createElement('div'); body.style.marginTop='12px';
      const priceRow = document.createElement('div'); priceRow.style.display='flex'; priceRow.style.justifyContent='space-between'; priceRow.style.alignItems='center';
      priceRow.appendChild(el('div',[el('div.small','Prezzo'), el('div.h-title', formatMoney(plan.price))]));
      const estDaily = +(plan.price * 0.011).toFixed(2);
      priceRow.appendChild(el('div',[el('div.small','Guadagno giornaliero stimato'), el('div.h-title', formatMoney(estDaily))]));
      body.appendChild(priceRow);

      const desc = document.createElement('div'); desc.className='help'; desc.style.marginTop='10px';
      desc.textContent = `Dettagli: ${plan.name} — ${plan.note}. TFLOPS: ${plan.tflops}. Le GPU sono permanenti e non restituibili.`;
      body.appendChild(desc);

      const modalActions = document.createElement('div'); modalActions.style.display='flex'; modalActions.style.gap='8px'; modalActions.style.marginTop='14px';
      const buyBtn = document.createElement('button'); buyBtn.className='primary'; buyBtn.textContent='Acquista';
      buyBtn.onclick = async ()=>{
        const session = (window.getSession && window.getSession()) || (window.__cup9_session);
        if (!session) { (window.navigate && window.navigate('login')); return; }
        if (!confirm(`Acquistare ${plan.name} per ${formatMoney(plan.price)}?`)) return;
        // create purchase + device + earning similarly to previous flow but in a minimal, robust way
        try {
          if (window.txCol) await window.txCol.create({ user_id: session.id, type: 'purchase', amount: plan.price, created_at: new Date().toISOString(), note: `Acquisto ${plan.name}` });
          if (window.deviceCol) await window.deviceCol.create({ owner_id: session.id, name: plan.name, plan_key: plan.key, price: plan.price, tflops: plan.tflops, active: true, trial: false, purchased: true, non_returnable: true, daily_yield: +(plan.price * 0.011), created_at: new Date().toISOString(), last_accrual: new Date().toISOString() });
          if (window.txCol) await window.txCol.create({ user_id: session.id, type: 'earning', amount: +(plan.price * 0.011), created_at: new Date().toISOString(), note: `Rendimento ${plan.name}` });
        } catch(e){ console.warn('buy flow failed', e); }
        alert('Acquisto completato.');
        document.body.removeChild(overlay);
        (window.render && window.render());
      };
      const cancelBtn = document.createElement('button'); cancelBtn.className='btn'; cancelBtn.textContent='Annulla';
      cancelBtn.onclick = ()=>document.body.removeChild(overlay);
      modalActions.appendChild(buyBtn); modalActions.appendChild(cancelBtn);
      body.appendChild(modalActions);

      fs.appendChild(body);
      overlay.appendChild(fs);
      document.body.appendChild(overlay);
    }

    function renderGrid(){
      grid.innerHTML = '';
      const q = (searchInput.value || '').trim().toLowerCase();
      let visible = plans.slice();

      if (q) {
        visible = visible.filter(p => (p.name + ' ' + p.note + ' ' + p.tflops).toLowerCase().includes(q));
      }
      const mode = select.value;
      if (mode === 'price_asc') visible.sort((a,b)=>a.price-b.price);
      else if (mode === 'price_desc') visible.sort((a,b)=>b.price-a.price);
      else if (mode === 'tflops_desc') visible.sort((a,b)=>b.tflops-a.tflops);

      visible.forEach(p=>{
        const card = document.createElement('div'); card.className = 'hw-card';
        const left = document.createElement('div'); left.className = 'hw-left';
        const chip = document.createElement('div'); chip.className = 'hw-chip'; chip.textContent = `${p.tflops}T`;
        const meta = document.createElement('div'); meta.className = 'hw-meta';
        meta.appendChild(el('div.name', p.name));
        meta.appendChild(el('div.sub', `${p.note} · ${p.tflops} TFLOPS`));
        left.appendChild(chip); left.appendChild(meta);

        const right = document.createElement('div'); right.className = 'hw-right';
        const price = document.createElement('div'); price.className = 'price-badge'; price.textContent = formatMoney(p.price);
        const estDaily = +(p.price * 0.011).toFixed(2);
        const estMonthly = +(estDaily * 30).toFixed(2);
        right.appendChild(price);
        const stats = document.createElement('div'); stats.className = 'hw-stats';
        stats.textContent = `Stima: ${formatMoney(estDaily)} / giorno · ${formatMoney(estMonthly)} / mese`;
        right.appendChild(stats);

        const actions = document.createElement('div'); actions.className = 'hw-actions';
        const btnDetails = document.createElement('button'); btnDetails.className = 'btn'; btnDetails.textContent = 'Dettagli';
        btnDetails.onclick = ()=>openFullscreen(p);
        const btnBuy = document.createElement('button'); btnBuy.className = 'primary'; btnBuy.textContent = 'Acquista';
        btnBuy.onclick = async ()=>{
          const session = (window.getSession && window.getSession()) || (window.__cup9_session);
          if (!session) { (window.navigate && window.navigate('login')); return; }
          if (!confirm(`Acquistare ${p.name} per ${formatMoney(p.price)}?`)) return;
          try {
            if (window.txCol) await window.txCol.create({ user_id: session.id, type: 'purchase', amount: p.price, created_at: new Date().toISOString(), note: `Acquisto ${p.name}` });
            if (window.deviceCol) await window.deviceCol.create({ owner_id: session.id, name: p.name, plan_key: p.key, price: p.price, tflops: p.tflops, active: true, trial: false, purchased: true, non_returnable: true, daily_yield: +(p.price * 0.011), created_at: new Date().toISOString(), last_accrual: new Date().toISOString() });
            if (window.txCol) await window.txCol.create({ user_id: session.id, type: 'earning', amount: +(p.price * 0.011), created_at: new Date().toISOString(), note: `Rendimento ${p.name}` });
          } catch(e){ console.warn('buy flow failed', e); }
          alert('Acquisto completato: la GPU è attiva. Il costo è stato addebitato dal saldo spendibile.');
          (window.render && window.render());
        };

        actions.appendChild(btnDetails);
        actions.appendChild(btnBuy);
        right.appendChild(actions);

        chip.onclick = ()=>openFullscreen(p);

        card.appendChild(left);
        card.appendChild(right);
        grid.appendChild(card);
      });

      if (visible.length === 0) {
        const empty = document.createElement('div'); empty.className = 'empty-state';
        empty.textContent = 'Nessun piano corrisponde alla ricerca';
        grid.appendChild(empty);
      }
    }

    searchInput.addEventListener('input', ()=>renderGrid());
    select.addEventListener('change', ()=>renderGrid());

    page.appendChild(grid);
    renderGrid();
    page.appendChild(el('div.small','Le GPU acquistate appariranno in "My Devices". Le risorse sono permanenti e non restituibili.'));
    return page;
  };

  // myDevicesPage implementation (extracted)
  window.myDevicesPage = async function(){
    const wrap = document.createElement('div'); wrap.className='card';
    wrap.appendChild((function(){ const d=document.createElement('h3'); d.textContent='I miei dispositivi'; return d; })());
    const session = (window.getSession && window.getSession()) || (window.__cup9_session);
    const devList = (window.deviceCol && window.deviceCol.getList ? window.deviceCol.getList().filter(d=>d.owner_id===session.id) : []);
    const l = document.createElement('div'); l.className='list';
    if (devList.length===0) l.appendChild((function(){ const d=document.createElement('div'); d.className='small'; d.textContent='Nessun dispositivo attivo'; return d; })());
    devList.forEach(d=>{
      const r = document.createElement('div'); r.className='tx';
      const statusLabel = d.trial ? 'Trial' : (d.non_returnable ? 'Permanente' : 'Attivo');
      r.appendChild((function(){ const c=document.createElement('div'); c.appendChild((function(){ const t=document.createElement('div'); t.textContent=d.name; return t; })()); c.appendChild((function(){ const m=document.createElement('div'); m.className='meta'; m.textContent=statusLabel; return m; })()); return c; })());
      const right = document.createElement('div');
      right.appendChild((function(){ const v=document.createElement('div'); v.textContent= d.daily_yield ? formatMoney(d.daily_yield) : '-'; return v; })());

      const badge = document.createElement('div'); badge.className='small'; badge.textContent='Hardware permanente (non restituibile)';
      badge.style.fontWeight = '700';
      badge.style.color = 'var(--muted)';
      right.appendChild(badge);

      r.appendChild(right);
      l.appendChild(r);
    });
    wrap.appendChild(l);
    return wrap;
  };
})();