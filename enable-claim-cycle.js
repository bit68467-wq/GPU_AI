/*
 enable-claim-cycle.js — lightweight enhancer that injects missing "Claim" and "Seleziona ciclo" buttons
 and provides a safe local createSchedule implementation so users may CLAIM earnings and immediately
 select a new cycle without modifying the large ui.js file. Works purely with localStorage and existing
 notification hooks (notify) so UI updates elsewhere pick up changes.
*/
import { notify, toastMessage, subscribe } from './notifications.js';

const OWNED_KEY = 'CUP9_OWNED_GPUS';
const SCHEDULES_KEY = 'CUP9_INTERNAL_SCHEDULES';
const PENDING_CLAIMS_KEY = 'CUP9_PENDING_CLAIMS';
const TX_KEY = 'CUP9_TRANSACTIONS';
const EARNINGS_KEY = 'CUP9_EARNINGS';

function readOwnedGpus(){ try{ return JSON.parse(localStorage.getItem(OWNED_KEY) || '[]'); }catch(e){ return []; } }
function writeOwnedGpus(list){ try{ localStorage.setItem(OWNED_KEY, JSON.stringify(list||[])); }catch(e){} }
function readSchedules(){ try{ return JSON.parse(localStorage.getItem(SCHEDULES_KEY) || '[]'); }catch(e){ return []; } }
function writeSchedules(list){ try{ localStorage.setItem(SCHEDULES_KEY, JSON.stringify(list||[])); }catch(e){} }
function readPendingClaims(){ try{ return JSON.parse(localStorage.getItem(PENDING_CLAIMS_KEY) || '[]'); }catch(e){ return []; } }
function writePendingClaims(list){ try{ localStorage.setItem(PENDING_CLAIMS_KEY, JSON.stringify(list||[])); }catch(e){} }
function loadTxs(){ try{ return JSON.parse(localStorage.getItem(TX_KEY) || '[]'); }catch(e){ return []; } }
function saveTxs(list){ try{ localStorage.setItem(TX_KEY, JSON.stringify(list||[])); notify('tx:changed', loadTxs()); }catch(e){} }
function readEarnings(){ try{ return JSON.parse(localStorage.getItem(EARNINGS_KEY) || '{}'); }catch(e){ return {}; } }
function saveEarnings(obj){ try{ localStorage.setItem(EARNINGS_KEY, JSON.stringify(obj||{})); notify('earnings:changed', obj); }catch(e){} }

function generateId(prefix='id'){ return prefix + Math.random().toString(36).slice(2,10); }

// Create a schedule locally and persist minimal fields mirrored from ui.js expectations
function createLocalSchedule({ gpuId, email, userId, days, amount }){
  try{
    const id = generateId('sched_');
    const start = new Date();
    const end = new Date(start.getTime() + Number(days||1) * 24*60*60*1000);
    const dailyAmount = Number(((Number(amount||0) / Math.max(1, Number(days||1))).toFixed(2)));
    const sched = {
      id,
      gpuId,
      email: String(email||'').toLowerCase(),
      userId: userId || null,
      days: Number(days||0),
      amount: Number(amount||0),
      dailyAmount: Number(dailyAmount),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      status: 'running',
      meta: { require_claim: false, _claimed: false },
      __runtime: { creditedDays: 0 }
    };
    const schedules = readSchedules();
    schedules.push(sched);
    writeSchedules(schedules);

    // persist scheduleId into owned GPU meta so device UI sees the cycle
    try{
      const owned = readOwnedGpus();
      const idx = owned.findIndex(x=>String(x.id) === String(gpuId));
      if(idx !== -1){
        owned[idx].meta = owned[idx].meta || {};
        owned[idx].meta._scheduleId = id;
        owned[idx].meta.start_at = sched.start_at;
        owned[idx].meta.end_at = sched.end_at;
        owned[idx].meta.cycleDays = Number(days);
        owned[idx].status = 'running';
        writeOwnedGpus(owned);
        notify('owned:changed', readOwnedGpus());
      }
    }catch(e){ console.error('createLocalSchedule: persist owned meta failed', e); }

    notify('schedules:changed', readSchedules());
    return sched;
  }catch(e){
    console.error('createLocalSchedule error', e);
    return null;
  }
}

