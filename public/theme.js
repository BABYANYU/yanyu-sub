/* Day / night theme. Runs before the stylesheet paints to avoid a flash. */
(() => {
  const key = 'yanyu-sub-theme';
  const modes = ['auto', 'light', 'dark'];
  const labels = { auto: '自动', light: '浅色', dark: '深色' };
  let mode = 'auto';
  try {
    const saved = localStorage.getItem(key);
    if (modes.includes(saved)) mode = saved;
  } catch {}

  let button = null;
  let label = null;
  let timer = 0;

  function resolve() {
    if (mode !== 'auto') return mode;
    const hour = new Date().getHours();
    return hour >= 7 && hour < 19 ? 'light' : 'dark';
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
      const boundary = new Date(now);
      const hour = now.getHours();
      if (hour >= 19) boundary.setDate(boundary.getDate() + 1);
      boundary.setHours(hour >= 7 && hour < 19 ? 19 : 7, 0, 0, 0);
      timer = setTimeout(apply, Math.max(1000, boundary - now));
    }
  }

  apply();
  document.addEventListener('DOMContentLoaded', () => {
    button = document.getElementById('theme-toggle');
    label = document.getElementById('theme-label');
    if (!button || !label) return;
    button.addEventListener('click', () => {
      mode = modes[(modes.indexOf(mode) + 1) % modes.length];
      try { localStorage.setItem(key, mode); } catch {}
      apply();
    });
    button.hidden = false;
    apply();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) apply();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) apply();
  });
})();
