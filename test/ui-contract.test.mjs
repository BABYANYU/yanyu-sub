// UI ↔ script ↔ converter contract. The UI is plain HTML/CSS/ES modules with no
// framework and no bundler step, so a redesigned markup file can silently break
// app.js (null selectors, renamed radio values) or the CSP (inline styles,
// inline scripts). These checks pin the interface, not the visual design.
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
const idsIn = (source) => new Set([...source.matchAll(/[#'"]?#([a-z][\w-]*)/gi)].map((match) => match[1]));

test('every id app.js looks up exists exactly once in index.html', () => {
  const wanted = new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map((match) => match[1]));
  assert.ok(wanted.size >= 15, 'app.js should still query its known anchors');
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

test('collapsible result and error panels stay hidden until app.js reveals them', () => {
  for (const id of ['result', 'error-panel', 'warning-panel']) {
    const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] || '';
    assert.match(tag, /\bhidden\b/, `#${id} must render hidden to avoid a flash of stale state`);
  }
  // #result and #error-panel are focused after disclosure, so they need tabindex=-1.
  assert.match(html.match(/<section[^>]*id="result"[^>]*>/)?.[0] || '', /tabindex="-1"/);
  assert.match(html.match(/<section[^>]*id="error-panel"[^>]*>/)?.[0] || '', /tabindex="-1"/);
  // .notice / .result / .actions style display; without the [hidden] guard the
  // hidden attribute would be overridden and every panel would show at once.
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
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*"https?:/i, 'no cross-origin subresource may be referenced');
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i, 'CSP default-src \'self\' blocks remote CSS/fonts');
  // The module entry point must load through the same relative path the Worker serves.
  assert.match(html, /<script type="module" src="\.\/app\.js">/);
  assert.match(html, /<link rel="stylesheet" href="\.\/style\.css">/);
});

test('app.js never injects HTML or evaluates strings from input', () => {
  for (const pattern of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/]) {
    assert.doesNotMatch(app, pattern, `app.js must not use ${pattern}`);
  }
  assert.match(app, /textContent/, 'diagnostics must go through textContent');
  assert.match(app, /\.value\s*=/, 'generated profile must go into the textarea value');
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
  // app.js derives the download extension from the target and disables export on warnings.
  assert.match(app, /target === 'Surge' \? 'conf' : 'yaml'/);
  assert.match(app, /result\.hasWarnings/);
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
  for (const name of ['addSource', 'updateSourceLabels', 'checkSources']) {
    assert.doesNotMatch(app, new RegExp(`\\b${name}\\s*\\(`), `${name}() was removed with the multi-source UI`);
  }
});

// ---------- hosted short subscribe link (POST /api/publish) ----------

const publishIds = [
  'publish', 'publish-ttl', 'publish-status', 'published',
  'published-url', 'copy-published', 'revoke-published', 'published-expiry',
];

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

test('the result panel hosts the subscribe-link block with its own controls', () => {
  const block = resultBlock();
  for (const id of publishIds) {
    const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0] || '';
    assert.ok(tag, `#${id} must exist in index.html`);
    assert.ok(block.includes(`id="${id}"`), `#${id} must live inside #result`);
    assert.equal([...html.matchAll(new RegExp(`\\bid\\s*=\\s*"${id}"`, 'g'))].length, 1, `#${id} must be unique`);
  }
  // Publishing must not submit the conversion form.
  const publishButtonTag = html.match(/<button[^>]*id="publish"[^>]*>/)?.[0] || '';
  assert.match(publishButtonTag, /type="button"/);
  assert.match(html, /<button id="publish"[^>]*>生成订阅链接<\/button>/);
  // The status line is announced, never alerted.
  const statusTag = html.match(/<[^>]*id="publish-status"[^>]*>/)?.[0] || '';
  assert.match(statusTag, /role="status"/);
  assert.match(statusTag, /aria-live="polite"/);
  // The link itself is read-only and never becomes an anchor the page navigates to.
  const urlTag = html.match(/<input[^>]*id="published-url"[^>]*>/)?.[0] || '';
  assert.match(urlTag, /readonly/);
  assert.match(urlTag, /type="text"/);
  assert.doesNotMatch(block, /<a\b[^>]*id="published-url"/);
  // The block stays hidden until app.js reveals it.
  assert.match(html.match(/<div[^>]*id="published"[^>]*>/)?.[0] || '', /\bhidden\b/);
  // Both token actions are plain buttons.
  for (const id of ['copy-published', 'revoke-published']) {
    assert.match(html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] || '', /type="button"/);
  }
  assert.match(block, /链接等同于密码，请勿公开分享/);
});

test('the validity select offers 1/7/30 days and defaults to 7', () => {
  const select = html.match(/<select[^>]*id="publish-ttl"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, '#publish-ttl must be a <select>');
  const options = [...select[1].matchAll(/<option([^>]*)value="([^"]+)"([^>]*)>([^<]*)</g)];
  assert.equal(options.length, 3);
  assert.deepEqual(options.map((option) => option[2]), ['86400', '604800', '2592000']);
  const checked = options.filter((option) => /\bselected\b/.test(option[1] + option[3]));
  assert.equal(checked.length, 1, 'exactly one validity must be preselected');
  assert.equal(checked[0][2], '604800', 'the default validity is 7 days');
  // app.js posts the chosen seconds as ttlSeconds and falls back to 7 days.
  assert.match(app, /ttlSeconds/);
  assert.match(app, /PUBLISH_TTLS\.has\(publishTtl\.value\)/);
  assert.match(app, /'604800'/);
});