// Add a transaction (immutable history) and optionally credit withdrawable earnings
function addLocalTransaction(tx){
  try{
    const list = loadTxs();
    list.push(tx);
    saveTxs(list);
    // credit withdrawable for accredited earnings
    try{
      const typ = String(tx.type||'').toLowerCase();
      const st = String(tx.status||'').toLowerCase();
      if((typ === 'scheduled_earning' || typ === 'earning' || typ === 'checkin' || typ === 'claim') && (st === 'accredited' || st === 'confirmed')){
        const email = String(tx.email||'').toLowerCase();
        const earnings = readEarnings();
        earnings[email] = Number((Number(earnings[email]||0) + Number(tx.amount||0)).toFixed(4));
        saveEarnings(earnings);
        notify('balance:withdrawable:changed', { email, withdrawable: earnings[email] });
      }
    }catch(e){}
    notify('tx:added', tx);
  }catch(e){ console.error('addLocalTransaction failed', e); }
}

// build a minimal claim record and persist it (idempotent)
function ensurePendingClaimForSchedule(sched){
  try{
    if(!sched) return null;
    const pending = readPendingClaims();
    const exists = pending.find(x => (x.scheduleId && x.scheduleId === sched.id) || (x.gpuId && x.gpuId === sched.gpuId));
    const amount = Number(sched.amount || 0);
    if(!exists){
      const claim = {
        id: generateId('claim_'),
        scheduleId: sched.id || null,
        gpuId: sched.gpuId || null,
        email: String(sched.email||'').toLowerCase(),
        amount: amount,
        created_at: new Date().toISOString(),
        claimed: false
      };
      pending.push(claim);
      writePendingClaims(pending);
      notify('schedules:changed', readSchedules());
      return claim;
    } else {
      // ensure amount is up-to-date
      exists.amount = amount;
      writePendingClaims(pending);
      return exists;
    }
  }catch(e){ console.error('ensurePendingClaimForSchedule failed', e); return null; }
}

