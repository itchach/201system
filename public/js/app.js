// Client-Side App Utilities & Shared Logic

const App = {
  currentUser: null,

  /**
   * Check whether the current user has an active session.
   *
   * Returns:
   *  { user: {...} }       — authenticated
   *  { user: null }        — not authenticated (genuine 401)
   *  { user: undefined, error: true } — server error / network failure
   *    → callers should NOT redirect to login on this; it may be transient.
   */
  async checkAuth() {
    try {
      // credentials: 'include' ensures the session cookie is attached.
      // Same-origin requests send cookies automatically, but being explicit
      // is safer on hosted platforms (e.g. Render) where the browser may
      // treat the cookie as third-party in some edge cases.
      const res = await fetch('/api/auth/me', { credentials: 'include' });

      if (res.status === 401) {
        // Genuine "not logged in" response from the server
        this.currentUser = null;
        return { user: null };
      }

      if (!res.ok) {
        // Server error (5xx) or unexpected status — do NOT redirect to login
        console.warn('[App.checkAuth] Unexpected status:', res.status);
        return { user: undefined, error: true };
      }

      const data = await res.json();
      this.currentUser = data.user;
      return data;
    } catch (err) {
      // Network failure — do NOT redirect to login; server may be starting up
      console.error('[App.checkAuth] Network error:', err);
      return { user: undefined, error: true };
    }
  },

  async logout() {
    try {
      // 1. Destroy server session
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });

      // 2. Revoke Google Sign-In session so shared-computer users
      //    must re-authenticate with Google on next visit
      if (window.google && window.google.accounts) {
        try {
          google.accounts.id.disableAutoSelect();
        } catch (e) { /* GIS might not be loaded on all pages */ }
      }

      // 3. Clear any in-memory/local state
      this.currentUser = null;

      // 4. Redirect to login with cache busting
      window.location.replace('/index.html?signed_out=' + Date.now());
    } catch (err) {
      console.error('Logout error:', err);
      window.location.replace('/index.html');
    }
  },

  showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = '✓';
    if (type === 'error') icon = '✕';
    if (type === 'warning') icon = '⚠';

    toast.innerHTML = `
      <span style="font-weight: bold; font-size: 1.1rem;">${icon}</span>
      <div style="flex: 1; font-size: 0.875rem;">${message}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  },

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('open');
      document.body.style.overflow = 'auto';
    }
  },

  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
};
