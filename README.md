# CUP9GPU

This repository contains a lightweight single-file vanilla JS app using a small persistence shim and a Websim-compatible backend abstraction.

Deployment (Render static site)
- The project is configured as a Render static web service via `render.yaml`.
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