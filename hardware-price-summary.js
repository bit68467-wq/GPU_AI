/*
 hardware-price-summary.js — injects a compact price summary to the bottom of the Hardware page
 - Persists the price list to localStorage key 'CUP9_HARDWARE_PRICE_SUMMARY'
 - Inserts a small responsive summary footer inside #page-hardware when that section is rendered
 - Non-invasive: runs after DOM load and observes mutations to catch SPA render
*/
(function(){
  const KEY = 'CUP9_HARDWARE_PRICE_SUMMARY';
  const prices = [
    { name: 'Tier Mini', tier: 'Tier Mini', price: '$10 - $60' },
    { name: 'Starter Plus', tier: 'Tier A', price: '$160' },
    { name: 'Value Compute', tier: 'Tier B', price: '$220' },
    { name: 'Compute Classic', tier: 'Tier C', price: '$380' },
    { name: 'Performance', tier: 'Tier D', price: '$700' },
    { name: 'Pro AI', tier: 'Tier E', price: '$1.350' },
    { name: 'Enterprise +', tier: 'Tier F', price: '$2.700' },
    { name: 'Ultra Enterprise', tier: 'Tier G', price: '$3.650' }
  ];

  try{
    localStorage.setItem(KEY, JSON.stringify(prices));
  }catch(e){ /* non-fatal if storage fails */ }

  function buildSummaryHtml(){
    const rows = prices.map(p=> `<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 8px;border-bottom:1px solid rgba(0,0,0,0.04)"><div style="font-weight:800;color:#03181d">${escapeHtml(p.name)}</div><div style="font-weight:900;color:#b98f46">${escapeHtml(p.price)}</div></div>`).join('');
    return `
      <div id="cup9-hardware-price-summary" style="margin-top:14px;padding:12px;border-radius:10px;background:linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,250,255,0.98));box-shadow:0 12px 34px rgba(6,28,48,0.06);border:1px solid rgba(19,120,184,0.04)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-weight:900;color:#03181d">Riepilogo prezzi dispositivi</div>
          <div class="small" style="color:var(--muted)">Prezzi indicativi</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">${rows}</div>
      </div>
    `;
  }

  function injectIfHardware(){
    try{
      const sec = document.getElementById('page-hardware');
      if(!sec) return;
      // avoid duplicate injection
      if(document.getElementById('cup9-hardware-price-summary')) return;
      // append summary at the bottom of the hardware section
      sec.insertAdjacentHTML('beforeend', buildSummaryHtml());
    }catch(e){}
  }

  document.addEventListener('DOMContentLoaded', injectIfHardware);
  // run shortly after in case SPA already rendered
  setTimeout(injectIfHardware, 300);
  // observe SPA DOM changes to inject when the hardware page appears
  const mo = new MutationObserver(()=> injectIfHardware());
  mo.observe(document.body, { childList:true, subtree:true });

  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
})();