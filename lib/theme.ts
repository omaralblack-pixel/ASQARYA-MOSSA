/** Shared by the application and the standalone, CSP-protected login page.
 * Runs before paint; no theme preference is sent to the server or database.
 */
export const themeRuntimeScript = `(() => {
  const key = 'institution-theme';
  const root = document.documentElement;
  const valid = value => value === 'light' || value === 'dark' ? value : null;
  let preference = null;
  try { preference = valid(localStorage.getItem(key)); } catch {}
  const system = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const apply = () => {
    const theme = preference || (system?.matches ? 'dark' : 'light');
    root.dataset.theme = theme;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
  };
  apply();
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-theme-toggle]')) return;
    preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
    apply();
    try { localStorage.setItem(key, preference); } catch {}
  });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue);
    apply();
  });
  system?.addEventListener('change', () => { if (!preference) apply(); });
})();`;
