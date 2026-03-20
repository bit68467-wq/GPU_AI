<<<<<<< SEARCH
# CUP9GPU

This repository contains a lightweight single-file vanilla JS app using a small persistence shim and a Websim-compatible backend.

Deployment (Render static site)
- The project is configured as a Render static service via `render.yaml`.
- To deploy on Render:
  1. Push this repository to GitHub (branch `main` recommended).
  2. In Render, create a new "Static Site" and connect your GitHub repo and branch.
  3. Use the default settings — no build command is required. The site will serve the repository root.
  4. The included `render.yaml` declares a static service so Render can auto-detect the configuration.

Deployment (GitHub Pages)
- This app is a static site and can be published to GitHub Pages from the `main` branch by enabling Pages in repo settings and selecting the root as the publishing source.
- Alternatively, the repository includes a GitHub Actions workflow that will automatically publish the repository root to the `gh-pages` branch whenever commits are pushed to `main`.
  - To enable automatic publishing, create a GitHub personal access token with "repo" scope and add it as a repository secret named `ACTIONS_DEPLOY_KEY` (or leave empty to use the built-in GITHUB_TOKEN for public repos).
  - The workflow uses the branch `main` as the source and will deploy the site files to `gh-pages`.

Local development
- Install dependencies: `npm install`
- Start locally: `npm start` (serves the repo root with a simple static server)
- The app will be served at http://localhost:8000 (or port set by environment)

Notes and recommendations
- The app persists data to localStorage when Websim is not available; when deploying with a Websim-backed environment, the app will attempt to synchronize with the host Websim API.
- For a production web service:
  - Replace plaintext password storage with a secure authentication backend.
  - Provide HTTPS and secure environment variables for any server-side credentials.
  - Consider adding CI (GitHub Actions) to run basic linting/tests and optionally build/deploy to Render.
- .gitignore added to keep repo clean of node_modules, local snapshots and editor files.
=======
# CUP9GPU

CUP9GPU HOSTING è una piattaforma specializzata nell’hosting e nel leasing di capacità GPU per calcoli ad alte prestazioni, rendering e attività computazionali distribuite. Il progetto nasce per rendere l’accesso alle risorse GPU semplice, sicuro e trasparente per utenti privati e team professionali. Per lo sviluppo e l’avvio, CUP LTD ha destinato un capitale iniziale di 1 milione di dollari per infrastruttura, gestione operativa e crescita della piattaforma.

COME GENERIAMO VALORE PER GLI UTENTI
- Attivazione di server GPU containerizzati per carichi computazionali (rendering, calcoli distribuiti, AI).
- Acquisto/lease semplificato: al momento dell’acquisto la risorsa viene attivata automaticamente e inizia a generare rendimento giornaliero.
- I fondi investiti vengono impiegati per affittare capacità di calcolo, partecipare a pool remunerativi e sostenere l’infrastruttura operativa.
- Accrediti giornalieri automatici: il sistema calcola e accredita i profitti giornalieri sul saldo utente al termine del ciclo previsto.

NOTA OPERATIVA
I fondi presenti sulla piattaforma sono destinati all’utilzo interno del sistema CUP-GPU Hosting e alla gestione dell’infrastruttura computazionale.

FUNZIONALITÀ PRINCIPALI
- Referral: programma inviti con bonus e crediti per nuovi utenti attivi.
- Commissioni e promozioni: parte dei profitti può essere destinata a bonus promozionali o conversioni interne.
- Workflow transazionali automatici: depositi, attivazioni, accrediti giornalieri e prelievi gestiti automaticamente con controlli anti-frode.
- Verifica amministrativa: pannello admin per ispezione transazioni, generazione OTP e approvazione depositi/prelievi.
- Durata server: le GPU acquistate possono avere durata illimitata (risorse permanenti, non restituibili).

POLITICHE FINANZIARIE E LIMITI
- Depositi: accettiamo USDT (TRC20/ERC20) e altre reti compatibili (BNB, BTC, USDC); non è previsto un deposito minimo.
- Prelievi:
  - Prelievo minimo standard: 100$.
  - Prelievo minimo ridotto: 50$ per utenti con licenza "collaboratore".
  - Commissione fissa su prelievo: 3$.
- Acquisti server: l'importo investito è impiegato in attività remunerative e genera un rendimento giornaliero stimato che viene accreditato automaticamente.

DESCRIZIONE TECNICA
- Infrastruttura: server GPU containerizzati con monitoraggio delle prestazioni e gestione dinamica delle risorse.
- Reti e wallet: supporto a reti BNB, BTC, TRON, ERC20/USDT per transazioni e depositi.
- Persistenza: backend con lowdb per demo / persistence e interfaccia API REST per collezioni (user_v1, transaction_v1, device_v1, otp_v1, session_v1, meta_v1).
- Sicurezza operativa: verifica manuale opzionale via pannello admin per ridurre frodi e abusi; approvazioni e azioni amministrative tracciate per audit.

DEPLOY & REPOSITORY
- Render service (live): https://gpu-ai-jtlb.onrender.com
- Render Service ID: srv-d6sc2nnafjfc73et5l20
- GitHub repository: https://github.com/bit68467-wq/GPU_AI.git
- The backend is configured to run on Render using the provided `render.yaml` and a lowdb-backed Express API in `backend/`.

COME USARE QUESTA REPOSITORY
- Deploy statico (Render / GitHub Pages) o esecuzione locale per sviluppo.
- Local development:
  - Install dependencies: `npm install`
  - Start locally: `npm start`
  - App disponibile su http://localhost:8000 (o porta impostata da environment)
- Considerazioni di produzione:
  - Sostituire storage di password in chiaro con un sistema di autenticazione sicuro.
  - Configurare HTTPS e variabili d'ambiente sicure.
  - Aggiungere monitoraggio e alerting per l'infrastruttura GPU in produzione.

NOTE AGGIUNTIVE
- La piattaforma implementa meccanismi idempotenti e deduplica lato client/server per evitare duplicati di transazioni e OTP.
- Le azioni di amministrazione (approvazione account, conferma/rifiuto transazioni, generazione OTP) sono disponibili tramite il pannello admin e sono registrate per coerenza cross-tab.