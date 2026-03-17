/*
 profile-guide-download.js — make "GUIDA PRATICA" download a real HTML file to the user's device
 - Listens for clicks on the in-page "GUIDA PRATICA" button (matched by exact label text)
 - Builds the same full-screen guide HTML and triggers a Blob download so users get a real file on PC/mobile
 - Non-destructive: does not alter existing modal or navigation behavior if button is wired elsewhere
*/
(function(){
  // build the guide HTML (kept concise and matching the guide content used by profile-ui.js)
  function buildGuideHtml(){
    const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GUIDA PRATICA — CUP9GPU</title>
<style>
  body{font-family:Inter,Segoe UI,Roboto,Arial; margin:0;padding:18px;background:#f7fafc;color:#042b36}
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
    <p class="note">Istruzioni passo‑passo per le operazioni principali: deposito, prelievo, acquisto dispositivi, Task, Boost, licenze e esportazioni.</p>

    <div class="section" id="deposit">
      <h2>Come eseguire un Deposito</h2>
      <ol>
        <li>Home → + Deposito → inserisci importo e rete → Genera Indirizzo.</li>
        <li>Invia fondi dall'esterno all'indirizzo generato, poi torni e fornisci TXHash e eventualmente una foto prova pagamento.</li>
        <li>La transazione viene verificata dal supporto; quando l'OTP è confermato la transazione diventa "accredited".</li>
      </ol>
    </div>

    <div class="section" id="withdraw">
      <h2>Come richiedere un Prelievo</h2>
      <ol>
        <li>Imposta un wallet blindato nel Profilo → Blindaggio Wallet.</li>
        <li>Home → − Prelievo → inserisci importo → Invia a supporto: lo stato sarà awaiting_otp.</li>
        <li>Inserisci l'OTP fornito dal supporto per confermare; in caso di scadenza la richiesta può essere ripristinata dall'admin.</li>
      </ol>
    </div>

    <div class="section" id="buy-hardware">
      <h2>Acquisto dispositivo</h2>
      <ol>
        <li>Hardware → Acquista → conferma ciclo (1/3/7) → addebito dal saldo spendibile.</li>
        <li>Dispositivo sarà visibile in "I miei GPU" e potrà produrre guadagni; al termine del ciclo premi Claim se richiesto.</li>
      </ol>
    </div>

    <div class="section" id="tasks-boost">
      <h2>Tasks giornalieri e Boost</h2>
      <p>Tasks: Quiz (0.05$), Check-in avanzato (+5 punti GPU), Controllo attività (0.05$). Boost: usa punti per bonus su dispositivi (richiede licenza).</p>
    </div>

    <div class="section" id="licenses-invites">
      <h2>Licenze e Codici Invito</h2>
      <p>Acquisto licenze abilita referral, badge e privilegi; all'acquisto può essere generato un codice invito associato a una email.</p>
    </div>

    <div class="section" id="export-import">
      <h2>Esporta / Importa dati</h2>
      <p>Profilo → Aggiorna JSON per scaricare i tuoi dati; l'import richiede verifica (OTP) dall'assistenza per motivi di sicurezza.</p>
    </div>

    <div class="section" id="support">
      <h2>Supporto</h2>
      <p>Contatti: info.cup9@yahoo.com o il Bot Telegram indicato in Profilo; non condividere PIN o password.</p>
    </div>

    <div class="actions">
      <button class="btn secondary" onclick="window.close()">Chiudi</button>
      <button id="download-guide" class="btn">Scarica Guida</button>
    </div>
  </div>

  <script>
    // Trigger download when the "Scarica Guida" button is clicked in the opened guide (for fallback use)
    document.getElementById('download-guide').addEventListener('click', function(){
      try{
        const content = document.documentElement.outerHTML;
        const blob = new Blob([content], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'guida_pratica_cup9gpu.html';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(()=> URL.revokeObjectURL(url), 1000);
      }catch(e){
        alert('Download non riuscito');
      }
    });
  </script>
</body>
</html>`;
    return html;
  }

  // Trigger a real download of the guide HTML file
  function triggerDownload(filename, content){
    try{
      const blob = new Blob([content], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      // for mobile safari, a must be appended to DOM
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=> URL.revokeObjectURL(url), 1500);
      return true;
    }catch(e){
      console.error('guide download failed', e);
      return false;
    }
  }

  // Find the GUIDA PRATICA button by scanning for buttons with that exact label text
  function findGuidaButtons(){
    try{
      return Array.from(document.querySelectorAll('button')).filter(b => {
        try{ return String(b.textContent || '').trim().toUpperCase() === 'GUIDA PRATICA'; }catch(e){ return false; }
      });
    }catch(e){
      return [];
    }
  }

  // Attach click listeners that perform a direct download; if existing onclick is present, preserve it but still provide download
  function wireGuidaDownload(){
    const btns = findGuidaButtons();
    if(!btns.length) return;
    for(const btn of btns){
      if(btn.dataset.__guidadownload === '1') continue;
      btn.dataset.__guidadownload = '1';
      btn.addEventListener('click', function(ev){
        try{
          // build content and trigger download
          const content = buildGuideHtml();
          const ok = triggerDownload('guida_pratica_cup9gpu.html', content);
          if(!ok){
            // fallback: open in new tab so user can manually save
            const w = window.open('', '_blank');
            if(w){
              w.document.open();
              w.document.write(content);
              w.document.close();
            } else {
              // final fallback alert
              alert('Impossibile avviare il download: consenti popup o salva manualmente la pagina aperta.');
            }
          }
          // do not prevent default — preserve any existing behavior
        }catch(e){
          console.error('GUIDA PRATICA handler error', e);
        }
      }, false);
    }
  }

  // Wire on load and observe DOM for dynamic insertion of the button
  window.addEventListener('load', function(){
    try{ wireGuidaDownload(); }catch(e){}
    // Also observe DOM for newly injected buttons (ui modules may append the button dynamically)
    const mo = new MutationObserver(function(){
      try{ wireGuidaDownload(); }catch(e){}
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });

  // Expose a helper for console/admin to trigger the download programmatically
  window.CUP9 = window.CUP9 || {};
  window.CUP9.downloadGuidaPratica = function(){
    try{
      const content = buildGuideHtml();
      return triggerDownload('guida_pratica_cup9gpu.html', content);
    }catch(e){
      return false;
    }
  };

})();