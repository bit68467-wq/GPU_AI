# CUP9GPU Backend Demo

This repository contains a minimal Express backend to support the CUP9GPU SPA demo.

Files included:
- server.js : minimal API implementing /sync, /register, /login and /users
- package.json : dependencies and start script
- data.json : small persistent store (optional; added to repo for initial empty state)
- render.yaml : Render service blueprint for deploying the backend
- config.js / index.html / app.js : SPA static client that interacts with this backend
- .gitignore : ignore node_modules and secrets
- Dockerfile, Procfile, start.sh, .env : helper files to run and deploy locally or on PaaS

Quick local run
1. Copy `.env.sample` to `.env` and fill values (or use the provided `.env`).
2. Install dependencies: `npm install`
3. Start the server: `npm start` or `./start.sh`

Deploying to Render (Web Service)
- Option A (Simple): Use the included `render.yaml` blueprint. In Render dashboard, create a new Web Service using your repo and choose "Use render.yaml". Ensure environment variables in Render match `.env` keys (PORT, SERVICE_ID, STATIC_SERVICE_ID, API_BASE). Start command: `npm start`.
- Option B (Docker): Use the provided Dockerfile; in Render select "Docker" environment and let Render build and deploy the image.
- Option C (Manual Web Service): Create a Web Service, set the environment to Node, set build command to `npm install` and start command to `npm start`. Add the same env vars as above in the Render service settings.

Notes & security
- This demo stores user passwords in plaintext for compatibility with the SPA offline fallback. Do not use this pattern in production—implement proper password hashing (bcrypt/argon2), secure session management, and TLS.
- The SPA reads the backend base URL and service id from meta tags or `config.js`. If you deploy backend to a custom domain, update `API_BASE` in `config.js` or via environment / meta tags on the static site.
- Persisted data is saved to `data.json` when filesystem is writable; on some PaaS providers ephemeral filesystems may not persist across restarts. For production, replace with a proper DB.

Service IDs and hosting (demo defaults)
- Backend Service ID (example): srv-d6safq7afjfc73esecr0
- Static site Service ID (example): srv-d6sc2nnafjfc73et5l20
- Public demo URL (static site example): https://gpu-ai-jtlb.onrender.com
- Repository mirror / reference: https://github.com/bit68467-wq/GPU_AI.git