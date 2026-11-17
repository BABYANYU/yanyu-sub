import { convertSources } from './converter.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#convert-form');
const sourceInput = $('#source-input');
const resultPanel = $('#result');
const errorPanel = $('#error-panel');
const status = $('#status');
const generate = $('#generate');
const download = $('#download');
const copy = $('#copy');
const acceptPartial = $('#accept-partial');
const publishButton = $('#publish');
const publishTtl = $('#publish-ttl');
const publishStatus = $('#publish-status');
const publishedBlock = $('#published');
const publishedUrl = $('#published-url');
const publishedExpiry = $('#published-expiry');
const copyPublished = $('#copy-published');
const revokePublished = $('#revoke-published');
// Same envelope the converter and the Worker enforce; checked before any request.
const MAX_URL_LENGTH = 8192;
const CONVERT_TIMEOUT_MS = 90000;
const PUBLISH_TIMEOUT_MS = 30000;
// POST /api/publish accepts a TTL in seconds; the <select> offers exactly these.
const PUBLISH_TTLS = new Map([['86400', '1 天'], ['604800', '7 天'], ['2592000', '30 天']]);
// Exact test used by convertSources() in converter.js to treat a source as a link.
const URL_INPUT = /^https?:\/\/[^\s]+$/;
const URL_LINE = /^https?:\/\/\S+$/i;
let revision = 0;
let running = false;
let result = null;
// Live publication for the current result: {url, manageToken, expiresAt, ttlSeconds}.
// The manage token is deliberately memory-only — never a cookie, never storage.
let publication = null;
let publishing = false;
let revoking = false;

class TimeoutError extends Error {
  constructor() {
    super('Conversion timed out');
    this.name = 'TimeoutError';
  }
}

// Forget the hosted link locally. The manage token must never outlive the result it
// belongs to, and it is never persisted to any browser storage or a cookie.
function resetPublication(message = '') {
  publication = null;
  publishing = false;
  revoking = false;
  publishedBlock.hidden = true;
  publishedUrl.value = '';
  publishedExpiry.textContent = '';
  copyPublished.disabled = true;
  revokePublished.disabled = true;
  revokePublished.removeAttribute('aria-busy');
  publishButton.removeAttribute('aria-busy');
  publishButton.textContent = '生成订阅链接';
  publishStatus.textContent = message;
}

// expiresAt may arrive as ISO-8601, epoch seconds or epoch milliseconds. The UI only
// shows a short label, so anything unusable falls back to the TTL that was requested.
function publishedExpiryDate(value, ttlSeconds) {
  const candidate = typeof value === 'number'
    ? new Date(value < 1e12 ? value * 1000 : value)
    : typeof value === 'string' && value.trim() ? new Date(value) : null;
  if (candidate && Number.isFinite(candidate.getTime())) return candidate;
  return new Date(Date.now() + ttlSeconds * 1000);
}

function expiryLabel(date) {
  const remaining = date.getTime() - Date.now();
  if (remaining <= 0) return '链接已过期';
  const days = Math.round(remaining / 86400000);
  if (days >= 1) return `${days} 天后失效`;
  return `${Math.max(1, Math.round(remaining / 3600000))} 小时后失效`;
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
  if (typeof message === 'string' && message.trim()) return cleanDiagnostic(message);
  if (status === 403) return '请求来源校验失败，请刷新页面后重试。';
  if (status === 413) return '配置过大，无法生成订阅链接。';
  if (status === 429) return '生成太频繁，请稍后再试。';
  if (status === 503) return '订阅服务暂时不可用，请稍后重试。';
  return '生成订阅链接失败，请稍后重试。';
}

