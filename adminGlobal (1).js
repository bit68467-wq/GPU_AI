/* === CUP9GPU GLOBAL ADMIN OVERRIDE – PURE WEBSIM === */
(() => {

  const ADMIN_KEY = "CUP9GPU_ADMIN_ACCOUNTS";

  const ADMINS = {
    "jerry@gmail.com":   { password: "jerry",   role: "owner",   enabled: true  },
    "admin@gmail.com":   { password: "admin",   role: "admin",   enabled: true  },
    "approve@gmail.com": { password: "0099", role: "approve", enabled: true  }
  };

  /* salva se non esiste */
  if (!localStorage.getItem(ADMIN_KEY)) {
    localStorage.setItem(ADMIN_KEY, JSON.stringify(ADMINS));
  }

  const loadAdmins = () =>
    JSON.parse(localStorage.getItem(ADMIN_KEY));

  /* BYPASS TOTALE LOGIN */
  const originalLogin = window.login;

  window.login = async function(email, password) {
    const admins = loadAdmins();
    const a = admins[email];

    if (a && a.enabled && a.password === password) {
      const user = {
        email,
        role: a.role,
        isAdmin: true
      };

      localStorage.setItem("user", JSON.stringify(user));
      window.CURRENT_USER = user;

      return { success: true, user };
    }

    if (originalLogin) return originalLogin(email, password);
    return { success: false };
  };

  /* IGNORA DEVICE LOCK PER ADMIN */
  const originalFetch = window.fetch;
  window.fetch = async function(url, opts = {}) {
    const u = JSON.parse(localStorage.getItem("user") || "{}");
    if (u.isAdmin) return originalFetch(url, opts);
    return originalFetch(url, opts);
  };

})();