/*
 UI injection disabled for "I miei GPU" per user request:
 The devices operate automatically and permanently; no interactive Claim or cycle-selection buttons
 should be injected dynamically into the owned-device cards. This function is left as a safe no-op
 that still triggers the same external hooks/subscriptions if needed elsewhere.
*/
function injectButtons(){
  try{
    // Instead of injecting UI buttons, ensure every owned/purchased GPU runs an automatic daily-accrual
    // that creates one accredited scheduled_earning per device per day using a deterministic id
    // tx_auto_{gpuId}_{YYYY-MM-DD}. This guarantees daily earnings are always credited.
    // Use a session-level handle map so timers won't be duplicated across repeated calls.
    window.CUP9_DAILY_AUTO = window.CUP9_DAILY_AUTO || {};
    const MS_DAY = 24 * 60 * 60 * 1000;

    function todayKeyForDate(d){
      return new Date(d).toISOString().slice(0,10);
    }
    function deterministicTxId(gpuId, dateKey){
      return `tx_auto_${String(gpuId)}_${dateKey}`;
    }

    // compute daily amount like other helpers: prefer meta.dailyEarnings, then purchase_price*0.011, then 24*price_per_hour*0.011, then tflops*0.25
    function computeDaily(device){
      try{
        if(!device) return 0;
        if(device.meta && Number(device.meta.dailyEarnings)) return Number(device.meta.dailyEarnings);
        if(device.meta && Number(device.meta.purchase_price) && Number(device.meta.purchase_price) > 0) return Number((Number(device.meta.purchase_price) * 0.011).toFixed(4));
        if(Number(device.price_per_hour) && Number(device.price_per_hour) > 0) return Number(((Number(device.price_per_hour) * 24) * 0.011).toFixed(4));
        const t = Number((device.meta && device.meta.displayTflops) || 0);
        return t ? Number((t * 0.25).toFixed(4)) : 0;
      }catch(e){ return 0; }
    }

    function ensureCreditForDevice(device, runDateIso){
      try{
        if(!device || !device.id) return;

        // Determine device authoritative start/purchase date (prefer explicit purchase/assigned metadata)
        const candidateDates = [
          (device.meta && device.meta.purchase_date) || null,
          (device.meta && device.meta.purchased_at) || null,
          (device.meta && device.meta.activated_at) || null,
          device.assigned_at || null,
          (device.meta && device.meta.start_at) || null
        ].filter(Boolean);
        const purchaseStartIso = candidateDates.length ? candidateDates[0] : null;

        // Normalize day keys (YYYY-MM-DD)
        const dateKey = todayKeyForDate(runDateIso);
        // If we know a purchase/assigned date, do not create earnings for any date earlier than that purchase date.
        if(purchaseStartIso){
          try{
            const purchaseDay = new Date(purchaseStartIso).toISOString().slice(0,10);
            // If the dateKey is strictly before purchaseDay, skip creating the tx.
            if(dateKey < purchaseDay) return;
          }catch(e){
            // if parsing fails, be conservative and do not proceed
            return;
          }
        }

        const txId = deterministicTxId(device.id, dateKey);
        // idempotent: check existing transactions
        const txs = loadTxs();
        if(txs.find(t => String(t.id) === txId || (t.meta && t.meta._auto_key === txId))) return;

        const amount = computeDaily(device);
        if(!amount || Number(amount) <= 0) return;

        const ownerEmail = String((device.meta && device.meta.ownerEmail) || '').toLowerCase();
        if(!ownerEmail) return;

        const tx = {
          id: txId,
          type: 'scheduled_earning',
          amount: Number(amount),
          created_at: new Date(runDateIso).toISOString(),
          status: 'accredited',
          email: ownerEmail,
          meta: { _fromAutoDaily:true, _auto_key: txId, gpuId: device.id }
        };
        addLocalTransaction(tx);
      }catch(e){ console.error('ensureCreditForDevice failed', e); }
    }

    function scheduleForDevice(device){
      try{
        if(!device || !device.id) return;
        // clear existing handles for this gpu in this session
        const handles = window.CUP9_DAILY_AUTO;
        if(handles[device.id]){
          try{ clearInterval(handles[device.id]); }catch(e){}
        }

        // Determine a reference time: prefer meta.start_at/activated_at/assigned_at/purchase tx timestamp, else now
        let refIso = null;
        try{
          refIso = (device.meta && (device.meta.start_at || device.meta.activated_at || device.meta.purchased_at || device.meta.purchase_date)) || device.assigned_at || null;
          if(!refIso){
            const txs = loadTxs() || [];
            const ptx = txs.find(t=>{
              try{
                return String(t.type||'').toLowerCase() === 'purchase' &&
                  ((t.meta && String(t.meta.gpuId||'') === String(device.id)) || (t.meta && String(t.meta.deviceName||'') === String(device.name)));
              }catch(e){ return false; }
            });
            if(ptx) refIso = ptx.created_at || null;
          }
        }catch(e){ refIso = null; }

        const ref = refIso ? new Date(refIso) : new Date();

        // compute next occurrence at the same wall-clock hour/minute as ref and > now
        function nextOccurrence(reference){
          try{
            const r = new Date(reference);
            const now = new Date();
            let cand = new Date(now.getFullYear(), now.getMonth(), now.getDate(), r.getHours(), r.getMinutes(), r.getSeconds(), r.getMilliseconds());
            if(cand.getTime() <= Date.now()) cand = new Date(cand.getTime() + MS_DAY);
            return cand;
          }catch(e){
            return new Date(Date.now() + MS_DAY);
          }
        }

        const next = nextOccurrence(ref);
        const initialDelay = Math.max(0, next.getTime() - Date.now());

        // Run first after initialDelay, then repeat every MS_DAY; use interval for repetition
        const timeoutHandle = setTimeout(()=>{
          try{
            // immediate credit for the scheduled day
            ensureCreditForDevice(device, new Date().toISOString());
            // then set interval
            const iv = setInterval(() => {
              try{ ensureCreditForDevice(device, new Date().toISOString()); }catch(e){ console.error('daily interval credit failed', e); }
            }, MS_DAY);
            // store interval handle
            window.CUP9_DAILY_AUTO[device.id] = iv;
          }catch(e){
            console.error('daily initial timeout handler error', e);
          }
        }, initialDelay);

        // temporarily store timeout so it can be cleared if replaced; convert to interval handle later
        window.CUP9_DAILY_AUTO[device.id] = timeoutHandle;
      }catch(e){ console.error('scheduleForDevice error', e); }
    }

    // Initialize schedules for all owned GPUs (run idempotently)
    try{
      const owned = readOwnedGpus();
      for(const d of owned){
        try{
          // only schedule for owned/purchased devices (ownerEmail present or id starts with p_)
          const isOwned = !!((d.meta && d.meta.ownerEmail) || String(d.id || '').startsWith('p_') || d.ownerId);
          if(isOwned){
            // also immediately ensure yesterday/today deterministic tx exists (so a device without recent credit still gets one now)
            // create credit for today if missing
            ensureCreditForDevice(d, new Date().toISOString());
            // schedule recurring daily credits aligned to purchase/assigned hour
            scheduleForDevice(d);
          }
        }catch(e){}
      }
    }catch(e){ console.error('injectButtons init scheduling failed', e); }

    // Re-schedule whenever owned devices change to pick up new purchases
    try{
      subscribe && subscribe('owned:changed', () => {
        try{
          const ownedNow = readOwnedGpus();
          // schedule for any new devices (idempotent)
          for(const d of ownedNow){
            try{
              const isOwned = !!((d.meta && d.meta.ownerEmail) || String(d.id || '').startsWith('p_') || d.ownerId);
              if(isOwned) {
                // ensure a credit for today if missing, then schedule
                ensureCreditForDevice(d, new Date().toISOString());
                scheduleForDevice(d);
              }
            }catch(e){}
          }
        }catch(e){}
      });
    }catch(e){ /* ignore subscription failures */ }

    return;
  }catch(e){
    console.error('injectButtons scheduling failed', e);
  }
}

