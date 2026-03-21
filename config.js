/*
  Runtime configuration override for the SPA to point to the real Render backend and service IDs.
  This file is intentionally simple: it sets global variables that the existing app reads (fallbacks exist),
  and also updates meta tags so code that reads meta elements will pick up the correct values.
*/

(function(){
  // Real backend URL and service IDs provided
  const API_BASE = "https://gpu-ai-jtlb.onrender.com";
  const SERVICE_ID = "srv-d6sc2nnafjfc73et5l20";
  const STATIC_SERVICE_ID = "srv-d6sc2nnafjfc73et5l20";

  // Expose globals for any script that prefers window variables
  window.__API_BASE = API_BASE;
  window.__SERVICE_ID = SERVICE_ID;
  window.__STATIC_SERVICE_ID = STATIC_SERVICE_ID;

  // Update meta tags so existing code reading meta[name="api-base"] / service-id picks up these values
  function upsertMeta(name, content){
    try{
      let m = document.querySelector(`meta[name="${name}"]`);
      if(!m){
        m = document.createElement('meta');
        m.setAttribute('name', name);
        document.head.appendChild(m);
      }
      m.setAttribute('content', content);
    }catch(e){
      console.warn('meta upsert failed', e);
    }
  }

  upsertMeta('api-base', API_BASE);
  upsertMeta('service-id', SERVICE_ID);
  upsertMeta('static-service-id', STATIC_SERVICE_ID);

  // Also override the constants used in app.js if present (defensive)
  try{
    if(typeof window.APP_CONFIG === 'undefined') window.APP_CONFIG = {};
    window.APP_CONFIG.apiBase = API_BASE;
    window.APP_CONFIG.serviceId = SERVICE_ID;
    window.APP_CONFIG.staticServiceId = STATIC_SERVICE_ID;
  }catch(e){}
})();