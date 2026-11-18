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
  const submits = [...html.matchAll(/<button\b[^>]*type="submit"[^>]*>/g)].map((match) => match[0]);
  assert.equal(submits.length, 1, 'exactly one submit control may exist');
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

test('the success status says the link is permanent by default', () => {
  assert.match(app, /const PUBLISH_DONE = '订阅链接已生成，默认永久有效。';/);
  assert.match(app, /publishStatus\.textContent = current\.hasWarnings[\s\S]{0,120}PUBLISH_DONE[\s\S]{0,80}: PUBLISH_DONE;/);
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

test('no #config-preview is left behind: the profile stays behind a collapsed details', () => {
  const details = html.match(/<details class="preview">([\s\S]*?)<\/details>/)?.[1] || '';
  assert.ok(details, 'the preview must stay a <details> so the page stays minimal');
  assert.match(details, /<summary>查看配置<\/summary>/);
  assert.match(details, /<textarea[^>]*id="config-preview"[^>]*readonly/);
  assert.match(app, /\$\('#config-preview'\)/);
  assert.match(app, /configPreview\.value = converted\.content;/);
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
  assert.match(block, /链接等同于密码，请勿公开分享/);
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
  assert.match(invalidateBody, /resultPanel\.hidden = true/, 'the link panel must collapse again');
  const resetBody = functionBody(app, 'resetPublication');
  assert.match(resetBody, /publication = null/, 'the manage token must not outlive a reset');
  assert.match(resetBody, /publishedBlock\.hidden = true/, 'the link block must be hidden again');
  assert.match(resetBody, /publishedUrl\.value = ''/, 'the URL field must be emptied');
  assert.match(resetBody, /publishStatus\.textContent = message/, 'stale status text must be cleared');
  assert.match(resetBody, /copyPublished\.disabled = true/);
  assert.match(resetBody, /revokePublished\.disabled = true/);
  // invalidate() is wired to both inputs that can invalidate a link.
  assert.match(app, /sourceInput\.addEventListener\('input',[\s\S]{0,120}invalidate\(\)/);
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