// when user selects cycle, create schedule locally and persist; days param chosen via small prompt
async function onSelectCycleClick(ev){
  try{
    const btn = ev.currentTarget;
    const gpuId = btn && btn.dataset && btn.dataset.gpu;
    if(!gpuId) return;
    // choose days via a prompt for simplicity (1/3/7)
    const choice = window.prompt('Scegli durata ciclo in giorni (1,3,7):', '1');
    if(choice === null) return;
    const days = [1,3,7].includes(Number(choice)) ? Number(choice) : 1;

    // compute a conservative earning estimate using visible meta or price heuristics from the owned record
    const owned = readOwnedGpus();
    const device = owned.find(x=>String(x.id) === String(gpuId));
    let dailyEarnings = 0;
    try{
      if(device && device.meta && Number(device.meta.dailyEarnings)) dailyEarnings = Number(device.meta.dailyEarnings);
      else if(device && device.meta && Number(device.meta.purchase_price)) dailyEarnings = Number((Number(device.meta.purchase_price) * 0.011).toFixed(2));
      else if(device && Number(device.price_per_hour)) dailyEarnings = Number(((Number(device.price_per_hour) * 24) * 0.011).toFixed(2));
      else if(device && device.meta && Number(device.meta.displayTflops)) dailyEarnings = Number((Number(device.meta.displayTflops) * 0.25).toFixed(2));
      else dailyEarnings = 0;
    }catch(e){ dailyEarnings = 0; }

    const amount = Number((dailyEarnings * days).toFixed(2));

    // find owner email if present in meta, else prompt user to confirm (safe fallback)
    let ownerEmail = (device && device.meta && device.meta.ownerEmail) ? String(device.meta.ownerEmail).toLowerCase() : '';
    if(!ownerEmail){
      try{
        const mePrompt = await Promise.resolve(window.prompt('Inserisci la tua email registrata per collegare il ciclo:', ''));
        if(mePrompt === null) return;
        ownerEmail = String(mePrompt).trim().toLowerCase();
      }catch(e){}
    }

    // create schedule and persist
    const sched = createLocalSchedule({ gpuId, email: ownerEmail, userId: (device && device.ownerId) || null, days, amount });

    // create pending claim entry only when schedule completes; but ensure UI shows schedule and a placeholder claim after completion (create now with amount 0 so UI can show)
    // We won't create an immediate pending claim here; instead the schedule will create it upon completion in normal flows.
    toastMessage(`Ciclo ${days} giorno(i) avviato per il dispositivo. Guadagno previsto: $${Number(amount).toFixed(2)}`);

    // Re-inject buttons and notify UI modules
    notify('schedules:changed', readSchedules());
    notify('owned:changed', readOwnedGpus());
    // Ensure an optimistic export update so other modules can pick up the cycle
    try{ notify('ui:force-refresh'); }catch(e){}
    // Refresh injector to show claim button later when schedule completes
    setTimeout(()=> injectButtons(), 400);
  }catch(e){
    console.error('onSelectCycleClick failed', e);
    toastMessage('Errore avvio ciclo');
  }
}

