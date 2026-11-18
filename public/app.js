import { convertSources } from './converter.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#convert-form');
const sourceInput = $('#source-input');
const resultPanel = $('#result');
const errorPanel = $('#error-panel');
const publishButton = $('#publish');
const publishStatus = $('#publish-status');
const publishedBlock = $('#published');
const publishedUrl = $('#published-url');
const copyPublished = $('#copy-published');
const revokePublished = $('#revoke-published');
const configPreview = $('#config-preview');
// Same envelope the converter and the Worker enforce; checked before any request.
const MAX_URL_LENGTH = 8192;
const CONVERT_TIMEOUT_MS = 90000;
const PUBLISH_TIMEOUT_MS = 30000;
// Hosted links are permanent: the client never asks for a shorter lifetime.
const PUBLISH_DONE = '订阅链接已生成，默认永久有效。';
// Exact test used by convertSources() in converter.js to treat a source as a link.
const URL_INPUT = /^https?:\/\/[^\s]+$/;
const URL_LINE = /^https?:\/\/\S+$/i;
let revision = 0;
let running = false;
let result = null;
// The source text the current result/link was produced from, so an input event that
// leaves the text unchanged (a typo the user undid) does not destroy the manage token.
let submittedText = '';
// Live publication for the current result: {url, manageToken}.
// The manage token is deliberately memory-only — never a cookie, never storage.
let publication = null;
let revoking = false;

class TimeoutError extends Error {
  constructor() {
    super('Conversion timed out');
    this.name = 'TimeoutError';
  }
}

// The single submit button covers both stages (convert, then publish), so it is
// disabled for the whole run and re-armed afterwards.
function setRunning(value) {
  running = value;
  publishButton.disabled = value;
  if (value) publishButton.setAttribute('aria-busy', 'true');
  else publishButton.removeAttribute('aria-busy');
}

// Forget the hosted link locally. The manage token must never outlive the result it
// belongs to, and it is never persisted to any browser storage or a cookie.
function resetPublication(message = '') {
  publication = null;
  revoking = false;
  publishedBlock.hidden = true;
  publishedUrl.value = '';
  copyPublished.disabled = true;
  revokePublished.disabled = true;
  revokePublished.removeAttribute('aria-busy');
  publishStatus.textContent = message;
}

// The publish API answers JSON on success and may answer plain text on error, so both
// shapes are normalized to {message} without ever echoing the request body.
async function readBody(response) {
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  } catch {
    return null;
  }
}

// Server messages are shown, but scrubbed: neither the profile nor the manage token
// may end up in visible text.
function publishErrorText(status, message) {
  if (status < 500 && typeof message === 'string' && message.trim()) return cleanDiagnostic(message);
  // 5xx bodies may echo upstream internals, so they never reach the page.
  if (status === 403) return '请求来源校验失败，请刷新页面后重试。';
  if (status === 413) return '配置过大，无法生成订阅链接。';
  if (status === 429) return '生成太频繁，请稍后再试。';
  if (status === 503) return '订阅服务暂时不可用，请稍后重试。';
  return '生成订阅链接失败，请稍后重试。';
}

function invalidate(unchanged = false) {
  if (unchanged && !running) {
    // Nothing to discard: the text still matches what produced the current link.
    errorPanel.hidden = true;
    return;
  }
  revision += 1;
  const hadResult = result !== null;
  result = null;
  resetPublication();
  resultPanel.hidden = true;
  configPreview.value = '';
  errorPanel.hidden = true;
  if (hadResult || running) publishStatus.textContent = '内容已更改，请重新生成。';
  else publishStatus.textContent = '';
}

