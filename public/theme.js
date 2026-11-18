/* Day / night theme. Runs before the stylesheet paints to avoid a flash. */
(() => {
  const key = 'yanyu-sub-theme';
  const modes = ['auto', 'light', 'dark'];
  const labels = { auto: '自动', light: '浅色', dark: '深色' };
  // "auto" follows the clock: 07:00–19:00 is day, the rest is night.
  const DAY_START = 7;
  const DAY_END = 19;
  let mode = 'auto';
  // Once a read or write throws, the stored value can no longer be trusted: the
  // in-memory mode wins and the re-sync paths stay off.
  let storageOk = true;
  let button = null;
  let label = null;
  let timer = 0;

  function isDay(hour) {
    return hour >= DAY_START && hour < DAY_END;
  }

  // Storage is absent in some webviews and throws in private mode, so every access
  // is guarded; a failure just leaves the theme in "auto".
  function readStored() {
    if (!storageOk) return;
    try {
      const saved = localStorage.getItem(key);
      if (modes.includes(saved)) mode = saved;
    } catch {
      storageOk = false;
    }
  }

  function writeStored(value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      storageOk = false;
    }
  }

  // Pick up a mode written by another tab (or while this page sat in the bfcache).
  function resync() {
    readStored();
    apply();
  }

  function resolve() {
    if (mode !== 'auto') return mode;
    return isDay(new Date().getHours()) ? 'light' : 'dark';
  }

  // The next 07:00 / 19:00 boundary in local time. Recomputed on every apply so a
  // clock change, a sleeping device or a bfcache restore cannot drift the theme.
  function nextBoundary(now) {
    const boundary = new Date(now);
    const hour = now.getHours();
    const day = isDay(hour);
    // After 19:00 the next switch is tomorrow morning; before 07:00 it is today's.
    if (!day && hour >= DAY_END) boundary.setDate(boundary.getDate() + 1);
    boundary.setHours(day ? DAY_END : DAY_START, 0, 0, 0);
    return boundary;
  }

  function apply() {
    const theme = resolve();
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#101010' : '#f5f5f3');
    if (button && label) {
      label.textContent = labels[mode];
      const next = modes[(modes.indexOf(mode) + 1) % modes.length];
      button.setAttribute('aria-label', `当前主题：${labels[mode]}，切换至${labels[next]}`);
    }
    clearTimeout(timer);
    if (mode === 'auto') {
      const now = new Date();
      // At least 1s: a boundary that has just passed must not spin the timer.
      const wait = Math.max(1000, nextBoundary(now) - now);
      timer = setTimeout(apply, wait);
    }
  }

  readStored();
  apply();

  function init() {
    button = document.getElementById('theme-toggle');
    label = document.getElementById('theme-label');
    if (!button || !label) return;
    button.addEventListener('click', () => {
      mode = modes[(modes.indexOf(mode) + 1) % modes.length];
      writeStored(mode);
      apply();
    });
    // The toggle only exists once this script has wired it up.
    button.hidden = false;
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Another tab changed the theme: adopt it instead of leaving the two out of sync.
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    // A removed key (event.key === null) means "back to auto".
    mode = 'auto';
    resync();
  });

  // Coming back to the tab (or out of the bfcache) may cross a boundary or pick up a
  // change written elsewhere, so the stored mode is re-read before the theme is applied.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resync();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) resync();
  });
})();
