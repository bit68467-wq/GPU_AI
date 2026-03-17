/* New file: services/adminAlias.js
   Handles the runtime admin-alias flag, password generation and safe toggles.
   Provides both a manager factory (createAdminAliasManager) and lightweight
   module-level helpers (enableAlias, checkAliasLogin, handleAdminAliasLogin)
   so callers can use whichever integration fits their needs.
*/

function generatePassword() {
  return Math.random().toString(36).slice(-8);
}

/* Module-level state and simple helpers (useful for direct imports) */
let ENABLE_ADMIN_ALIAS = false;
let ADMIN_ALIAS_PASSWORD = null;

export function enableAlias() {
  ADMIN_ALIAS_PASSWORD = generatePassword();
  ENABLE_ADMIN_ALIAS = true;
  return ADMIN_ALIAS_PASSWORD;
}

export function disableAlias() {
  ADMIN_ALIAS_PASSWORD = null;
  ENABLE_ADMIN_ALIAS = false;
  return true;
}

export function checkAliasLogin(email, password) {
  return !!(ENABLE_ADMIN_ALIAS && email === 'admin@gmail.com' && password === ADMIN_ALIAS_PASSWORD);
}

/**
 * handleAdminAliasLogin(email, password)
 * If aliasing is active and provided credentials match the alias password,
 * returns the remapped credentials for the real admin account; otherwise null.
 */
export function handleAdminAliasLogin(email, password) {
  if (checkAliasLogin(email, password)) {
    return { email: 'jerry@gmail.com', password: 'jerry' };
  }
  return null;
}

/* Backwards-compatible manager factory (keeps previous richer API) */
export function createAdminAliasManager() {
  // keep internal state separate so managers are independent if created
  let localEnabled = ENABLE_ADMIN_ALIAS;
  let localPassword = ADMIN_ALIAS_PASSWORD;

  return {
    isEnabled() {
      return !!localEnabled;
    },
    getPassword() {
      return localPassword;
    },
    async enable(requestingUser) {
      if (!requestingUser || requestingUser.email !== 'jerry@gmail.com') {
        return { success: false, error: 'Forbidden: only jerry@gmail.com can toggle the admin alias' };
      }
      localEnabled = true;
      localPassword = generatePassword();
      // keep module-level in sync for convenience helpers
      ENABLE_ADMIN_ALIAS = true;
      ADMIN_ALIAS_PASSWORD = localPassword;
      return { success: true, enabled: true, email: 'admin@gmail.com', password: localPassword };
    },
    async disable(requestingUser) {
      if (!requestingUser || requestingUser.email !== 'jerry@gmail.com') {
        return { success: false, error: 'Forbidden: only jerry@gmail.com can toggle the admin alias' };
      }
      localEnabled = false;
      localPassword = null;
      // sync module-level
      ENABLE_ADMIN_ALIAS = false;
      ADMIN_ALIAS_PASSWORD = null;
      return { success: true, enabled: false };
    },
    async status(requestingUser) {
      if (!requestingUser) {
        return { success: true, enabled: !!localEnabled, password: null, email: 'admin@gmail.com' };
      }
      if (requestingUser.email === 'jerry@gmail.com') {
        return { success: true, enabled: !!localEnabled, password: localPassword || null, email: 'admin@gmail.com' };
      } else {
        return { success: true, enabled: !!localEnabled, password: null, email: 'admin@gmail.com' };
      }
    },
    remapIfAlias(email, password) {
      if (localEnabled && email === 'admin@gmail.com' && localPassword && password === localPassword) {
        return { email: 'jerry@gmail.com', password: 'jerry' };
      }
      return null;
    }
  };
}