function invalidate() {
  revision += 1;
  const hadResult = result !== null;
  result = null;
  resetPublication();
  resultPanel.hidden = true;
  $('#config-preview').value = '';
  errorPanel.hidden = true;
  updateExportState();
  if (hadResult || running) status.textContent = '内容已更改，请重新生成。';
  else status.textContent = '';
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

function warningText(warning) {
  if (typeof warning === 'string') return cleanDiagnostic(warning);
  if (warning && typeof warning === 'object') {
    const node = warning.nodeName || warning.name;
    const reason = warning.message || warning.reason || warning.description;
    const source = Number.isInteger(warning.sourceIndex) ? `订阅 ${warning.sourceIndex + 1}` : '';
    const parts = [source, node, reason].filter((part) => typeof part === 'string' && part.trim());
    if (parts.length) return cleanDiagnostic(parts.join(' · '));
  }
  return '有内容未完整转换，请检查原始订阅。';
}

function showError(message, input = null) {
  $('#error-message').textContent = message;
  errorPanel.hidden = false;
  status.textContent = '';
  if (input) input.setAttribute('aria-invalid', 'true');
  // Focusing the offending field lets the user fix it immediately; without one,
  // move to the alert so the message is announced and reachable.
  if (input) input.focus();
  else errorPanel.focus();
}

function updateExportState() {
  const enabled = Boolean(result) && (!result.hasWarnings || acceptPartial.checked);
  download.disabled = !enabled;
  copy.disabled = !enabled;
  // Publishing is the third export path, so it follows the same "partial" gate.
  publishButton.disabled = !enabled || publishing || revoking;
}

// Credentials live in the generated profile: say so on every export path.
const CREDENTIAL_NOTE = '配置包含节点凭据，请勿公开分享。';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

sourceInput.addEventListener('input', () => {
  sourceInput.removeAttribute('aria-invalid');
  invalidate();
});

form.querySelectorAll('input[name="target"]').forEach((input) => input.addEventListener('change', invalidate));
acceptPartial.addEventListener('change', updateExportState);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running) return;
  sourceInput.removeAttribute('aria-invalid');
  const text = sourceInput.value.trim();
  // Validate before touching the current result so a fixable input error does not
  // discard what the user already generated.
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
  invalidate();
  const requestRevision = revision;
  running = true;
  generate.disabled = true;
  $('#generate-label').textContent = '正在生成…';
  generate.setAttribute('aria-busy', 'true');
  status.textContent = '正在读取并转换订阅，请稍候…';
  try {
    const converted = await withTimeout(convertSources({ target, sources: [text] }), CONVERT_TIMEOUT_MS);
    if (requestRevision !== revision) return;
    if (!converted || typeof converted.content !== 'string' || !converted.content.trim() || !Number.isInteger(converted.count) || converted.count < 1) {
      showError('没有可导出的节点，请检查订阅内容或切换输出格式。');
      return;
    }
    const warnings = Array.isArray(converted.warnings) ? converted.warnings : [];
    result = { content: converted.content, count: converted.count, target, hasWarnings: warnings.length > 0 };
    $('#result-title').textContent = warnings.length ? '部分配置已生成' : '配置已生成';
    $('#result-badge').textContent = warnings.length ? '请检查问题' : '已就绪';
    $('#result-summary').textContent = `${target} · ${converted.count} 个可用节点${warnings.length ? ` · ${warnings.length} 项转换问题` : ' · 可下载或复制'}`;
    $('#config-preview').value = converted.content;
    $('#warning-panel').hidden = warnings.length === 0;
    const list = $('#warning-list');
    list.replaceChildren();
    warnings.forEach((warning) => {
      const item = document.createElement('li');
      item.textContent = warningText(warning);
      list.append(item);
    });
    acceptPartial.checked = false;
    $('#accept-label').textContent = `我已查看问题，仅导出 ${converted.count} 个可用节点`;
    updateExportState();
    resultPanel.hidden = false;
    status.textContent = warnings.length ? '生成结果存在转换问题，请查看问题清单。' : `已生成 ${converted.count} 个节点的 ${target} 配置。`;
    resultPanel.focus();
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
    running = false;
    generate.disabled = false;
    generate.removeAttribute('aria-busy');
    $('#generate-label').textContent = '生成配置';
  }
});

