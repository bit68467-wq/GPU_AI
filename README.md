# CUP9GPU Backend Demo

This repository contains a minimal Express backend to support the CUP9GPU SPA demo.

Files added:
- server.js : minimal API implementing /sync, /register, /login and /users
- package.json : dependencies and start script
- data.json : small persistent store (optional; added to repo for initial empty state)
- .gitignore : ignore node_modules and secrets
- README.md : this file

Deployment notes:
- Deploy to Render (Web Service) or similar PaaS. Set the start command to `npm start`.
- Ensure Node >= 16. Expose service's public URL and update the SPA `API_BASE` constant if needed.
- This demo stores passwords in plaintext for compatibility with the client fallback; replace with hashed passwords and proper auth in production.

Service IDs and hosting
- Backend Service ID (Render): srv-d6safq7afjfc73esecr0
- Static site Service ID (Render): srv-d6sc2nnafjfc73et5l20
- Public demo URL (static site): https://gpu-ai-jtlb.onrender.com
- Repository mirror / reference: https://github.com/bit68467-wq/GPU_AI.git