// Keep credentials and source addresses out of visible diagnostic text.
function cleanDiagnostic(value) {
  return String(value)
    .replace(/(?:https?|ss|ssr|ss2022|vmess|vless|trojan|hysteria2?|hy2|tuic|anytls|socks5?|snell|wireguard|wg):\/\/[^\s<>"'，。；]+/gi, '[链接已隐藏]')
    .replace(/(?:token|password|passwd|secret|authorization|api[-_]?key)\s*[:=]\s*[^\s,，;；]+/gi, '[凭据已隐藏]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 500);
}

// Mirrors the checks in validateSource()/source-policy.js that the browser can decide
// locally, so the user gets an actionable reason instead of the API's generic message.
// Host reachability (DNS policy, private ranges) stays a server-side decision.
function sourceUrlProblem(text) {
  if (text.length > MAX_URL_LENGTH) return `链接过长（${text.length} 个字符，最多 ${MAX_URL_LENGTH} 个字符）。`;
  if (/[\u0000-\u0020\\]/u.test(text)) return '链接中不能包含空格、控制字符或反斜杠。';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '链接格式无效，请粘贴完整的 HTTPS 地址。';
  }
  if (url.protocol !== 'https:') return '只支持 HTTPS 链接，请把 http:// 改为 https://。';
  if (url.username || url.password) return '链接不能包含用户名或密码，请改用带令牌的订阅地址。';
  if (url.hash) return '链接不能包含 # 片段，请删除 # 及其后的内容。';
  if (url.port && url.port !== '443') return '链接只能使用 443 端口。';
  const host = url.hostname.toLowerCase();
  if (!host || host === location.hostname.toLowerCase() || host === 'localhost' || host.endsWith('.') || host.includes(':') || host.startsWith('[') || /^\d+(?:\.\d+)*$/.test(host) || !host.includes('.') || /\.(?:local|internal|localhost|test|invalid)$/u.test(host)) {
    return '请填写可公开访问的域名，不能是本站、本机、IP 或内网地址。';
  }
  return '';
}

// Returns a message for the rejected source, or null.
function checkSource(text) {
  if (!text) return '请粘贴订阅链接或订阅文本。';
  if (URL_INPUT.test(text)) {
    return sourceUrlProblem(text);
  }
  // Everything below is text conversion; catch the obvious "link pasted as text" cases.
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => URL_LINE.test(line))) {
    return '这里包含多个链接；请只填写一个订阅链接，节点文本可直接粘贴多行。';
  }
  if (lines.length === 1 && URL_LINE.test(lines[0])) {
    return '链接无法识别，请确认以小写 https:// 开头且不含空格。';
  }
  return null;
}


// Failures stay inline: the alert panel for input problems, the status line for
// anything that happens after the profile was already converted.
function showError(message, input = null) {
  $('#error-message').textContent = message;
  errorPanel.hidden = false;
  publishStatus.textContent = '';
  if (input) input.setAttribute('aria-invalid', 'true');
  // Focusing the offending field lets the user fix it immediately; without one,
  // move to the alert so the message is announced and reachable.
  if (input) input.focus();
  else errorPanel.focus();
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// POST the converted profile and adopt the hosted link. Resolves true on success.
async function publishLink(current, requestRevision) {
  // A request that outlives the 30s budget is aborted instead of being left to
  // resolve into a page that has already reported failure.
  const controller = new AbortController();
  try {
    const response = await withTimeout(fetch('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: current.content, target: current.target }),
      signal: controller.signal,
    }), PUBLISH_TIMEOUT_MS);
    if (requestRevision !== revision) return false;
    const data = await readBody(response);
    if (requestRevision !== revision) return false;
    if (!response.ok) {
      publishStatus.textContent = publishErrorText(response.status, data?.message);
      return false;
    }
    const url = typeof data?.url === 'string' ? data.url.trim() : '';
    const manageToken = typeof data?.manageToken === 'string' ? data.manageToken.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(url) || !manageToken || manageToken.length > 512) {
      publishStatus.textContent = '生成订阅链接失败，请稍后重试。';
      return false;
    }
    publication = { url, manageToken };
    publishedUrl.value = url;
    publishedBlock.hidden = false;
    copyPublished.disabled = false;
    revokePublished.disabled = false;
    resultPanel.hidden = false;
    publishStatus.textContent = current.hasWarnings
      ? `${PUBLISH_DONE}另有 ${current.warningCount} 项内容未完整转换，请检查原始订阅。`
      : PUBLISH_DONE;
    resultPanel.focus();
    return true;
  } catch (error) {
    controller.abort();
    if (requestRevision !== revision) return false;
    publishStatus.textContent = error?.name === 'TimeoutError'
      ? `生成订阅链接超过 ${Math.round(PUBLISH_TIMEOUT_MS / 1000)} 秒未完成，请检查网络后重试。`
      : '生成订阅链接失败，请检查网络后重试。';
    return false;
  }
}

sourceInput.addEventListener('input', () => {
  sourceInput.removeAttribute('aria-invalid');
  invalidate(sourceInput.value.trim() === submittedText);
});

