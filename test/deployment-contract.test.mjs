// Deployment acceptance: the files that actually ship (dist/worker.js, the asset
// map, wrangler config) and the post-deploy verifier must stay in sync with the
// source interface the other test files pin down. Runs offline; steps that need
// `npm run build` skip with a clear message instead of failing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import worker from '../src/worker.js';

const read = (path) => fs.readFile(path, 'utf8');
const json = async (path) => JSON.parse(await read(path));
const wrangler = await json('wrangler.json');
const deployment = await json('scripts/deployment.json');
const pkg = await json('package.json');
const verify = await read('scripts/verify-live.mjs');
const ci = await read('.github/workflows/ci.yml');
const deploy = await read('.github/workflows/deploy.yml');
const archive = await read('scripts/source-archive.mjs');
const build = await read('scripts/build.mjs');
const built = existsSync('dist/worker.js') && existsSync('src/assets.generated.js') && existsSync('public/converter.js');

test('wrangler.json and scripts/deployment.json describe the same deployment', () => {
  assert.equal(wrangler.name, deployment.name);
  assert.equal(wrangler.main, deployment.main);
  assert.equal(wrangler.compatibility_date, deployment.compatibility_date);
  assert.match(wrangler.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(new Date(wrangler.compatibility_date) <= new Date(), 'compatibility_date must not be in the future');
  assert.equal(wrangler.workers_dev, false, 'workers.dev must stay disabled');
  assert.equal(wrangler.preview_urls, false, 'preview URLs must stay disabled');
  assert.equal(wrangler.observability?.enabled, false, 'request logging must stay off (no subscription URLs in logs)');
});

test('the CONFIGS KV namespace is bound identically in wrangler.json and scripts/deployment.json', () => {
  const pick = (config) => config.kv_namespaces?.find((ns) => (ns.binding ?? ns.name) === 'CONFIGS');
  const binding = pick(wrangler);
  assert.ok(binding, 'wrangler.json must bind the CONFIGS namespace the hosted links read from');
  assert.deepEqual(binding, pick(deployment), 'scripts/deployment.json must mirror the KV binding exactly');
  assert.equal(binding.binding ?? binding.name, 'CONFIGS', 'the Worker reads env.CONFIGS');
  assert.equal(binding.id, 'e7205f12788c4a2098c538a230f8f915');
  assert.match(binding.id, /^[0-9a-f]{32}$/, 'Cloudflare namespace ids are 32 lowercase hex characters');
  // Exactly one namespace: a second binding would silently split published links.
  assert.equal(wrangler.kv_namespaces.length, 1);
  assert.equal(deployment.kv_namespaces.length, 1);
  // The one-time custom domain setting must still not leak back into wrangler.json.
  assert.equal(wrangler.routes, undefined);
});

test('deployment configuration files carry no credentials', async () => {
  for (const path of ['wrangler.json', 'scripts/deployment.json']) {
    const text = await read(path);
    assert.doesNotMatch(text, /(?:api[_-]?key|token|secret|password|bearer|authorization)\s*[:=]/i, `${path} must not hold credentials`);
    assert.doesNotMatch(text, /\$\{\{|process\.env|CLOUDFLARE_/i, `${path} must not reference ambient secrets`);
    // A KV namespace id is public; anything longer and opaque is a likely secret.
    assert.doesNotMatch(text, /[A-Za-z0-9_+/=-]{40,}/, `${path} contains an opaque credential-like value`);
  }
});

test('the deployed entry point is the file the build writes', () => {
  assert.equal(wrangler.main, 'dist/worker.js');
  assert.match(build, /outfile:'dist\/worker\.js'/);
  assert.match(build, /outfile:'public\/converter\.js'/);
});

test('custom domain binding stays out of per-deploy config (it is a one-time CF setting)', () => {
  // wrangler.json is what `wrangler deploy --config wrangler.json` uses; a route
  // entry there would be re-created/removed on every deploy.
  assert.equal(wrangler.routes, undefined);
  assert.deepEqual(deployment.routes?.map((route) => route.pattern), ['sub.fakeyou.eu.org']);
  assert.ok(deployment.routes.every((route) => !route.pattern.includes('workers.dev')));
});

test('verify-live.mjs checks the health field the Worker actually returns', async () => {
  const health = await (await worker.fetch(new Request('https://sub.fakeyou.eu.org/api/health'), {})).json();
  for (const key of ['revision', 'ok']) {
    assert.ok(key in health, `health must expose ${key}`);
    assert.ok(new RegExp(`data\\.${key}\\b`).test(verify), `verify-live must read ${key}`);
  }
  assert.match(verify, /process\.env\.GITHUB_SHA/, 'verification must be tied to the commit that was built');
  assert.match(verify, /\/api\/health/);
  assert.match(verify, /fetch\(/, 'verification must perform a real request');
  assert.ok(/for\s*\(|while\s*\(/.test(verify), 'verification needs a bounded retry loop for propagation');
  assert.ok(/throw|process\.exit\(1\)/.test(verify), 'verification must fail the job');
  const host = verify.match(/https:\/\/([a-z0-9.-]+)\/api\/health/)?.[1];
  assert.ok(host, 'verify-live must target an explicit host');
  assert.deepEqual(deployment.routes.map((route) => route.pattern), [host], 'verified host must be the deployed custom domain');
  assert.doesNotMatch(verify, /CF_API_TOKEN|CLOUDFLARE_API_TOKEN|Bearer /, 'verification must not need or embed secrets');
});

test('build pins the revision that verify-live compares against', async () => {
  assert.match(build, /GITHUB_SHA/, 'the build must stamp the commit into build-info');
  const info = await import('../src/build-info.generated.js').catch(() => null);
  if (!info) return;
  assert.equal(typeof info.default.revision, 'string');
  const health = await (await worker.fetch(new Request('https://sub.fakeyou.eu.org/api/health'), {})).json();
  assert.equal(health.revision, info.default.revision, 'health revision must come from the build stamp');
});

test('asset map covers every file the UI and license archive need', {skip: built ? false : 'run npm run build first'}, async () => {
  const {default: assets} = await import('../src/assets.generated.js');
  for (const path of ['/index.html', '/app.js', '/style.css', '/converter.js', '/source.tar.gz']) {
    assert.ok(assets[path], `missing asset ${path}`);
    assert.ok(assets[path].type, `missing content type for ${path}`);
  }
  assert.equal(assets['/source.tar.gz'].base64, true, 'binary archive must be served from base64');
  // Every relative resource the page references must be in the map.
  const html = await read('public/index.html');
  for (const match of html.matchAll(/(?:src|href)="\.\/([\w.-]+)"/g)) {
    assert.ok(assets['/' + match[1]], `index.html references ./${match[1]} which is not served`);
  }
  assert.match(await read('public/app.js'), /from '\.\/converter\.js'/, 'app.js must import the bundled converter');
});

test('shipped bundles contain no runtime code generation', {skip: built ? false : 'run npm run build first'}, async () => {
  for (const path of ['dist/worker.js', 'public/converter.js', 'public/app.js']) {
    const text = await read(path);
    assert.doesNotMatch(text, /\beval\s*\(|\bnew\s+Function\s*\(/, `${path} must not evaluate strings at runtime`);
  }
});

test('the deployed bundle answers the same interface as src/worker.js', {skip: built ? false : 'run npm run build first'}, async () => {
  const {default: bundled} = await import('../dist/worker.js');
  for (const [path, expected] of [['/api/health', 200], ['/', 200], ['/app.js', 200], ['/no-such-page', 404], ['/api/nope', 404]]) {
    const response = await bundled.fetch(new Request('https://sub.fakeyou.eu.org' + path), {});
    assert.equal(response.status, expected, path);
  }
  const health = await (await bundled.fetch(new Request('https://sub.fakeyou.eu.org/api/health'), {})).json();
  const source = await (await worker.fetch(new Request('https://sub.fakeyou.eu.org/api/health'), {})).json();
  assert.deepEqual(Object.keys(health).sort(), Object.keys(source).sort());
  const html = await bundled.fetch(new Request('https://sub.fakeyou.eu.org/'), {});
  assert.match(html.headers.get('content-security-policy') || '', /default-src 'self'/, 'the deployed bundle must send the CSP');
});

test('CI runs the acceptance order: install, build, test, audit', () => {
  const steps = [...ci.matchAll(/^\s*- (?:name: .*\n\s*)?run: (.+)$/gm)].map((match) => match[1].trim());
  const order = ['npm ci', 'npm run build', 'npm test', 'npm audit'];
  let cursor = -1;
  for (const command of order) {
    const index = steps.findIndex((step, position) => position > cursor && step.startsWith(command));
    assert.ok(index > cursor, `CI is missing "${command}" in the documented order (${steps.join(' | ')})`);
    cursor = index;
  }
  assert.ok(ci.includes('--ignore-scripts'), 'CI must not run lifecycle scripts');
  assert.ok(ci.includes('--omit=dev'), 'CI must audit production dependencies');
  // A generated bundle must never be tested without rebuilding it first.
  assert.ok(steps.indexOf('npm run build') < steps.indexOf('npm test'));
});

test('deploy workflow builds, tests, deploys the tested artifact and verifies it', () => {
  assert.ok(deploy.includes('wrangler deploy --config wrangler.json --no-bundle'), 'deploy must ship the built bundle without re-bundling');
  const deployAt = deploy.indexOf('wrangler deploy');
  const verifyAt = deploy.indexOf('verify-live.mjs');
  assert.ok(deployAt > 0 && verifyAt > deployAt, 'verification must run after deploy');
  assert.ok(deploy.indexOf('npm test') < deployAt, 'tests must pass before deploying');
  assert.ok(deploy.indexOf('npm run build') < deployAt);
  assert.match(deploy, /environment: production/, 'production environment gate required');
  assert.match(deploy, /secrets\.CF_API_TOKEN/);
  assert.match(deploy, /secrets\.CF_ACCOUNT_ID/);
});

test('GitHub Actions are pinned to immutable commit SHAs', () => {
  for (const workflow of [ci, deploy]) {
    for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
      assert.match(match[1], /@[0-9a-f]{40}$/, `${match[1]} must be pinned to a full commit SHA`);
    }
  }
});

test('AGPL source archive keeps license files and excludes generated bundles and secrets', async () => {
  assert.match(archive, /'LICENSE'/);
  assert.match(archive, /'NOTICE\.md'/);
  assert.match(archive, /'package-lock\.json'/, 'the archive must allow a reproducible build');
  const excluded = archive.match(/const excluded\s*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
  for (const generated of ['src/assets.generated.js', 'src/build-info.generated.js']) {
    assert.ok(excluded.includes(generated), `${generated} must not be archived`);
  }
  assert.doesNotMatch(archive, /node_modules|\.dev\.vars|\.env\b/, 'the archive must not pick up secrets or dependencies');
  assert.match(build, /await import\('\.\/source-archive\.mjs'\)/, 'the build must regenerate the source archive');
  assert.ok(existsSync('LICENSE') && existsSync('NOTICE.md'));
  assert.equal((await json('vendor/UPSTREAM.json')).license, 'AGPL-3.0');
  assert.match((await json('vendor/UPSTREAM.json')).commit, /^[0-9a-f]{40}$/);
});

test('package.json keeps the test glob and the Node baseline the runtime needs', () => {
  assert.equal(pkg.scripts.test, 'node --test test/*.test.mjs', 'new test files must match this glob');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines.node, />=24/);
  assert.equal(pkg.scripts.postinstall, undefined, 'CI installs with --ignore-scripts; no lifecycle hooks');
});

// GAP (deploy acceptance): verify-live only proves that /api/health reports the
// new revision. A build that ships a broken index.html, a missing asset or a
// lost CSP header would still pass. Kept as a skip so the gap is visible.
test('deploy verification covers the served UI, assets and security headers', () => {
  for (const path of ["'/'", "'/app.js'", "'/style.css'", "'/converter.js'", "'/source.tar.gz'"]) {
    assert.ok(verify.includes(path), `verify-live should smoke-test ${path}`);
  }
  assert.match(verify, /content-security-policy/);
  assert.match(verify, /x-content-type-options/);
});

test('verify-live.mjs probes a never-published hosted short link without publishing', () => {
  // The probe must target the /s/<token> route with a token that was never stored,
  // so acceptance never writes to the CONFIGS namespace (no real publication).
  const probe = verify.match(/'\/s\/([A-Za-z0-9_-]+)'/);
  assert.ok(probe, 'verify-live must probe the /s/<token> short link route');
  assert.equal(probe[1].length, 8, 'hosted short links use 8-character tokens');
  assert.match(probe[1], /^[A-Za-z0-9_-]{8}$/);
  assert.equal(probe[1], 'AAAAAAAA', 'the probe token must be obviously unreal and unpublished');
  assert.ok(/short\.status!==404/.test(verify) || /status!==404/.test(verify), 'the probe must require 404');
  assert.match(verify, /content-type/, 'the probe must check the content type');
  assert.match(verify, /text\/html/, 'an unknown short link must not fall through to the HTML shell');
  assert.doesNotMatch(verify, /\/api\/publish/, 'verification must never create a publication');
  assert.match(verify, /Hosted short link guard verified/);
});

test('documentation records the hosted short link contract', async () => {
  const doc = await read('documentation/HOSTED-LINKS-2026-11-17.md');
  assert.match(doc, /\/s\/Ab3dE9kZ/, 'the documented example must show the real short link shape');
  assert.match(doc, /即凭据|视同密码|等同于密码/, 'the doc must state that the link itself is the credential');
  assert.match(doc, /CONFIGS/);
  // Hosted links are permanent by default; a fixed lifetime must never be documented as the default.
  assert.match(doc, /默认永久|默认.*不过期/, 'the doc must state that hosted links are permanent by default');
  assert.doesNotMatch(doc, /7 天（默认）|`604800`（默认）|默认 7 天|默认 30 天/, 'no fixed TTL may be documented as the default');
  assert.match(doc, /expirationTtl/, 'permanent records are stored without a KV expirationTtl');
  assert.match(doc, /3600[\s\S]{0,160}2592000/, 'the optional explicit TTL set (1h/1d/7d/30d) must stay documented');
  assert.match(doc, /撤销即删除|撤销[^。\n]{0,20}kv\.delete/, 'revoking must be documented as deleting the KV record');
  assert.match(doc, /管理令牌|管理令牌哈希/, 'management tokens are stored hashed only');
  assert.match(doc, /节点密码/, 'readers must be warned the config contains node credentials');
  assert.match(doc, /\/source\.tar\.gz/, 'the AGPL source archive stays downloadable');
  assert.match(doc, /\/api\/publish/);
});

test('README documents permanent hosted links and how to revoke them', async () => {
  const readme = await read('README.md');
  assert.match(readme, /默认永久|永久有效/, 'README must say hosted links are permanent by default');
  assert.match(readme, /链接即凭据/, 'README must keep the link-is-the-credential warning');
  assert.match(readme, /撤销/, 'README must explain revocation');
  assert.match(readme, /expirationTtl|KV 无过期时间/, 'README must say permanent records carry no KV expiry');
  assert.match(readme, /3600|1 小时/, 'the optional explicit TTL must stay documented');
  assert.doesNotMatch(readme, /7 天（默认）|默认 7 天|最长 30 天|上限 30 天/, 'README must not claim a 7-day default or a 30-day ceiling');
});

test('verify-live homepage probes exist in the shipped markup', async () => {
  const page = (await import('node:fs/promises')).readFile;
  const markup = await page(new URL('../public/index.html', import.meta.url), 'utf8');
  const probes = [...verify.matchAll(/html\.includes\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(probes.length > 0, 'verify-live must probe the homepage');
  for (const probe of probes) assert.ok(markup.includes(probe), `verify-live probes ${probe}, missing from index.html`);
});