publishButton.addEventListener('click', async () => {
  if (!result || publishing || revoking || publishButton.disabled) return;
  const ttlSeconds = PUBLISH_TTLS.has(publishTtl.value) ? Number(publishTtl.value) : 604800;
  const current = result;
  const requestRevision = revision;
  // A new link supersedes the old one: drop the previous URL and token first.
  resetPublication();
  publishing = true;
  publishButton.disabled = true;
  publishButton.setAttribute('aria-busy', 'true');
  publishButton.textContent = '生成中…';
  publishStatus.textContent = '正在生成订阅链接…';
  try {
    const response = await withTimeout(fetch('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: current.content, target: current.target, ttlSeconds }),
    }), PUBLISH_TIMEOUT_MS);
    if (requestRevision !== revision) return;
    const data = await readBody(response);
    if (requestRevision !== revision) return;
    if (!response.ok) {
      publishStatus.textContent = publishErrorText(response.status, data?.message);
      return;
    }
    const url = typeof data?.url === 'string' ? data.url.trim() : '';
    const manageToken = typeof data?.manageToken === 'string' ? data.manageToken.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(url) || !manageToken || manageToken.length > 512) {
      publishStatus.textContent = '生成订阅链接失败，请稍后重试。';
      return;
    }
    publication = { url, manageToken, expiresAt: publishedExpiryDate(data?.expiresAt, ttlSeconds) };
    publishedUrl.value = url;
    publishedExpiry.textContent = expiryLabel(publication.expiresAt);
    publishedBlock.hidden = false;
    copyPublished.disabled = false;
    revokePublished.disabled = false;
    publishStatus.textContent = `已生成订阅链接（有效期 ${PUBLISH_TTLS.get(String(ttlSeconds))}），可直接导入代理软件。`;
    publishButton.textContent = '重新生成';
  } catch (error) {
    if (requestRevision !== revision) return;
    publishStatus.textContent = error?.name === 'TimeoutError'
      ? `生成订阅链接超过 ${Math.round(PUBLISH_TIMEOUT_MS / 1000)} 秒未完成，请检查网络后重试。`
      : '生成订阅链接失败，请检查网络后重试。';
  } finally {
    if (requestRevision === revision) {
      publishing = false;
      publishButton.removeAttribute('aria-busy');
      if (!publication) publishButton.textContent = '生成订阅链接';
      updateExportState();
    }
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
  if (!publication || revoking) return;
  const current = publication;
  revoking = true;
  publishButton.disabled = true;
  copyPublished.disabled = true;
  revokePublished.disabled = true;
  revokePublished.setAttribute('aria-busy', 'true');
  publishStatus.textContent = '正在撤销订阅链接…';
  try {
    // Revoke by the short token from the URL; the manage token stays in the header.
    const shortToken = current.url.split('/').pop();
    const response = await withTimeout(fetch(`/api/publish/${encodeURIComponent(shortToken)}`, {
      method: 'DELETE',
      headers: { 'X-Manage-Token': current.manageToken },
    }), PUBLISH_TIMEOUT_MS);
    if (publication !== current) return;
    // 404/410 mean the link is already gone, which is the outcome the user wanted.
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      const data = await readBody(response);
      if (publication !== current) return;
      publishStatus.textContent = publishErrorText(response.status, data?.message);
      revoking = false;
      revokePublished.removeAttribute('aria-busy');
      copyPublished.disabled = false;
      revokePublished.disabled = false;
      updateExportState();
      return;
    }
    resetPublication('订阅链接已撤销，该网址已失效。');
    updateExportState();
  } catch (error) {
    if (publication !== current) return;
    publishStatus.textContent = error?.name === 'TimeoutError'
      ? '撤销请求超时，请稍后重试。'
      : '撤销失败，请检查网络后重试。';
    revoking = false;
    revokePublished.removeAttribute('aria-busy');
    copyPublished.disabled = false;
    revokePublished.disabled = false;
    updateExportState();
  }
});

download.addEventListener('click', () => {
  if (!result || download.disabled) return;
  const extension = result.target === 'Surge' ? 'conf' : 'yaml';
  const blob = new Blob([result.content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `yanyu-${result.target.toLowerCase()}${result.hasWarnings ? '-partial' : ''}.${extension}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  status.textContent = result.hasWarnings
    ? `已发起部分配置下载，请保留上方问题清单。${CREDENTIAL_NOTE}`
    : `已发起下载，请在浏览器下载列表中查看。${CREDENTIAL_NOTE}`;
});

copy.addEventListener('click', async () => {
  if (!result || copy.disabled) return;
  const current = result;
  const done = current.hasWarnings
    ? `已复制可用节点配置，请保留上方问题清单。${CREDENTIAL_NOTE}`
    : `配置已复制。${CREDENTIAL_NOTE}`;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(current.content);
    if (result === current) status.textContent = done;
  } catch {
    if (result !== current) return;
    $('.preview').open = true;
    const preview = $('#config-preview');
    preview.focus();
    preview.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    if (copied) {
      status.textContent = done;
      return;
    }
    status.textContent = `自动复制失败，已选中配置。请长按或使用 Ctrl+C 复制，也可下载配置。${CREDENTIAL_NOTE}`;
  }
});

if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  form.querySelector('input[value="Surge"]').checked = true;
} else if (/Windows/i.test(navigator.userAgent)) {
  form.querySelector('input[value="Mihomo"]').checked = true;
}
updateExportState();
