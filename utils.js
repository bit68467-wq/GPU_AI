/* Utility helper module extracted from app.js to keep core utilities modular.
   Exposes a couple of helpers to window for the app and other modules to reuse.
*/

// expose generateOTP and formatMoney for other modules
(function(){
  function formatMoney(n){
    const num = typeof n === 'number' ? n : (Number(n) || 0);
    return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function generateOTP(){
    return Math.floor(100000 + Math.random()*900000).toString();
  }

  // expose on window for legacy usage by app.js / hardware.js
  window.__cup9_utils = {
    formatMoney,
    generateOTP
  };
})();