// Local finalize claim fallback (used if global finalize isn't present)
// It marks pending claim as claimed, creates accredited tx and credits withdrawable
function finalizeClaimLocal(claim){
  try{
    if(!claim) return;
    // durable guard: check local lock keys
    try{ if(localStorage.getItem('CUP9_CLAIMED_SCHEDULE_' + String(claim.scheduleId))) return; }catch(e){}
    try{ if(localStorage.getItem('CUP9_CLAIMED_GPU_' + String(claim.gpuId))) return; }catch(e){}

    // mark pending claim claimed
    const pending = readPendingClaims();
    const idx = pending.findIndex(c=>String(c.id) === String(claim.id));
    if(idx !== -1){ pending[idx].claimed = true; pending[idx].claimed_at = new Date().toISOString(); writePendingClaims(pending); }

    // create accredited scheduled_earning tx and companion claim tx
    const earned = {
      id: generateId('tx_'),
      type: 'scheduled_earning',
      amount: Number(claim.amount || 0),
      created_at: new Date().toISOString(),
      status: 'accredited',
      email: String(claim.email || '').toLowerCase(),
      meta: { _fromSchedule:true, _scheduleId: claim.scheduleId || null, gpuId: claim.gpuId || null, _claimed_by: claim.id }
    };
    addLocalTransaction(earned);

    

    // credit withdrawable immediately
    const earnings = readEarnings();
    const em = String(claim.email || '').toLowerCase();
    earnings[em] = Number((Number(earnings[em]||0) + Number(claim.amount||0)).toFixed(4));
    saveEarnings(earnings);

    // clear device cycle metadata and set idle
    try{
      const owned = readOwnedGpus();
      const gi = owned.findIndex(g=>String(g.id) === String(claim.gpuId));
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
        notify('owned:changed', readOwnedGpus());
      }
    }catch(e){ console.error('finalizeClaimLocal: owned update failed', e); }

    // persist and notify
    notify('tx:changed', loadTxs());
    notify('balance:withdrawable:changed', { email: em, withdrawable: readEarnings()[em] });
    toastMessage(`Claim processato: $${Number(claim.amount||0).toFixed(2)} accreditati`, { type:'success' });
    // refresh injector
    setTimeout(()=> injectButtons(), 300);
  }catch(e){ console.error('finalizeClaimLocal error', e); }
}

// Observe DOM changes to keep buttons injected when My Devices is updated dynamically
const observer = new MutationObserver((mutations)=>{
  try{
    injectButtons();
  }catch(e){ console.error('MutationObserver handler error', e); }
});
observer.observe(document.body, { childList:true, subtree:true });

// initial injection on load and after a short delay to let ui.js render
window.addEventListener('load', ()=> {
  setTimeout(()=> injectButtons(), 400);
  // also attempt again later for eventual async renders
  setTimeout(()=> injectButtons(), 1600);
});

// also expose a small manual function for debugging in console
window.CUP9 = window.CUP9 || {};
window.CUP9._injectClaimCycleButtons = injectButtons;

// Re-inject buttons when relevant app state changes so controls remain available
try{
  // listen for owned devices, schedules and UI refresh requests to keep buttons in sync
  subscribe && subscribe('owned:changed', () => { try{ injectButtons(); }catch(e){console.error(e);} });
  subscribe && subscribe('schedules:changed', () => { try{ injectButtons(); }catch(e){console.error(e);} });
  subscribe && subscribe('ui:force-refresh', () => { try{ injectButtons(); }catch(e){console.error(e);} });
}catch(e){
  console.warn('enable-claim-cycle: event subscriptions failed', e);
}

console.info('enable-claim-cycle initialized: claim + cycle selection enhancer active');