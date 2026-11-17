import { convertSources } from './converter.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#convert-form');
const sourcesContainer = $('#sources');
const template = $('#source-template');
const resultPanel = $('#result');
const errorPanel = $('#error-panel');
const status = $('#status');
const generate = $('#generate');
const download = $('#download');
const copy = $('#copy');
const acceptPartial = $('#accept-partial');
let nextSourceId = 0;
let revision = 0;
let running = false;
let result = null;

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
}

function addSource(focus = false) {
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
    .replace(/(?:https?|ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic):\/\/[^\s<>"'，。；]+/gi, '[链接已隐藏]')
    .replace(/(?:token|password|passwd|secret|authorization|api[-_]?key)\s*[:=]\s*[^\s,，;；]+/gi, '[凭据已隐藏]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 500);
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
  errorPanel.focus();
}

function updateExportState() {
  const enabled = result && (!result.hasWarnings || acceptPartial.checked);
  download.disabled = !enabled;
  copy.disabled = !enabled;
}

$('#add-source').addEventListener('click', () => addSource(true));
form.querySelectorAll('input[name="target"]').forEach((input) => input.addEventListener('change', invalidate));
acceptPartial.addEventListener('change', updateExportState);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running) return;
  invalidate();
  const inputs = [...sourcesContainer.querySelectorAll('textarea')];
  const empty = inputs.find((input) => !input.value.trim());
  if (empty) {
    const index = inputs.indexOf(empty) + 1;
    showError(`请在订阅 ${index} 中粘贴链接或内容，或移除这个来源。`, empty);
    return;
  }
  const sources = inputs.map((input) => input.value.trim());
  const target = form.querySelector('input[name="target"]:checked').value;
  const requestRevision = revision;
  running = true;
  generate.disabled = true;
  $('#generate-label').textContent = '正在生成…';
  generate.setAttribute('aria-busy', 'true');
  status.textContent = '正在读取并转换订阅，请稍候…';
  try {
    const converted = await convertSources({ target, sources });
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
  status.textContent = result.hasWarnings ? '已发起部分配置下载，请保留上方问题清单。' : '已发起下载，请在浏览器下载列表中查看。';
});

copy.addEventListener('click', async () => {
  if (!result || copy.disabled) return;
  const current = result;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(current.content);
    if (result === current) status.textContent = current.hasWarnings ? '已复制可用节点配置，请保留上方问题清单。' : '配置已复制。';
  } catch {
    if (result !== current) return;
    $('.preview').open = true;
    const preview = $('#config-preview');
    preview.focus();
    preview.select();
    status.textContent = '自动复制失败，已选中配置。请长按或使用 Ctrl+C 复制，也可下载配置。';
  }
});

addSource();
if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  form.querySelector('input[value="Surge"]').checked = true;
} else if (/Windows/i.test(navigator.userAgent)) {
  form.querySelector('input[value="Mihomo"]').checked = true;
}
updateExportState();
