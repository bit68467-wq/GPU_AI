CUP9 — WebSIM Production-Style App

How it works:
- All code runs entirely in WebSIM using a local mock backend (in api.js) when window.CUP9_API_BASE is not defined.
- To switch to a real backend in production, set window.CUP9_API_BASE to your API base URL before loading the app (or call CUP9.switchToBackend(url) and reload).
  Only one variable (window.CUP9_API_BASE) changes behaviour.

Files:
- index.html : entry
- styles.css : UI styles (dark, mobile-first)
- api.js : unified API client + mock in-memory backend
- auth.js : per-device session handling, token stored per-device in localStorage
- notifications.js : tiny pub/sub and toast helper
- profile-data.js / profile-ui.js / profile-actions-ui.js : modular profile components
- ui.js : page rendering and navigation
- script.js : bootstrap

Session isolation:
- Each browser/device gets a unique device id stored under 'cup9:deviceId'
- Tokens stored per-device under 'cup9:devices' in localStorage
- Logout invalidates token in mock DB; me() invalidation forces logout

Telegram login:
- Simulated; creates a Telegram-style user tied to device: telegram:{deviceId}@telegram.local

No demo account is shown anywhere. The mock behaves like a real server and uses the same function signatures as a REST API.