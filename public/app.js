import { convertSources } from './converter.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#convert-form');
const sourcesContainer = $('#sources');
const template = $('#source-template');
const resultPanel = $('#result');
const errorPanel = $('#error-panel');
const status = $('#status');
const generate = $('#generate');
const addSourceButton = $('#add-source');
const download = $('#download');
const copy = $('#copy');
const acceptPartial = $('#accept-partial');
// Same envelope the converter and the Worker enforce; checked before any request.
const MAX_SOURCES = 4;
const MAX_URL_LENGTH = 8192;
const CONVERT_TIMEOUT_MS = 90000;
// Exact test used by convertSources() in converter.js to treat a source as a link.
const URL_INPUT = /^https?:\/\/[^\s]+$/;
const URL_LINE = /^https?:\/\/\S+$/i;
let nextSourceId = 0;
let revision = 0;
let running = false;
let result = null;

class TimeoutError extends Error {
  constructor() {
    super('Conversion timed out');
    this.name = 'TimeoutError';
  }
}

function invalidate() {
  revision += 1;
  const hadResult = result !== null;
  result = null;
  resultPanel.hidden = true;
  $('#config-preview').value = '';
  errorPanel.hidden = true;
  download.disabled = true;
  copy.disabled = true;
  if (hadResult || running) status.textContent = '内容已更改，请重新生成。';
  else status.textContent = '';
}

function updateSourceLabels() {
  const cards = [...sourcesContainer.children];
  cards.forEach((card, index) => {
    card.querySelector('label').textContent = `订阅 ${index + 1}`;
    const remove = card.querySelector('.remove-source');
    remove.hidden = cards.length === 1;
    remove.setAttribute('aria-label', `移除订阅 ${index + 1}`);
  });
  $('#source-count').textContent = `${cards.length} 个来源`;
  // The converter refuses more than 4 sources, so stop the UI from offering them.
  const atLimit = cards.length >= MAX_SOURCES;
  addSourceButton.disabled = atLimit;
  addSourceButton.setAttribute('aria-disabled', String(atLimit));
  if (atLimit) addSourceButton.title = `最多 ${MAX_SOURCES} 个订阅来源`;
  else addSourceButton.removeAttribute('title');
}

function addSource(focus = false) {
  if (sourcesContainer.children.length >= MAX_SOURCES) return;
  const card = template.content.firstElementChild.cloneNode(true);
  const input = card.querySelector('textarea');
  input.id = `source-${++nextSourceId}`;
  card.querySelector('label').htmlFor = input.id;
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    invalidate();
  });
  card.querySelector('.remove-source').addEventListener('click', () => {
    const neighbor = card.nextElementSibling || card.previousElementSibling;
    card.remove();
    invalidate();
    updateSourceLabels();
    (neighbor?.querySelector('textarea') || $('#add-source')).focus();
  });
  sourcesContainer.append(card);
  updateSourceLabels();
  if (focus) {
    invalidate();
    input.focus();
  }
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

// Returns {index, message} for the first rejected source, or null.
function checkSources(texts) {
  if (texts.length > MAX_SOURCES) {
    return { index: MAX_SOURCES, message: `最多合并 ${MAX_SOURCES} 个订阅来源，请先移除多余的来源。` };
  }
  for (const [index, text] of texts.entries()) {
    const label = `订阅 ${index + 1}`;
    if (!text) {
      return {
        index,
        message: texts.length > 1
          ? `请在 ${label} 中粘贴链接或内容，或移除这个来源。`
          : '请粘贴订阅链接或订阅文本。',
      };
    }
    if (URL_INPUT.test(text)) {
      const problem = sourceUrlProblem(text);
      if (problem) return { index, message: `${label}：${problem}` };
      continue;
    }
    // Everything below is text conversion; catch the obvious "link pasted as text" cases.
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every((line) => URL_LINE.test(line))) {
      return { index, message: `${label} 包含多条链接；每个来源只填一个，其余请点“添加来源”。` };
    }
    if (lines.length === 1 && URL_LINE.test(lines[0])) {
      return { index, message: `${label} 的链接无法识别，请确认以小写 https:// 开头且不含空格。` };
    }
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
  const enabled = result && (!result.hasWarnings || acceptPartial.checked);
  download.disabled = !enabled;
  copy.disabled = !enabled;
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

addSourceButton.addEventListener('click', () => addSource(true));
form.querySelectorAll('input[name="target"]').forEach((input) => input.addEventListener('change', invalidate));
acceptPartial.addEventListener('change', updateExportState);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running) return;
  const inputs = [...sourcesContainer.querySelectorAll('textarea')];
  inputs.forEach((input) => input.removeAttribute('aria-invalid'));
  const texts = inputs.map((input) => input.value.trim());
  // Validate before touching the current result so a fixable input error does not
  // discard what the user already generated.
  const problem = checkSources(texts);
  if (problem) {
    showError(problem.message, inputs[problem.index]);
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
    const converted = await withTimeout(convertSources({ target, sources: texts }), CONVERT_TIMEOUT_MS);
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
      showError(`订阅读取超过 ${Math.round(CONVERT_TIMEOUT_MS / 1000)} 秒未完成，请检查网络或改用更少的来源后重试。`);
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

addSource();
if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  form.querySelector('input[value="Surge"]').checked = true;
} else if (/Windows/i.test(navigator.userAgent)) {
  form.querySelector('input[value="Mihomo"]').checked = true;
}
updateExportState();
