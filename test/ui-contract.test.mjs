// UI ↔ script ↔ converter contract. The UI is plain HTML/CSS/ES modules with no
// framework and no bundler step, so a redesigned markup file can silently break
// app.js (null selectors, renamed radio values) or the CSP (inline styles,
// inline scripts). These checks pin the interface, not the visual design.
//
// The current design is one-step: the single primary button converts the profile
// and publishes the permanent short link in the same submit, so there is no
// separate "generate", "download", "copy" or "validity" step to assert any more.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {convertTexts, ConversionError} from '../public/converter.js';

const html = await fs.readFile('public/index.html', 'utf8');
const css = await fs.readFile('public/style.css', 'utf8');
const app = await fs.readFile('public/app.js', 'utf8');
const readme = await fs.readFile('README.md', 'utf8');

const ids = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((match) => match[1]));
const classesUsed = new Set([...html.matchAll(/\bclass\s*=\s*"([^"]*)"/g)]
  .flatMap((match) => match[1].split(/\s+/)).filter(Boolean));

test('every id app.js looks up exists exactly once in index.html', () => {
  const wanted = new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map((match) => match[1]));
  assert.ok(wanted.size >= 10, 'app.js should still query its known anchors');
  for (const id of wanted) {
    assert.ok(ids.has(id), `app.js queries #${id} but index.html does not define it`);
    const occurrences = [...html.matchAll(new RegExp(`\\bid\\s*=\\s*"${id}"`, 'g'))].length;
    assert.equal(occurrences, 1, `#${id} must be unique`);
  }
});

