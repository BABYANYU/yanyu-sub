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