test('app.js speaks exactly the /api/publish contract', () => {
  assert.match(app, /fetch\('\/api\/publish'/);
  assert.match(app, /method: 'POST'/);
  assert.match(app, /body: JSON\.stringify\(\{ content: current\.content, target: current\.target, ttlSeconds \}\)/);
  assert.match(app, /'Content-Type': 'application\/json'/);
  assert.match(app, /method: 'DELETE'/);
  assert.match(app, /'X-Manage-Token': current\.manageToken/);
  assert.match(app, /\/api\/publish\/\$\{encodeURIComponent\(shortToken\)\}/, 'revoke must address the short token');
  assert.match(app, /current\.url\.split\('\/'\)\.pop\(\)/, 'the short token comes from the published URL');
  // Response fields the UI depends on.
  for (const field of ['data?.url', 'data?.manageToken', 'data?.expiresAt']) {
    assert.ok(app.includes(field), `app.js must read ${field} from the response`);
  }
  assert.match(app, /data\?\.message/);
  // Same cancel/abort envelope as conversion: a stalled publish must not hang the UI.
  assert.match(app, /withTimeout\(fetch\('\/api\/publish'/, 'publishing must reuse withTimeout()');
  assert.match(app, /withTimeout\(fetch\(`\/api\/publish\//, 'revoking must reuse withTimeout()');
  assert.match(app, /error\?\.name === 'TimeoutError'/);
});

test('a new result, an edited source or a regenerated link clears the old one', () => {
  const invalidateBody = functionBody(app, 'invalidate');
  assert.match(invalidateBody, /resetPublication\(\)/, 'invalidate() must drop the published link and token');
  assert.match(invalidateBody, /updateExportState\(\)/, 'invalidate() must re-gate the export buttons');
  const resetBody = functionBody(app, 'resetPublication');
  assert.match(resetBody, /publication = null/, 'the manage token must not outlive a reset');
  assert.match(resetBody, /publishedBlock\.hidden = true/, 'the link block must be hidden again');
  assert.match(resetBody, /publishedUrl\.value = ''/, 'the URL field must be emptied');
  assert.match(resetBody, /publishedExpiry\.textContent = ''/);
  // invalidate() is wired to both inputs that can invalidate a result.
  assert.match(app, /sourceInput\.addEventListener\('input',[\s\S]{0,120}invalidate\(\)/);
  assert.match(app, /input\[name="target"\]'\)\.forEach\(\(input\) => input\.addEventListener\('change', invalidate\)\)/);
  // invalidate() runs on every submit, so a regenerated profile also drops the link.
  assert.match(app, /invalidate\(\);\n {2}const requestRevision = revision;/);
  // Publishing a second link drops the first one before asking for a new token.
  const calls = app.match(/resetPublication\(/g) || [];
  assert.ok(calls.length >= 3, 'invalidate(), publish and revoke must all reset the publication');
  assert.match(app, /\/\/ A new link supersedes the old one[\s\S]{0,120}resetPublication\(\);/);
});

test('the manage token never leaves memory', () => {
  assert.doesNotMatch(app, /localStorage|sessionStorage|indexedDB|document\.cookie/, 'the token must stay in a module variable');
  assert.doesNotMatch(app, /console\.(?:log|info|debug|warn|error)\(/, 'never print the token');
  assert.match(app, /let publication = null/, 'the publication lives in module state');
  // Copy and revoke must not run without a live publication.
  assert.match(app, /copyPublished\.addEventListener\('click',[\s\S]{0,80}if \(!publication\) return;/);
  assert.match(app, /revokePublished\.addEventListener\('click',[\s\S]{0,80}if \(!publication \|\| revoking\) return;/);
  assert.match(app, /publishStatus\.textContent = publishErrorText\(response\.status, data\?\.message\)/, 'failures stay inline');
  assert.match(app, /function publishErrorText\(status, message\)[\s\S]{0,140}cleanDiagnostic\(message\)/, 'server text must be scrubbed');
  assert.doesNotMatch(app, /\balert\s*\(|window\.confirm/, 'no blocking dialogs');
});

test('the publish block keeps the strict CSP and the no-innerHTML rule', () => {
  const start = html.indexOf('<div class="publish"');
  const end = html.indexOf('<details class="preview"');
  assert.ok(start > -1 && end > start, 'the publish block must precede the config preview');
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /<style[\s>]/i);
  assert.doesNotMatch(block, /\sstyle\s*=/i);
  assert.doesNotMatch(block, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(block, /(?:src|href)\s*=\s*"https?:/i);
  assert.doesNotMatch(block, /javascript:/i);
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML/, 'markup must not carry script');
  // No new runtime dependency: the entry module still imports only the local converter.
  const imports = [...app.matchAll(/^import\s.+?from\s+'([^']+)';/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./converter.js']);
  assert.match(app, /replaceChildren\(\)/);
});

test('the publish controls fit a 375px viewport', () => {
  assert.match(css, /\.publish-controls\s*\{[^}]*flex-wrap:\s*wrap/, 'validity + button must wrap instead of overflowing');
  assert.match(css, /\.publish-controls\s*\{[^}]*gap:/);
  assert.match(css, /\.published-url\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.published-url\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.published-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.published-actions\s+\.button\s*\{[^}]*min-width:\s*0/);
  // Long URLs must not push the layout wider than the card.
  assert.match(css, /\.publish-status\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'the hidden link block must really collapse');
});