form.querySelectorAll('input[name="target"]').forEach((input) => input.addEventListener('change', invalidate));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running || revoking) return;
  sourceInput.removeAttribute('aria-invalid');
  const text = sourceInput.value.trim();
  // Validate before touching the current result so a fixable input error does not
  // discard the link the user already generated.
  const problem = checkSource(text);
  if (problem) {
    showError(problem, sourceInput);
    return;
  }
  const targetInput = form.querySelector('input[name="target"]:checked');
  const target = targetInput?.value;
  if (target !== 'Surge' && target !== 'Mihomo') {
    showError('请选择输出格式：Surge 或 Mihomo。');
    return;
  }
  submittedText = text;
  invalidate();
  const requestRevision = revision;
  setRunning(true);
  publishStatus.textContent = '正在生成配置…';
  try {
    const converted = await withTimeout(convertSources({ target, sources: [text] }), CONVERT_TIMEOUT_MS);
    if (requestRevision !== revision) return;
    if (!converted || typeof converted.content !== 'string' || !converted.content.trim() || !Number.isInteger(converted.count) || converted.count < 1) {
      showError('没有可导出的节点，请检查订阅内容或切换输出格式。');
      return;
    }
    const warnings = Array.isArray(converted.warnings) ? converted.warnings : [];
    result = {
      content: converted.content,
      count: converted.count,
      target,
      hasWarnings: warnings.length > 0,
      warningCount: warnings.length,
    };
    configPreview.value = converted.content;
    // Conversion succeeded: hand the profile straight to the short-link service.
    publishStatus.textContent = '正在生成订阅链接…';
    await publishLink(result, requestRevision);
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      // The request keeps running in the background; drop whatever it returns.
      revision += 1;
      showError(`订阅读取超过 ${Math.round(CONVERT_TIMEOUT_MS / 1000)} 秒未完成，请检查网络后重试。`);
      return;
    }
    if (requestRevision !== revision) return;
    const known = error?.constructor?.name === 'ConversionError' || error?.name === 'ConversionError';
    showError(known ? cleanDiagnostic(error.message) : '订阅读取或转换失败。请检查链接、订阅内容与所选格式，然后重试。');
  } finally {
    // Always re-arm the single button: a newer keystroke only bumps `revision`,
    // it must not leave the entry point disabled.
    setRunning(false);
  }
});

copyPublished.addEventListener('click', async () => {
  if (!publication) return;
  const current = publication;
  const copiedNote = '订阅链接已复制，可直接导入代理软件。';
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(current.url);
    if (publication === current) publishStatus.textContent = copiedNote;
    return;
  } catch {
    if (publication !== current) return;
  }
  publishedUrl.focus();
  publishedUrl.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  publishStatus.textContent = copied
    ? copiedNote
    : '自动复制失败，链接已选中。请长按或使用 Ctrl+C 复制。';
});

revokePublished.addEventListener('click', async () => {
  if (!publication || revoking || running) return;
  const current = publication;
  revoking = true;
  publishButton.disabled = true;
  copyPublished.disabled = true;
  revokePublished.disabled = true;
  revokePublished.setAttribute('aria-busy', 'true');
  publishStatus.textContent = '正在撤销链接…';
  const controller = new AbortController();
  try {
    // Revoke by the short token from the URL; the manage token stays in the header.
    const shortToken = current.url.split('/').pop();
    const response = await withTimeout(fetch(`/api/publish/${encodeURIComponent(shortToken)}`, {
      method: 'DELETE',
      headers: { 'X-Manage-Token': current.manageToken },
      signal: controller.signal,
    }), PUBLISH_TIMEOUT_MS);
    if (publication !== current) return;
    // 404/410 mean the link is already gone, which is the outcome the user wanted.
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      const data = await readBody(response);
      if (publication !== current) return;
      publishStatus.textContent = publishErrorText(response.status, data?.message);
      return;
    }
    resetPublication('订阅链接已撤销，该网址已失效。');
  } catch (error) {
    controller.abort();
    if (publication !== current) return;
    publishStatus.textContent = error?.name === 'TimeoutError'
      ? '撤销请求超时，请稍后重试。'
      : '撤销失败，请检查网络后重试。';
  } finally {
    // The submit button is re-armed unconditionally: after a successful revoke
    // publication is null, and a guarded re-arm would leave it disabled for good.
    revoking = false;
    publishButton.disabled = running;
    if (publication === current) {
      revokePublished.removeAttribute('aria-busy');
      copyPublished.disabled = false;
      revokePublished.disabled = false;
    }
  }
});

if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  form.querySelector('input[value="Surge"]').checked = true;
} else if (/Windows/i.test(navigator.userAgent)) {
  form.querySelector('input[value="Mihomo"]').checked = true;
}

// About dialog. Native <dialog> handles Escape and the focus trap; the close button is
// a submit inside <form method="dialog">, so it also works when this module never runs.
const aboutDialog = document.getElementById('about-dialog');
const aboutTrigger = document.getElementById('about');
aboutTrigger?.addEventListener('click', () => {
  if (aboutDialog && !aboutDialog.open && typeof aboutDialog.showModal === 'function') aboutDialog.showModal();
});
// Touch browsers do not focus the button they activate, so the native focus return
// after close() can land on <body>; send it back to 关于 explicitly.
aboutDialog?.addEventListener('close', () => {
  if (aboutTrigger && (document.activeElement === null || document.activeElement === document.body)) aboutTrigger.focus();
});
aboutDialog?.addEventListener('click', (event) => {
  if (event.target !== aboutDialog) return;
  const bounds = aboutDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) {
    aboutDialog.close();
  }
});