test('app.js only uses the selectors offered by the markup', () => {
  const queried = [...app.matchAll(/(?:\$|querySelector|querySelectorAll)\(\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(queried.length > 0);
  for (const selector of queried) {
    if (selector.startsWith('#')) assert.ok(ids.has(selector.slice(1)), `missing ${selector}`);
    if (selector.startsWith('.') && !selector.includes(' ') && !selector.includes('[')) {
      assert.ok(classesUsed.has(selector.slice(1)), `missing ${selector} in markup`);
    }
  }
});

test('the two-step interface is gone: no generate/download/copy/validity controls', () => {
  for (const id of ['generate', 'generate-label', 'download', 'copy', 'publish-ttl', 'published-expiry',
    'result-badge', 'result-summary', 'warning-panel', 'warning-list', 'accept-partial', 'accept-label', 'status']) {
    assert.equal(ids.has(id), false, `#${id} belongs to the removed two-step interface`);
  }
  // No leftover copy for the removed steps.
  for (const copy of ['生成配置', '配置已生成', '部分配置已生成', '已就绪', '结果摘要', '下载配置', '复制配置', '有效期']) {
    assert.equal(html.includes(copy), false, `markup must not mention "${copy}"`);
  }
  // …and app.js must not query or drive them either.
  assert.doesNotMatch(app, /#(?:generate|download|copy|publish-ttl|published-expiry|accept-partial)\b(?!-published)/);
  assert.doesNotMatch(app, /\bttlSeconds\b/, 'the client must not ask for a lifetime');
  assert.doesNotMatch(app, /download|createObjectURL/, 'the download path is gone');
});

test('#publish is the only submit entry point and it publishes the link', () => {
  // The about dialog's close button is a submit inside <form method="dialog"> on
  // purpose, so only the conversion form is counted here.
  const convertBlock = html.slice(html.indexOf('<form id="convert-form"'), html.indexOf('</form>'));
  const submits = [...convertBlock.matchAll(/<button\b[^>]*type="submit"[^>]*>/g)].map((match) => match[0]);
  assert.equal(submits.length, 1, 'exactly one submit control may exist in the conversion form');
  const buttonTag = html.match(/<button[^>]*id="publish"[^>]*>/)?.[0] || '';
  assert.ok(buttonTag, '#publish must exist');
  assert.equal(buttonTag, submits[0], '#publish must be the submit control');
  assert.match(buttonTag, /class="[^"]*\bbutton-primary\b/);
  assert.match(html, /<button id="publish"[^>]*>生成订阅链接<\/button>/);
  // A second entry point (a stray type=button inside the form) would bypass validation.
  const formBlock = html.slice(html.indexOf('<form id="convert-form"'), html.indexOf('</form>'));
  assert.equal([...formBlock.matchAll(/<button\b/g)].length, 1, 'the form holds only the publish button');
  assert.match(formBlock, /id="publish"/);
  assert.match(html.match(/<form[^>]*>/)?.[0] || '', /novalidate/, 'custom validation replaces the native one');
  // Enter in the textarea or a radio must run the same handler.
  assert.match(app, /form\.addEventListener\('submit', async \(event\) => \{\n {2}event\.preventDefault\(\);/);
  assert.equal([...app.matchAll(/addEventListener\('submit'/g)].length, 1);
});

test('conversion is followed by an automatic publish in the same submit', () => {
  const convertAt = app.indexOf('convertSources({ target, sources: [text] })');
  const publishAt = app.indexOf('await publishLink(result, requestRevision);');
  assert.ok(convertAt > -1, 'the submit handler must still reuse convertSources()');
  assert.ok(publishAt > convertAt, 'the publish call must come after a successful conversion');
  // Both stages live inside the one submit handler, behind the same running guard.
  const handler = app.slice(app.indexOf("form.addEventListener('submit'"), app.indexOf("copyPublished.addEventListener('click'"));
  assert.match(handler, /convertSources\(/);
  assert.match(handler, /publishLink\(/);
  assert.match(handler, /withTimeout\(/);
  assert.match(app, /async function publishLink\(current, requestRevision\)[\s\S]{0,400}withTimeout\(fetch\('\/api\/publish'/);
  // No publish-button click listener survives: publishing is not a second click.
  assert.doesNotMatch(app, /publishButton\.addEventListener\('click'/);
  assert.match(app, /publishButton\.disabled = value;/, 'the single button is gated while it runs');
  assert.match(app, /setRunning\(false\);\n {2}\}\n\}\);/, 'the button must be re-armed in finally');
});

test('the publish request body carries content and target only', () => {
  assert.match(app, /fetch\('\/api\/publish', \{/);
  assert.match(app, /method: 'POST'/);
  assert.match(app, /'Content-Type': 'application\/json'/);
  const body = app.match(/body: JSON\.stringify\((\{[^}]*\})\)/)?.[1] || '';
  assert.ok(body, 'the request body must be a literal object');
  assert.equal(body, '{ content: current.content, target: current.target }');
  assert.doesNotMatch(body, /ttl/i, 'no lifetime may be requested');
  // The response fields the UI still depends on.
  for (const field of ['data?.url', 'data?.manageToken']) assert.ok(app.includes(field), `app.js must read ${field}`);
  assert.match(app, /data\?\.message/);
  assert.match(app, /withTimeout\(fetch\(`\/api\/publish\//, 'revoking must reuse withTimeout()');
  assert.match(app, /error\?\.name === 'TimeoutError'/);
});

test('a successful publish clears the status unless there are conversion warnings', () => {
  assert.doesNotMatch(app, /订阅链接已生成/);
  assert.doesNotMatch(html, /链接默认永久有效/);
  assert.match(app, /publishStatus\.textContent = current\.hasWarnings[\s\S]{0,120}未完整转换[\s\S]{0,80}: '';/);
  // Both intermediate stages are announced with the requested wording.
  assert.match(app, /publishStatus\.textContent = '正在生成配置…';/);
  assert.match(app, /publishStatus\.textContent = '正在生成订阅链接…';/);
  // The status line is the only live region and it is announced politely.
  const statusTag = html.match(/<[^>]*id="publish-status"[^>]*>/)?.[0] || '';
  assert.match(statusTag, /role="status"/);
  assert.match(statusTag, /aria-live="polite"/);
  assert.match(statusTag, /aria-atomic="true"/);
  // It has to sit outside #result, otherwise progress text would be invisible
  // while the result panel is still hidden.
  assert.ok(html.indexOf('id="publish-status"') < html.indexOf('<section id="result"'));
});

test('failures stay inline: alert panel for input, status line after conversion', () => {
  assert.doesNotMatch(app, /\balert\s*\(|window\.confirm/, 'no blocking dialogs');
  assert.match(app, /function showError\(message, input = null\)/);
  assert.match(app, /\$\('#error-message'\)\.textContent = message;/);
  assert.match(app, /errorPanel\.hidden = false;/);
  assert.match(app, /publishStatus\.textContent = publishErrorText\(response\.status, data\?\.message\)/, 'publish failures are inline');
  assert.match(app, /function publishErrorText\(status, message\)[\s\S]{0,140}cleanDiagnostic\(message\)/, 'server text must be scrubbed');
  assert.doesNotMatch(app, /innerHTML/, 'diagnostics go through textContent only');
  assert.doesNotMatch(app, /outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\s*\(/);
});

test('the result shows a collapsed read-only preview for the published configuration', () => {
  const details = html.match(/<details class="preview">([\s\S]*?)<\/details>/)?.[1] || '';
  assert.match(details, /<summary>查看配置<\/summary>/);
  assert.match(details, /<textarea[^>]*id="config-preview"[^>]*readonly/);
  assert.match(app, /configPreview\.value = current\.content;/);
  const reset = functionBody(app, 'resetPublication');
  assert.match(reset, /resultPanel\.hidden = true;/);
  assert.match(reset, /configPreview\.value = '';/);
});

test('the source area is a single textarea wired to the converter', () => {
  const area = html.match(/<textarea[^>]*id="source-input"[^>]*>/)?.[0] || '';
  assert.ok(area, 'a single #source-input must exist');
  assert.match(area, /class="[^"]*\bsource-input\b/);
  assert.match(area, /aria-describedby="sources-help"/);
  assert.ok(ids.has('sources-help'));
  assert.equal(ids.has('sources'), false, 'multi-source container must be gone');
  assert.equal(ids.has('source-template'), false, 'multi-source template must be gone');
  assert.equal(ids.has('add-source'), false, 'add-source control must be gone');
  assert.match(app, /\$\(\s*'#source-input'\s*\)/);
  assert.match(app, /sources: \[text\]/);
});

test('radio values stay identical to the converter target whitelist', () => {
  const values = [...html.matchAll(/name="target"[^>]*value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ['Surge', 'Mihomo']);
  // One preset must be checked so app.js can read :checked on first submit.
  assert.equal([...html.matchAll(/name="target"[^>]*checked/g)].length, 1);
  assert.match(html, /name="target" value="Surge" checked/);
  assert.match(app, /input\[name="target"\]\[value="Surge"\]'\)\.checked = true/);
  // The value must come from the checked radio, not from a hardcoded default.
  assert.match(app, /input\[name="target"\]:checked/);
  assert.match(app, /targetInput\?\.value|input\[name="target"\]:checked'\)\.value/);
  for (const value of values) {
    const converted = convertTexts({target: value, sources: ['{"proxies":[{"name":"N","type":"trojan","server":"node.example.com","port":443,"password":"p"}]}']});
    assert.ok(converted.content.length > 0, `${value} must be accepted by convertTexts`);
  }
});

test('result and error panels stay hidden until app.js reveals them', () => {
  for (const id of ['result', 'error-panel', 'published']) {
    const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] || '';
    assert.match(tag, /\bhidden\b/, `#${id} must render hidden to avoid a flash of stale state`);
  }
  // #result and #error-panel are focused after disclosure, so they need tabindex=-1.
  assert.match(html.match(/<section[^>]*id="result"[^>]*>/)?.[0] || '', /tabindex="-1"/);
  assert.match(html.match(/<section[^>]*id="error-panel"[^>]*>/)?.[0] || '', /tabindex="-1"/);
  // .notice / .result style display; without the [hidden] guard the hidden
  // attribute would be overridden and every panel would show at once.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'CSS must keep [hidden]{display:none!important}');
});

test('every class used by the markup has a style rule (class-rename drift)', () => {
  const missing = [...classesUsed].filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css));
  assert.deepEqual(missing, [], 'classes used in index.html without a CSS rule');
});

test('markup stays compatible with the strict CSP the Worker sends', () => {
  assert.doesNotMatch(html, /<style[\s>]/i, 'style-src \'self\' forbids inline <style>');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'style-src \'self\' forbids style attributes');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'script-src \'self\' forbids inline handlers');
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) assert.match(match[1], /\bsrc=/, 'scripts must be external');
  assert.doesNotMatch(html, /\bsrc\s*=\s*"https?:/i, 'no cross-origin subresource may be loaded');
  assert.doesNotMatch(html, /<link\b[^>]*\bhref\s*=\s*"https?:/i, 'no cross-origin stylesheet may be linked');
  assert.match(html, /<a class="about-contact" href="https:\/\/t\.me\/[^"]+" target="_blank" rel="noopener noreferrer">/, 'external links must be navigation-only and isolated');
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i, 'CSP default-src \'self\' blocks remote CSS/fonts');
  // The module entry point must load through the same relative path the Worker serves.
  assert.match(html, /<script type="module" src="\.\/app\.js">/);
  assert.match(html, /<link rel="stylesheet" href="\.\/style\.css">/);
  // No new runtime dependency.
  const imports = [...app.matchAll(/^import\s.+?from\s+'([^']+)';/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./converter.js']);
});

test('converter error contract used by app.js keeps its names', () => {
  // app.js checks error.constructor.name first and error.name second. The
  // minified bundle renames the class binding (constructor.name === 'g0'), so
  // ONLY `error.name` survives minification — app.js must keep that fallback.
  assert.equal(new ConversionError('x').name, 'ConversionError');
  const thrown = (() => { try { convertTexts({target: 'Surge', sources: []}); } catch (error) { return error; } })();
  assert.equal(thrown.name, 'ConversionError');
  assert.ok(thrown instanceof ConversionError);
  assert.match(app, /error\?\.name === 'ConversionError'/, 'app.js must detect ConversionError by name, not only by constructor.name');
});

test('convertSources result shape satisfies the checks in app.js', () => {
  const converted = convertTexts({target: 'Mihomo', sources: ['{"proxies":[{"name":"N","type":"trojan","server":"node.example.com","port":443,"password":"p"}]}']});
  assert.equal(typeof converted.content, 'string');
  assert.ok(converted.content.trim().length > 0);
  assert.ok(Number.isInteger(converted.count) && converted.count >= 1);
  assert.ok(Array.isArray(converted.warnings));
  // The submit handler still validates the shape before it publishes anything.
  assert.match(app, /typeof converted\.content !== 'string'/);
  assert.match(app, /Number\.isInteger\(converted\.count\)/);
  assert.match(app, /Array\.isArray\(converted\.warnings\)/);
  // The warning flag is carried onto the publication so the success line can mention it.
  assert.match(app, /hasWarnings: warnings\.length > 0/);
  assert.match(app, /current\.hasWarnings/);
  const call = app.match(/convertSources\(\{([^}]*)\}/);
  assert.ok(call, 'app.js must call convertSources with an options object');
  assert.match(call[1], /\btarget\b/);
  assert.match(call[1], /\bsources\b/);
});

test('README keeps disclosing that link sources are fetched by this site', () => {
  assert.match(readme, /Cloudflare Worker 拉取/);
});

test('page chrome omits the source links and footer copy', () => {
  assert.doesNotMatch(html, /class="quiet-link"/);
  assert.doesNotMatch(html, /class="site-footer"/);
  assert.doesNotMatch(html, /privacy-note/);
});

test('app.js does not call functions removed with the multi-source UI', () => {
  for (const name of ['addSource', 'updateSourceLabels', 'checkSources', 'updateExportState', 'warningText']) {
    assert.doesNotMatch(app, new RegExp(`\\b${name}\\s*\\(`), `${name}() was removed with the multi-source UI`);
  }
});

// ---------- permanent hosted short subscribe link (POST /api/publish) ----------

// Minimal brace matcher: every function here is plain JS, and the ${...} holes in
// template literals are balanced, so depth counting recovers the body reliably.
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, - 1, `function ${name}() must exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

function resultBlock() {
  const start = html.indexOf('<section id="result"');
  const end = html.indexOf('</section>', start);
  assert.ok(start > -1 && end > start, '#result must stay a <section>');
  return html.slice(start, end);
}

test('the result panel hosts the subscribe link with copy and revoke', () => {
  const block = resultBlock();
  for (const id of ['published', 'published-url', 'copy-published', 'revoke-published']) {
    const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0] || '';
    assert.ok(tag, `#${id} must exist in index.html`);
    assert.ok(block.includes(`id="${id}"`), `#${id} must live inside #result`);
    assert.equal([...html.matchAll(new RegExp(`\\bid\\s*=\\s*"${id}"`, 'g'))].length, 1, `#${id} must be unique`);
  }
  // The link itself is read-only and never becomes an anchor the page navigates to.
  const urlTag = html.match(/<input[^>]*id="published-url"[^>]*>/)?.[0] || '';
  assert.match(urlTag, /readonly/);
  assert.match(urlTag, /type="text"/);
  assert.doesNotMatch(block, /<a\b[^>]*id="published-url"/);
  // Both token actions are plain buttons, never submits.
  for (const id of ['copy-published', 'revoke-published']) {
    assert.match(html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] || '', /type="button"/);
  }
});

test('revoking addresses the short token and keeps the manage token in a header', () => {
  assert.match(app, /const shortToken = current\.url\.split\('\/'\)\.pop\(\);/, 'the short token comes from the published URL');
  assert.match(app, /fetch\(`\/api\/publish\/\$\{encodeURIComponent\(shortToken\)\}`, \{/);
  assert.match(app, /method: 'DELETE'/);
  assert.match(app, /'X-Manage-Token': current\.manageToken/);
  assert.doesNotMatch(app, /\/api\/publish\/\$\{encodeURIComponent\(current\.manageToken\)\}/);
  // 404/410 means already gone, which is the outcome the user wanted.
  assert.match(app, /response\.status !== 404 && response\.status !== 410/);
  assert.match(app, /resetPublication\('订阅链接已撤销，该网址已失效。'\)/);
});

test('an edited source, a format switch or a new publish clears the old link', () => {
  const invalidateBody = functionBody(app, 'invalidate');
  assert.match(invalidateBody, /resetPublication\(\)/, 'invalidate() must drop the published link and token');
  const resetBody = functionBody(app, 'resetPublication');
  assert.match(resetBody, /publication = null/, 'the manage token must not outlive a reset');
  assert.match(resetBody, /publishedBlock\.hidden = true/, 'the link block must be hidden again');
  assert.match(resetBody, /publishedUrl\.value = ''/, 'the URL field must be emptied');
  assert.match(resetBody, /publishStatus\.textContent = message/, 'stale status text must be cleared');
  assert.match(resetBody, /copyPublished\.disabled = true/);
  assert.match(resetBody, /revokePublished\.disabled = true/);
  // invalidate() is wired to both inputs that can invalidate a link.
  // An input event invalidates unless the text still equals what was submitted, so a
  // typo the user undoes immediately cannot silently destroy the manage token.
  assert.match(app, /sourceInput\.addEventListener\('input',[\s\S]{0,120}invalidate\(sourceInput\.value\.trim\(\) === submittedText\)/);
  assert.match(app, /input\[name="target"\]'\)\.forEach\(\(input\) => input\.addEventListener\('change', invalidate\)\)/);
  // invalidate() runs on every submit, so a regenerated profile also drops the link.
  assert.match(app, /invalidate\(\);\n {2}const requestRevision = revision;/);
});

test('the manage token never leaves memory', () => {
  assert.doesNotMatch(app, /localStorage|sessionStorage|indexedDB|document\.cookie/, 'the token must stay in a module variable');
  assert.doesNotMatch(app, /console\.(?:log|info|debug|warn|error)\(/, 'never print the token');
  assert.match(app, /let publication = null/, 'the publication lives in module state');
  // Copy and revoke must not run without a live publication.
  assert.match(app, /copyPublished\.addEventListener\('click',[\s\S]{0,80}if \(!publication\) return;/);
  assert.match(app, /revokePublished\.addEventListener\('click',[\s\S]{0,80}if \(!publication \|\| revoking \|\| running\) return;/);
});

test('the page fits a 375px viewport without horizontal overflow', () => {
  // The primary action is a full-width block button, never a fixed-width control.
  assert.match(css, /#publish \{[^}]*width:\s*100%/, 'the single button must fill the card');
  assert.doesNotMatch(css, /#publish \{[^}]*width:\s*\d+px/);
  assert.match(css, /\.published-url\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.published-url\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.published-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.published-actions\s+\.button\s*\{[^}]*min-width:\s*0/);
  // Long URLs must not push the layout wider than the card.
  assert.match(css, /\.publish-status\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.published-url\s*\{[^}]*min-width:\s*0/);
  // No rule may hard-code a width wider than the 375px viewport minus padding.
  const wide = [...css.matchAll(/^\s*(?:min-)?width:\s*(\d+)px/gm)].map((match) => Number(match[1])).filter((px) => px > 335);
  assert.deepEqual(wide, [], 'no fixed width may exceed the 375px content box');
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.shell \{ padding: 0 20px; \}/);
});
test('day/night theme toggle and palette are wired without inline script', async () => {
  assert.match(html, /<script src="\.\/theme\.js"><\/script>/, 'theme script must load before paint');
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /id="theme-label"/);
  assert.match(css, /:root\[data-theme="dark"\]/, 'dark palette must be selectable');
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /\.theme-toggle\s*\{/);
  const theme = await (await import('node:fs/promises')).readFile(new URL('../public/theme.js', import.meta.url), 'utf8');
  for (const token of ["'auto'", "'light'", "'dark'", 'localStorage', "document.documentElement.dataset.theme", 'theme-toggle']) {
    assert.ok(theme.includes(token), `theme.js should handle ${token}`);
  }
  assert.doesNotMatch(theme, /<script|innerHTML/, 'theme.js must stay a plain external script');
});
test('about dialog mirrors the reference site and opens without inline script', () => {
  assert.match(html, /id="about"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /<dialog id="about-dialog"/);
  assert.match(html, /id="about-close"/);
  assert.match(html, /class="about-title"[^>]*><strong>YANYU<\/strong> Sub/);
  assert.match(html, /由 <strong>YANYU<\/strong> 设计与维护/);
  assert.match(html, /https:\/\/t\.me\/\+88807915423/);
  assert.match(html, /网站设计版权归 YANYU 所有/);
  for (const rule of ['#about-dialog {', '#about-dialog::backdrop', '.about-title {', '.about-contact {', '.header-actions {']) {
    assert.ok(css.includes(rule), `missing ${rule}`);
  }
  assert.match(app, /showModal\(\)/);
  assert.match(app, /aboutDialog\.close\(\)/);
  assert.match(app, /getBoundingClientRect\(\)/);
});

// ---------------------------------------------------------------------------
// Hardening regressions: about dialog, touch targets, contrast, theme behaviour
// (driven through a fake DOM in node:vm), and the publish/revoke state machine.
// ---------------------------------------------------------------------------
const {runInNewContext} = await import('node:vm');
const theme = await fs.readFile('public/theme.js', 'utf8');

// --- about dialog -----------------------------------------------------------

test('the about dialog closes without app.js: close is a dialog-form submit', () => {
  const dialog = html.slice(html.indexOf('<dialog id="about-dialog"'), html.indexOf('</dialog>'));
  assert.match(dialog, /<form method="dialog"/, 'the native dialog form is the no-script close path');
  const closeTag = dialog.match(/<button[^>]*id="about-close"[^>]*>/)?.[0] || '';
  assert.ok(closeTag, '#about-close must exist');
  assert.match(closeTag, /type="submit"/, 'a submit closes <form method="dialog"> even with no script at all');
  assert.match(closeTag, /aria-label="关闭关于"/);
  // …therefore app.js must not intercept it and defeat the native submit.
  assert.doesNotMatch(app, /getElementById\('about-close'\)/, 'closing must not depend on a script hook');
  assert.doesNotMatch(app, /preventDefault\(\);\n\s*if \(aboutDialog\?\.open\) aboutDialog\.close\(\)/);
  // The icon-only control keeps a 44px hit area.
  assert.match(css, /#about-close \{[^}]*width:\s*44px[^}]*height:\s*44px/);
});

test('the close button stays reachable while the dialog scrolls', () => {
  const rule = css.match(/\.about-close-form\s*\{[^}]*\}/)?.[0] || '';
  assert.match(rule, /position:\s*sticky/, 'the close row must stick to the dialog scrollport');
  assert.match(rule, /top:\s*0/);
  assert.doesNotMatch(rule, /position:\s*absolute/, 'an absolute close button scrolls out of sight');
  assert.match(rule, /height:\s*0/, 'the sticky row must not push the title down');
  assert.match(css, /#about-dialog \{[^}]*overflow:\s*auto/, 'the dialog is the scroll container');
  assert.match(css, /#about-dialog \{[^}]*max-height:\s*calc\(100dvh - 48px\)/, 'a tall dialog must be capped to the viewport');
});

test('closing the dialog returns focus to 关于, including on touch', () => {
  assert.match(app, /aboutDialog\?\.addEventListener\('close'/);
  assert.match(app, /document\.activeElement === document\.body\)\) aboutTrigger\.focus\(\)/,
    'touch browsers never focus the button they activate, so focus must be restored by hand');
  // Escape and the backdrop keep working through the native close path.
  assert.match(app, /aboutDialog\.close\(\)/);
  assert.match(app, /getBoundingClientRect\(\)/);
});

test('every text control is at least 44px on the touch path', () => {
  for (const selector of ['.theme-toggle', '.about-link']) {
    const rule = css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0] || '';
    assert.match(rule, /min-height:\s*44px/, `${selector} must be 44px tall`);
    assert.match(rule, /min-width:\s*44px/, `${selector} must be 44px wide (2 CJK glyphs are only ~32px)`);
    assert.match(rule, /justify-content:\s*center/);
  }
  for (const selector of ['.about-contact', '.published-actions .button']) {
    const pattern = new RegExp(`${selector.replace(/[.]/g, '\\.').replace(/ /g, '\\s+')}\\s*\\{[^}]*\\}`);
    assert.match(css.match(pattern)?.[0] || '', /min-height:\s*44px/, `${selector} must be 44px tall`);
  }
  // Nothing may declare a smaller floor (0–43px) for a tappable box.
  const tooSmall = [...css.matchAll(/min-height:\s*(\d+)px/g)].map((m) => Number(m[1])).filter((px) => px < 44);
  assert.deepEqual(tooSmall, [], 'no interactive floor may be below 44px');
});

// --- colour contrast --------------------------------------------------------

function palette(block) {
  return Object.fromEntries([...block.matchAll(/(--[a-z][\w-]*):\s*(#[0-9a-fA-F]{3,8})\b/g)].map((m) => [m[1].slice(2), m[2]]));
}
function channel(value) {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(full.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('both palettes keep every text pair above 4.5:1', () => {
  const light = palette(css.match(/:root \{([\s\S]*?)\n\}/)[1]);
  const dark = palette(css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]);
  for (const [name, p] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of [['ink', 'bg'], ['ink', 'surface'], ['ink', 'field'], ['muted', 'bg'],
      ['muted', 'surface'], ['muted', 'field'], ['danger', 'danger-bg']]) {
      const ratio = contrast(p[fg], p[bg]);
      assert.ok(ratio >= 4.5, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below AA 4.5:1`);
    }
    // The one filled button: white on the brand blue, idle and hovered.
    for (const bg of ['blue', 'blue-hover']) {
      const ratio = contrast('#ffffff', p[bg]);
      assert.ok(ratio >= 4.5, `${name}: primary button text on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('no dead palette token or style rule is left behind', () => {
  const declared = new Set([...css.matchAll(/^\s*(--[a-z][\w-]*):/gm)].map((m) => m[1]));
  const unused = [...declared].filter((name) => !css.includes(`var(${name})`));
  assert.deepEqual(unused, [], 'every custom property must be referenced');
  const ruleClasses = [...new Set([...css.matchAll(/^\.([a-z][\w-]*)/gm)].map((m) => m[1]))];
  const orphaned = ruleClasses.filter((name) => !classesUsed.has(name));
  assert.deepEqual(orphaned, [], 'every styled class must be used by the markup');
});

// --- theme.js, executed against a fake DOM ---------------------------------

function themeEnv({now, stored = {}, throwOnRead = false, throwOnWrite = false, hasToggle = true} = {}) {
  const state = {now: now || new Date(2026, 4, 12, 12, 0, 0)};
  const timers = [];
  const docEvents = {};
  const winEvents = {};
  const store = new Map(Object.entries(stored));
  const writes = [];
  const element = (props = {}) => {
    const bag = {};
    return Object.assign({
      hidden: true,
      attrs: {},
      textContent: '',
      addEventListener(type, fn) { (bag[type] || (bag[type] = [])).push(fn); },
      fire(type, event) { for (const fn of bag[type] || []) fn(event || {}); },
      setAttribute(name, value) { this.attrs[name] = value; },
    }, props);
  };
  const toggle = element();
  const label = element();
  const meta = element();
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(state.now.getTime());
      else if (args.length === 1 && args[0] instanceof Date) super(args[0].getTime());
      else super(...args);
    }
    static now() { return state.now.getTime(); }
  }
  const document = {
    readyState: 'loading',
    hidden: false,
    documentElement: {dataset: {}},
    addEventListener(type, fn) { (docEvents[type] || (docEvents[type] = [])).push(fn); },
    querySelector(selector) { return selector === 'meta[name="theme-color"]' ? meta : null; },
    getElementById(id) {
      if (!hasToggle) return null;
      if (id === 'theme-toggle') return toggle;
      if (id === 'theme-label') return label;
      return null;
    },
  };
  const sandbox = {
    document,
    window: {addEventListener(type, fn) { (winEvents[type] || (winEvents[type] = [])).push(fn); }},
    localStorage: {
      getItem(key) {
        if (throwOnRead) throw new Error('SecurityError');
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        if (throwOnWrite) throw new Error('QuotaExceededError');
        writes.push(value);
        store.set(key, value);
      },
    },
    setTimeout(fn, ms) { timers.push({fn, ms}); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
    Date: FakeDate,
    Math,
  };
  runInNewContext(theme, sandbox, {filename: 'theme.js'});
  return {
    store, writes, timers, toggle, label, meta, document,
    dataset: document.documentElement.dataset,
    fireDoc(type) { for (const fn of docEvents[type] || []) fn({}); },
    fireWin(type, event) { for (const fn of winEvents[type] || []) fn(event || {}); },
    setNow(value) { state.now = value; },
    lastTimer() { return [...timers].reverse().find((t) => !t.cleared); },
  };
}

const HOUR = 3600 * 1000;
const at = (h, m = 0) => new Date(2026, 4, 12, h, m, 0);

test('auto flips exactly at 07:00 and 19:00 and re-arms the timer', () => {
  const cases = [
    [at(6, 59), 'dark', 60 * 1000],
    [at(7, 0), 'light', 12 * HOUR],
    [at(12, 0), 'light', 7 * HOUR],
    [at(18, 59), 'light', 60 * 1000],
    [at(19, 0), 'dark', 12 * HOUR],
    [at(23, 30), 'dark', 7.5 * HOUR],
  ];
  for (const [now, expected, wait] of cases) {
    const env = themeEnv({now});
    assert.equal(env.dataset.theme, expected, `at ${now.toTimeString().slice(0, 5)}`);
    const timer = env.lastTimer();
    assert.ok(timer, 'auto must schedule the next boundary');
    assert.ok(Math.abs(timer.ms - wait) < 60000, `wait for ${now.toTimeString().slice(0, 5)} is ${timer.ms}ms, expected ~${wait}ms`);
  }
  // Crossing the boundary from a timer callback re-resolves, not just re-schedules.
  const env = themeEnv({now: at(18, 59)});
  assert.equal(env.dataset.theme, 'light');
  env.setNow(new Date(2026, 4, 12, 19, 0, 1));
  env.lastTimer().fn();
  assert.equal(env.dataset.theme, 'dark', 'the 19:00 boundary must darken the page');
  assert.ok(Math.abs(env.lastTimer().ms - 12 * HOUR) < 60000, 'and schedule tomorrow morning');
});

test('a throwing or missing localStorage never breaks the theme', () => {
  for (const flags of [{throwOnRead: true}, {throwOnWrite: true}, {throwOnRead: true, throwOnWrite: true}]) {
    const env = themeEnv({now: at(22), ...flags});
    assert.equal(env.dataset.theme, 'dark', 'the clock still decides');
    env.fireDoc('DOMContentLoaded');
    assert.equal(env.toggle.hidden, false, 'the toggle is revealed even without storage');
    env.toggle.fire('click');
    assert.equal(env.dataset.theme, 'light', 'and cycling works in memory');
    assert.equal(env.label.textContent, '浅色');
    // Going to the background and back must not roll the in-memory choice back to
    // whatever stale value the broken storage still returns.
    env.fireDoc('visibilitychange');
    assert.equal(env.dataset.theme, 'light');
  }
});

test('the toggle cycles auto → light → dark → auto and stays labelled', () => {
  const env = themeEnv({now: at(12)});
  env.fireDoc('DOMContentLoaded');
  assert.equal(env.toggle.hidden, false);
  assert.equal(env.label.textContent, '自动');
  env.toggle.fire('click');
  assert.deepEqual(env.writes, ['light']);
  assert.equal(env.label.textContent, '浅色');
  assert.match(env.toggle.attrs['aria-label'], /当前主题：浅色，切换至深色/);
  env.toggle.fire('click');
  assert.equal(env.label.textContent, '深色');
  assert.equal(env.dataset.theme, 'dark');
  env.toggle.fire('click');
  assert.equal(env.writes[2], 'auto');
  assert.equal(env.label.textContent, '自动');
  assert.equal(env.dataset.theme, 'light', 'auto resolves back to the clock');
});

test('a stored mode is restored and a stored mode wins over the clock', () => {
  const env = themeEnv({now: at(12), stored: {'yanyu-sub-theme': 'dark'}});
  assert.equal(env.dataset.theme, 'dark');
  const bad = themeEnv({now: at(12), stored: {'yanyu-sub-theme': 'purple'}});
  assert.equal(bad.dataset.theme, 'light', 'an unknown stored value falls back to auto');
});

test('another tab\'s theme reaches this one, and removal returns to auto', () => {
  const env = themeEnv({now: at(12), stored: {'yanyu-sub-theme': 'auto'}});
  assert.equal(env.dataset.theme, 'light');
  env.store.set('yanyu-sub-theme', 'dark');
  env.fireWin('storage', {key: 'yanyu-sub-theme', newValue: 'dark'});
  assert.equal(env.dataset.theme, 'dark');
  env.fireWin('storage', {key: 'some-other-key', newValue: 'light'});
  assert.equal(env.dataset.theme, 'dark', 'unrelated keys are ignored');
  env.store.delete('yanyu-sub-theme');
  env.fireWin('storage', {key: 'yanyu-sub-theme', newValue: null});
  assert.equal(env.dataset.theme, 'light', 'a removed key means auto');
});

test('returning to a bfcached page re-reads the clock', () => {
  const env = themeEnv({now: at(18)});
  env.fireDoc('DOMContentLoaded');
  assert.equal(env.dataset.theme, 'light');
  env.setNow(at(20));
  env.fireWin('pageshow', {persisted: true});
  assert.equal(env.dataset.theme, 'dark', 'a restored page must not show a stale theme');
  // A normal load has nothing to re-resolve; it must not throw either.
  env.fireWin('pageshow', {persisted: false});
  assert.equal(env.dataset.theme, 'dark');
});

test('the toggle degrades to hidden when the markup or the ids are missing', () => {
  const env = themeEnv({now: at(12), hasToggle: false});
  env.fireDoc('DOMContentLoaded');
  assert.equal(env.dataset.theme, 'light', 'the page is still themed');
  assert.equal(env.toggle.hidden, true, 'no orphan button is shown');
});

test('theme.js is a blocking head script so the first paint never flashes', () => {
  const themeTag = html.indexOf('<script src="./theme.js"></script>');
  const cssTag = html.indexOf('<link rel="stylesheet" href="./style.css">');
  const appTag = html.indexOf('<script type="module"');
  assert.ok(themeTag > -1, 'theme.js must stay an external blocking script');
  assert.ok(themeTag < cssTag, 'the theme must be decided before the stylesheet is applied');
  assert.ok(cssTag < appTag, 'app.js must stay last');
  assert.doesNotMatch(html.slice(themeTag, themeTag + 60), /defer|async/);
  // Without JS the OS preference still wins through the media query fallback.
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\)/);
  assert.doesNotMatch(theme, /innerHTML|document\.write|eval\(/, 'theme.js stays CSP-clean');
});

// --- publish / revoke state machine ---------------------------------------

test('a successful revoke re-arms the submit button', () => {
  const handler = app.slice(app.indexOf("revokePublished.addEventListener('click'"), app.indexOf('// About dialog.'));
  assert.ok(handler, 'the revoke handler must exist');
  const final = handler.slice(handler.lastIndexOf('} finally {'));
  const guard = final.indexOf('if (publication === current)');
  const arm = final.indexOf('publishButton.disabled = running;');
  const clear = final.indexOf('revoking = false;');
  assert.ok(arm > -1, 'the submit button must be re-armed in finally');
  assert.ok(clear > -1, 'the revoking guard must always be released');
  // After a success resetPublication() nulls it, so a guarded re-arm would deadlock
  // the entry point: both must happen before the publication check.
  assert.ok(guard === -1 || (arm < guard && clear < guard),
    'publishButton/revoking must be restored outside the "publication === current" guard');
});

test('a request that outlives its timeout is aborted', () => {
  const publishBody = functionBody(app, 'publishLink');
  assert.match(publishBody, /const controller = new AbortController\(\)/);
  assert.match(publishBody, /signal: controller\.signal/);
  assert.match(publishBody.slice(publishBody.indexOf('} catch (error) {')), /^} catch \(error\) \{\n {4}controller\.abort\(\);/,
    'a late publish must not resolve into a page that already gave up');
  const revoke = app.slice(app.indexOf("revokePublished.addEventListener('click'"), app.indexOf('// About dialog.'));
  assert.match(revoke, /new AbortController\(\)/);
  assert.match(revoke, /signal: controller\.signal/);
  assert.match(revoke.slice(revoke.indexOf('} catch (error) {')), /^} catch \(error\) \{\n {4}controller\.abort\(\);/);
  // The timeout races stay bounded by the two published budgets.
  assert.match(app, /const CONVERT_TIMEOUT_MS = 90000;/);
  assert.match(app, /const PUBLISH_TIMEOUT_MS = 30000;/);
});

test('an unchanged source keeps the live link and its manage token', () => {
  assert.match(app, /let submittedText = ''/);
  assert.match(app, /submittedText = text;\n {2}invalidate\(\);/);
  const body = functionBody(app, 'invalidate');
  const early = body.indexOf('if (unchanged && !running)');
  assert.ok(early > -1, 'invalidate() must accept the "text unchanged" case');
  assert.ok(early < body.indexOf('resetPublication()'), 'the early return must precede dropping the token');
  assert.match(body.slice(early), /errorPanel\.hidden = true;[\s\S]{0,200}?\n {4}return;/);
});

test('server error text is never shown for a 5xx', () => {
  assert.match(app, /if \(status < 500 && typeof message === 'string' && message\.trim\(\)\) return cleanDiagnostic\(message\);/,
    'only 4xx messages may be rendered');
  assert.match(app, /if \(status === 503\) return '订阅服务暂时不可用/);
  // The generic fallback carries no request detail.
  assert.match(app, /return '生成订阅链接失败，请稍后重试。';/);
});
