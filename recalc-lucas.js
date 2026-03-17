/*
 recalc-lucas.js — enhanced repair script: recalculates earnings for lucas@gmail.com and llollo@gmail.com,
 forces accreditation of earned amounts per owned device from purchase/assigned date until today by creating
 scheduled_earning (accredited) transactions, removes obvious duplicate accredited credits, rebuilds withdrawable
 store for each user, updates transactions store, and notifies the UI to refresh balances and recent actions.
 This runs once on load and is idempotent (tries to avoid double-applying corrections where possible).
 Additionally: removes duplicate claim transactions from lucas@gmail.com's recent activity, adjusts earnings map
 and persistent CUP9_USERS balance for any duplicated claim credits found, preserving idempotency.
*/
(function(){
  try{
    const TARGETS = ['lucas@gmail.com','llollo@gmail.com'];
    const TX_KEY = 'CUP9_TRANSACTIONS';
    const EARNINGS_KEY = 'CUP9_EARNINGS';
    const OWNED_KEY = 'CUP9_OWNED_GPUS';
    const USERS_KEY = 'CUP9_USERS';

    function readTxs(){ try{ return JSON.parse(localStorage.getItem(TX_KEY) || '[]'); }catch(e){ return []; } }
    function writeTxs(txs){ try{ localStorage.setItem(TX_KEY, JSON.stringify(txs||[])); }catch(e){} }
    function readEarnings(){ try{ return JSON.parse(localStorage.getItem(EARNINGS_KEY) || '{}'); }catch(e){ return {}; } }
    function writeEarnings(obj){ try{ localStorage.setItem(EARNINGS_KEY, JSON.stringify(obj||{})); }catch(e){} }
    function readOwned(){ try{ return JSON.parse(localStorage.getItem(OWNED_KEY) || '[]'); }catch(e){ return []; } }
    function readUsers(){ try{ return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); }catch(e){ return []; } }
    function writeUsers(u){ try{ localStorage.setItem(USERS_KEY, JSON.stringify(u||[])); }catch(e){} }

    function generateId(prefix='id'){ return prefix + Math.random().toString(36).slice(2,10); }

    // compute per-device daily earning using same heuristics as ui.js (conservative)
    function dailyForDevice(d){
      try{
        if(!d) return 0;
        if(d.meta && Number(d.meta.dailyEarnings)) return Number(d.meta.dailyEarnings);
        if(d.meta && Number(d.meta.purchase_price) && Number(d.meta.purchase_price) > 0) return Number((Number(d.meta.purchase_price) * 0.011).toFixed(4));
        if(Number(d.price_per_hour) && Number(d.price_per_hour) > 0) return Number(((Number(d.price_per_hour) * 24) * 0.011).toFixed(4));
        const t = Number((d.meta && d.meta.displayTflops) || 0);
        return t ? Number((t * 0.25).toFixed(4)) : 0;
      }catch(e){ return 0; }
    }

    // add a local transaction and apply withdrawable if appropriate (idempotent guard)
    function addTxAndCredit(tx){
      try{
        const all = readTxs();

        // idempotent: avoid creating duplicate tx by id
        if(all.find(x=>x.id === tx.id)) return;

        // simple duplicate scheduled_earning prevention (same gpu/day)
        try{
          const typ = String(tx.type||'').toLowerCase();
          const st = String(tx.status||'').toLowerCase();
          if(typ === 'scheduled_earning' && (st === 'accredited' || st === 'confirmed') && tx.meta && tx.meta.gpuId){
            const gpuId = String(tx.meta.gpuId || '');
            const createdDate = tx.created_at ? (new Date(tx.created_at)).toISOString().slice(0,10) : (new Date()).toISOString().slice(0,10);
            const duplicate = all.find(t => {
              try{
                const ttyp = String(t.type||'').toLowerCase();
                const tst = String(t.status||'').toLowerCase();
                if(ttyp !== 'scheduled_earning') return false;
                if(!(tst === 'accredited' || tst === 'confirmed')) return false;
                if(!(t.meta && String(t.meta.gpuId||'') === gpuId)) return false;
                const tDate = t.created_at ? (new Date(t.created_at)).toISOString().slice(0,10) : '';
                return tDate === createdDate;
              }catch(e){ return false; }
            });
            if(duplicate) return;
          }
        }catch(e){ console.error('addTxAndCredit dedupe pre-check error', e); }

        // append tx
        const before = readTxs();
        before.push(tx);
        writeTxs(before);

        // apply to earnings map if accredited-like
        try{
          const typ = String(tx.type||'').toLowerCase();
          const st = String(tx.status||'').toLowerCase();
          if((typ === 'scheduled_earning' || typ === 'earning' || typ === 'checkin' || typ === 'contract_dividend' || typ === 'claim') && (st === 'accredited' || st === 'confirmed')){
            const earnings = readEarnings();
            const em = String(tx.email||'').toLowerCase();
            earnings[em] = Number((Number(earnings[em]||0) + Number(tx.amount||0)).toFixed(4));
            writeEarnings(earnings);
            try{ if(window && window.notify) notify('balance:withdrawable:changed', { email: em, withdrawable: earnings[em] }); }catch(e){}
          }
        }catch(e){ console.error('addTxAndCredit apply earnings failed', e); }

        try{ if(window && window.notify) notify('tx:added', tx); }catch(e){}
      }catch(e){ console.error('addTxAndCredit failed', e); }
    }

    // remove duplicate accredited scheduled_earning txs for user to avoid double-crediting when forcing new credits
    function dedupeUserEarnings(userEmail){
      try{
        const all = readTxs();
        const out = [];
        const seen = new Set();
        for(const t of all){
          try{
            const e = String(t.email||'').toLowerCase();
            if(e !== userEmail){ out.push(t); continue; }
            const typ = String(t.type||'').toLowerCase();
            const st = String(t.status||'').toLowerCase();
            if((typ === 'scheduled_earning' || typ === 'earning' || typ === 'checkin' || typ === 'claim') && (st === 'accredited' || st === 'confirmed')){
              let key = (t.meta && t.meta._scheduleId) ? `sched|${t.meta._scheduleId}` : `${typ}|${Number(t.amount||0).toFixed(4)}|${t.created_at||''}`;
              if(seen.has(key)) continue;
              seen.add(key);
              out.push(t);
            } else {
              out.push(t);
            }
          }catch(e){ out.push(t); }
        }
        writeTxs(out);
      }catch(e){ console.error('dedupeUserEarnings failed', e); }
    }

    // Clean duplicate claim transactions for a specific user: remove claim txs that duplicate scheduled_earning/accredited for same gpu/date/amount
    // and adjust earnings map and persistent CUP9_USERS balance accordingly (idempotent via meta._removed_by_recalc).
    function removeDuplicateClaimsForUser(userEmail){
      try{
        const email = String(userEmail||'').toLowerCase();
        if(!email) return;
        const txs = readTxs();
        const earnings = readEarnings();
        const users = readUsers();

        // Build index of canonical accredited scheduled_earning by gpuId+date+amount
        const canonical = {};
        for(const t of txs){
          try{
            const typ = String(t.type||'').toLowerCase();
            const st = String(t.status||'').toLowerCase();
            if((typ === 'scheduled_earning' || typ === 'earning') && (st === 'accredited' || st === 'confirmed') && t.meta && t.meta.gpuId){
              const gpu = String(t.meta.gpuId || '');
              const date = t.created_at ? (new Date(t.created_at)).toISOString().slice(0,10) : '';
              const key = `${gpu}|${date}|${Number(t.amount||0).toFixed(4)}`;
              canonical[key] = canonical[key] || t;
            }
          }catch(e){}
        }

        let modified = false;
        const out = [];
        for(const t of txs){
          try{
            // skip non-claim or claims not for this user
            const typ = String(t.type||'').toLowerCase();
            if(typ !== 'claim' && typ !== 'claimed') { out.push(t); continue; }
            const tEmail = String(t.email||'').toLowerCase();
            if(tEmail !== email) { out.push(t); continue; }
            // idempotency: if we've already flagged this tx removed by recalc, skip removal
            if(t.meta && t.meta._removed_by_recalc) {
              // keep record but do not count it
              out.push(t);
              continue;
            }
            // Attempt to identify matching canonical scheduled_earning
            const gpu = t.meta && t.meta.gpuId ? String(t.meta.gpuId) : null;
            const date = t.created_at ? (new Date(t.created_at)).toISOString().slice(0,10) : '';
            const key = gpu ? `${gpu}|${date}|${Number(t.amount||0).toFixed(4)}` : null;
            if(key && canonical[key]){
              // This claim duplicates a canonical scheduled_earning: remove the claim tx (i.e., do not include it in out)
              // but before removing deduce its amount from earnings map and persistent CUP9_USERS balance if it was previously applied.
              try{
                // If earnings map for user includes this amount, subtract it (clamp >=0)
                if(Number(t.amount) && earnings[email]){
                  earnings[email] = Number(Math.max(0, Number(earnings[email]||0) - Number(t.amount || 0)).toFixed(4));
                }
                // Also adjust persistent CUP9_USERS balance if user record exists and shows this amount as part of balance (best-effort)
                try{
                  const idx = users.findIndex(u=> String(u.email||'').toLowerCase() === email);
                  if(idx !== -1 && Number(users[idx].balance)){
                    // subtract the duplicated amount but do not go negative
                    users[idx].balance = Number(Math.max(0, Number(users[idx].balance || 0) - Number(t.amount || 0)).toFixed(4));
                  }
                }catch(e){}
                // mark removal for telemetry - keep a tombstone entry of the claim with meta flag instead of full deletion for traceability
                const tomb = Object.assign({}, t);
                tomb.meta = tomb.meta || {};
                tomb.meta._removed_by_recalc = true;
                tomb.meta._removed_reason = 'duplicate_claim_normalized';
                tomb.meta._removed_at = new Date().toISOString();
                out.push(tomb);
                modified = true;
                continue; // skip pushing original claim
              }catch(e){
                // on any error fall back to keeping the claim to avoid data loss
                out.push(t);
                continue;
              }
            } else {
              // no canonical match — keep claim as-is
              out.push(t);
            }
          }catch(e){
            out.push(t);
          }
        }

        if(modified){
          writeTxs(out);
          writeEarnings(earnings);
          writeUsers(users);
          try{ if(window && window.notify) notify('tx:changed', readTxs()); }catch(e){}
          try{ if(window && window.notify) notify('balance:withdrawable:changed', { email, withdrawable: readEarnings()[email]||0 }); }catch(e){}
          try{ if(window && window.toastMessage) toastMessage(`Duplicati CLAIM rimossi per ${email} e saldi aggiornati`, { type:'success', duration:5000 }); }catch(e){}
        }
      }catch(e){ console.error('removeDuplicateClaimsForUser failed', e); }
    }

    // main recalculation: for a target user, compute days since purchase for each owned device and create one aggregated
    // scheduled_earning (accredited) tx per device representing all earnings from purchase up to today, unless identical tx already exists.
    function forceRecalcAndCredit(userEmail){
      try{
        const email = String(userEmail||'').toLowerCase();
        if(!email) return;
        // 1) dedupe user existing earnings to reduce duplicates first
        dedupeUserEarnings(email);

        // 2) gather owned devices for email
        const owned = readOwned() || [];
        const devices = owned.filter(g=>{
          try{
            const ownerEmail = (g.meta && g.meta.ownerEmail) ? String(g.meta.ownerEmail).toLowerCase() : '';
            return ownerEmail === email;
          }catch(e){ return false; }
        });

        // 3) for each device compute days since assigned/purchase and credit total (daily * days)
        const now = Date.now();
        for(const d of devices){
          try{
            // determine start date: prefer assigned_at, then meta.start_at/activated_at, then look for a purchase tx
            let startAt = null;
            if(d.assigned_at) startAt = d.assigned_at;
            if(!startAt && d.meta){
              startAt = d.meta.activated_at || d.meta.start_at || startAt;
            }
            if(!startAt){
              // fallback: find a purchase tx in transactions
              const txs = readTxs();
              const purchaseTx = txs.find(t=>{
                try{
                  return String(t.type||'').toLowerCase() === 'purchase' &&
                         String(t.email||'').toLowerCase() === email &&
                         t.meta && (String(t.meta.gpuId || '') === String(d.id) || String(t.meta.deviceName || '') === String(d.name));
                }catch(e){ return false; }
              });
              if(purchaseTx) startAt = purchaseTx.created_at;
            }
            if(!startAt) {
              // If still no start date, skip this device (cannot compute)
              continue;
            }
            const startMs = new Date(startAt).getTime();
            if(isNaN(startMs) || startMs > now) continue;
            const days = Math.floor((now - startMs) / (24*60*60*1000));
            if(days <= 0) continue;

            const daily = dailyForDevice(d) || 0;
            const total = Number((daily * days).toFixed(4));
            if(!total || total <= 0) continue;

            // ensure we don't duplicate an identical scheduled_earning already credited for same device/date range:
            // Additionally, if an existing scheduled_earning exists for the same gpu+date but with a DIFFERENT amount,
            // remove that incorrect entry so we can replace it with the correct per-day daily amount.
            const allTx = readTxs();
            // look for any exact-match (same amount) first
            const existingSame = allTx.find(t=>{
              try{
                const typ = String(t.type||'').toLowerCase();
                const st = String(t.status||'').toLowerCase();
                if(!(typ === 'scheduled_earning' || typ === 'earning')) return false;
                if(!(st === 'accredited' || st === 'confirmed')) return false;
                if(!(t.meta && (String(t.meta.gpuId||'') === String(d.id) || String(t.meta._scheduleId||'') === String(d.meta && d.meta._scheduleId || '')))) return false;
                if(Number(t.amount || 0).toFixed(4) === Number(total).toFixed(4)) return true;
                return false;
              }catch(e){ return false; }
            });
            if(existingSame) continue;

            // If a conflicting scheduled_earning exists for the same gpu+date but with a different amount, remove it (idempotent)
            try{
              const createdDate = (new Date()).toISOString().slice(0,10);
              const conflicting = allTx.filter(t=>{
                try{
                  const typ = String(t.type||'').toLowerCase();
                  const st = String(t.status||'').toLowerCase();
                  if(!(typ === 'scheduled_earning' || typ === 'earning')) return false;
                  if(!(st === 'accredited' || st === 'confirmed')) return false;
                  if(!(t.meta && String(t.meta.gpuId||'') === String(d.id))) return false;
                  const tDate = t.created_at ? (new Date(t.created_at)).toISOString().slice(0,10) : '';
                  return tDate === createdDate && Number(t.amount || 0).toFixed(4) !== Number(dailyForDevice(d) || 0).toFixed(4);
                }catch(e){ return false; }
              });
              if(conflicting && conflicting.length){
                // remove conflicting entries and adjust earnings map conservatively
                let txs = readTxs();
                for(const bad of conflicting){
                  try{
                    // mark tombstone rather than hard-delete for audit: set meta._removed_by_recalc and status 'removed'
                    const idx = txs.findIndex(x=>x.id === bad.id);
                    if(idx !== -1){
                      txs[idx].meta = txs[idx].meta || {};
                      txs[idx].meta._removed_by_recalc = true;
                      txs[idx].meta._removed_reason = 'amount_mismatch_normalized';
                      txs[idx].meta._removed_at = new Date().toISOString();
                      txs[idx].status = 'removed';
                    }
                    // Also deduct previously applied earnings from earnings map if they were applied before (best-effort)
                    try{
                      const earnings = readEarnings();
                      const em = String(bad.email || '').toLowerCase();
                      if(em && Number(bad.amount || 0)){
                        earnings[em] = Number(Math.max(0, Number(earnings[em] || 0) - Number(bad.amount || 0)).toFixed(8));
                        writeEarnings(earnings);
                        try{ if(window && window.notify) notify('balance:withdrawable:changed', { email: em, withdrawable: earnings[em] }); }catch(e){}
                      }
                    }catch(e){}
                  }catch(e){}
                }
                // persist tombstoned txs back
                writeTxs(txs);
              }
            }catch(e){
              console.error('conflicting scheduled_earning normalization failed', e);
            }

            // create one accredited scheduled_earning per day (idempotent): each tx id is deterministic per device+date
            try{
              const daily = Number(dailyForDevice(d)) || 0;
              if(!daily || daily <= 0) continue;
              // for each day since start, create an individual accredited tx using deterministic id tx_auto_{gpuId}_{YYYY-MM-DD}
              for(let dayIndex = 0; dayIndex < days; dayIndex++){
                try{
                  const dt = new Date(startMs + dayIndex * 24*60*60*1000);
                  const dateKey = dt.toISOString().slice(0,10); // YYYY-MM-DD
                  const deterministicId = `tx_auto_${String(d.id)}_${dateKey}`;
                  // idempotent: skip if a tx with that id already exists
                  const exists = readTxs().find(t => String(t.id) === deterministicId || (t.meta && t.meta._auto_key === deterministicId));
                  if(exists) continue;
                  const txDay = {
                    id: deterministicId,
                    type: 'scheduled_earning',
                    amount: Number(daily),
                    created_at: new Date(dt).toISOString(),
                    status: 'accredited',
                    email: email,
                    meta: { _fromRecalc:true, _force_auto_apply:true, gpuId: d.id || null, purchase_start_at: startAt, _auto_key: deterministicId, _credited_day_index: dayIndex + 1 }
                  };
                  addTxAndCredit(txDay);
                }catch(e){}
              }
            }catch(e){ console.error('create per-day scheduled_earning failed', e); }

            // update per-device accounting summary into device.meta for UI: store number of accredited payouts received
            try{
              const ownedAll = readOwned();
              const idx = ownedAll.findIndex(x=>String(x.id) === String(d.id));
              if(idx !== -1){
                ownedAll[idx].meta = ownedAll[idx].meta || {};
                ownedAll[idx].meta.accredited_count = Number(ownedAll[idx].meta.accredited_count || 0) + Number(days);
                ownedAll[idx].meta.last_accredited_at = new Date().toISOString();
                localStorage.setItem(OWNED_KEY, JSON.stringify(ownedAll));
              }
            }catch(e){ console.error('persist per-device accredited_count failed', e); }

          }catch(e){ console.error('device loop error', e); }
        }

        // after forcing credits, recompute withdrawable authoritative sum from accredited txs
        try{
          const all = readTxs();
          let sum = 0;
          for(const t of all){
            try{
              const te = String(t.email||'').toLowerCase();
              if(te !== email) continue;
              const typ = String(t.type||'').toLowerCase();
              const st = String(t.status||'').toLowerCase();
              if((typ === 'earning' || typ === 'scheduled_earning' || typ === 'checkin' || typ === 'contract_dividend' || typ === 'claim') && (st === 'accredited' || st === 'confirmed')){
                sum += Number(t.amount || 0);
              }
            }catch(e){}
          }
          const earnings = readEarnings();
          earnings[email] = Number(sum.toFixed(4));
          writeEarnings(earnings);
        }catch(e){ console.error('recompute withdrawable failed', e); }

        // final notifications
        try{ if(window && window.notify) notify('tx:changed', readTxs()); }catch(e){}
        try{ if(window && window.notify) notify('balance:withdrawable:changed', { email, withdrawable: readEarnings()[email] || 0 }); }catch(e){}
        try{ if(window && window.notify) notify('balance:changed', { email, balance: readEarnings()[email] || 0 }); }catch(e){}
        try{ if(window && window.toastMessage) toastMessage(`Ricalcolo e accredito forzato completato per ${email}`, { type:'success', duration:5000 }); }catch(e){}
      }catch(e){
        console.error('forceRecalcAndCredit failed', e);
      }
    }

    // Run recalculation for each configured target: first dedupe/clean, then force credit from devices
    for(const TARGET of TARGETS){
      try{
        (function initialClean(){
          try{
            const txs = readTxs();
            const filtered = [];
            const seen = new Set();
            for(const t of txs){
              try{
                const key = `${String(t.type||'')}|${String(t.email||'')}|${Number(t.amount||0).toFixed(4)}|${t.created_at||''}`;
                if(seen.has(key) && (String(t.type||'').toLowerCase() !== 'deposit')) continue;
                seen.add(key);
                filtered.push(t);
              }catch(e){ filtered.push(t); }
            }
            writeTxs(filtered);
          }catch(e){ console.error('initialClean failed', e); }
        })();

        forceRecalcAndCredit(TARGET);

        // Additional step: for lucas, remove duplicate claim transactions and adjust earnings and persistent balance
        if(String(TARGET).toLowerCase() === 'lucas@gmail.com'){
          removeDuplicateClaimsForUser(TARGET);
        }

      }catch(e){ console.error('per-target run failed', TARGET, e); }
    }

  }catch(err){
    try{ console.error('recalc-lucas batch failed', err); if(window && window.toastMessage) toastMessage('Errore ricalcolo utenti', { type:'error' }); }catch(e){}
  }
})();