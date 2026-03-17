/*
 interactive-banner.js — injects styles and makes the AI banner image on "I miei GPU" interactive:
 - subtle 3D tilt on mousemove
 - soft luminous glow on hover
 - click toggles a stronger persistent glow
 - mobile: simple touch tap toggles glow (no tilt)
*/
(function(){
  // Small helper to inject CSS scoped to our banner id/class
  const css = `
  /* interactive banner styles */
  .cup9-interactive-banner {
    transition: transform 260ms cubic-bezier(.2,.9,.2,1), box-shadow 260ms cubic-bezier(.2,.9,.2,1);
    transform-style: preserve-3d;
    will-change: transform, box-shadow;
    cursor: pointer;
    border-radius: 12px;
    display: block;
  }
  .cup9-interactive-banner.glow {
    box-shadow: 0 24px 80px rgba(31,127,179,0.28), inset 0 -10px 40px rgba(46,160,201,0.06);
    filter: saturate(1.05) drop-shadow(0 18px 80px rgba(31,127,179,0.12));
    transform: translateZ(8px) scale(1.01);
  }
  .cup9-interactive-banner.pulse {
    animation: cup9-pulse 1600ms ease-in-out infinite;
  }
  @keyframes cup9-pulse {
    0% { box-shadow: 0 18px 48px rgba(31,127,179,0.12); transform: translateZ(6px) scale(1.005); }
    50% { box-shadow: 0 30px 110px rgba(31,127,179,0.20); transform: translateZ(10px) scale(1.015); }
    100% { box-shadow: 0 18px 48px rgba(31,127,179,0.12); transform: translateZ(6px) scale(1.005); }
  }

  /* reduce motion on users who prefer reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .cup9-interactive-banner, .cup9-interactive-banner.glow, .cup9-interactive-banner.pulse {
      transition: none !important;
      animation: none !important;
      transform: none !important;
    }
  }
  `;
  try{
    const s = document.createElement('style');
    s.id = 'cup9-interactive-banner-styles';
    s.appendChild(document.createTextNode(css));
    document.head.appendChild(s);
  }catch(e){ console.warn('interactive-banner: inject css failed', e); }

  function isTouch(){ return 'ontouchstart' in window || navigator.maxTouchPoints > 0; }

  // Bind when DOM is ready and when "I miei GPU" section is rendered (dynamic SPA)
  function bindBanner(){
    try{
      const img = document.querySelector('img[alt="AI Network Illustration"], img[src*="isometric-artificial-intelligence-chip-animation"]');
      if(!img) return;
      // avoid double-binding
      if(img.dataset.__cup9Interactive === '1') return;
      img.dataset.__cup9Interactive = '1';
      // add class
      img.classList.add('cup9-interactive-banner');

      // state
      let persistentGlow = false;

      // helper to set transform based on mouse position
      function applyTilt(evt){
        try{
          const rect = img.getBoundingClientRect();
          const cx = rect.left + rect.width/2;
          const cy = rect.top + rect.height/2;
          const pointerX = (evt.clientX !== undefined) ? evt.clientX : (evt.touches && evt.touches[0] && evt.touches[0].clientX);
          const pointerY = (evt.clientY !== undefined) ? evt.clientY : (evt.touches && evt.touches[0] && evt.touches[0].clientY);
          if(pointerX === undefined || pointerY === undefined) return;
          const dx = pointerX - cx;
          const dy = pointerY - cy;
          // normalized [-1 .. 1]
          const nx = Math.max(-1, Math.min(1, dx / (rect.width/2)));
          const ny = Math.max(-1, Math.min(1, dy / (rect.height/2)));
          const rotY = nx * 8; // degrees
          const rotX = -ny * 6; // degrees
          const translateZ = 6 + Math.abs(nx)*2 + Math.abs(ny)*2;
          img.style.transform = `perspective(900px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateZ(${translateZ}px)`;
        }catch(e){}
      }

      function resetTilt(){
        img.style.transform = persistentGlow ? 'translateZ(8px) scale(1.01)' : 'none';
      }

      // Hover/touch handlers
      if(!isTouch()){
        img.addEventListener('mousemove', function(evt){
          applyTilt(evt);
        });
        img.addEventListener('mouseenter', function(){
          img.classList.add('glow');
          // subtle pulse while hovered
          img.classList.add('pulse');
        });
        img.addEventListener('mouseleave', function(){
          img.classList.remove('pulse');
          if(!persistentGlow) img.classList.remove('glow');
          resetTilt();
        });
      } else {
        // touch: use tap to toggle persistent glow; use touchstart to set a subtle highlight
        img.addEventListener('touchstart', function(evt){
          img.classList.add('glow');
        }, { passive:true });
        img.addEventListener('touchend', function(evt){
          // toggle persistent on tap
          persistentGlow = !persistentGlow;
          if(persistentGlow){
            img.classList.add('glow');
            img.classList.add('pulse');
          } else {
            img.classList.remove('glow');
            img.classList.remove('pulse');
          }
          resetTilt();
        });
      }

      // click toggles persistent glow on desktop as well
      img.addEventListener('click', function(evt){
        persistentGlow = !persistentGlow;
        if(persistentGlow){
          img.classList.add('glow');
          img.classList.add('pulse');
          img.style.transform = 'translateZ(8px) scale(1.01)';
        } else {
          img.classList.remove('glow');
          img.classList.remove('pulse');
          img.style.transform = 'none';
        }
      });

      // keyboard accessibility: when focused and pressing Enter toggles glow
      img.setAttribute('tabindex','0');
      img.addEventListener('keydown', function(e){
        if(e.key === 'Enter' || e.key === ' '){
          e.preventDefault();
          persistentGlow = !persistentGlow;
          if(persistentGlow){
            img.classList.add('glow');
            img.classList.add('pulse');
            img.style.transform = 'translateZ(8px) scale(1.01)';
          } else {
            img.classList.remove('glow');
            img.classList.remove('pulse');
            img.style.transform = 'none';
          }
        }
      });

    }catch(e){ console.warn('interactive-banner bind failed', e); }
  }

  // run on load and also on SPA updates — observe DOM for the banner insertion
  document.addEventListener('DOMContentLoaded', bindBanner);
  // run immediately in case DOM already loaded
  setTimeout(bindBanner, 300);

  // Mutation observer to catch dynamic render of the my-devices banner image
  const mo = new MutationObserver(()=>{
    try{ bindBanner(); }catch(e){}
  });
  mo.observe(document.body, { childList:true, subtree:true });

})();