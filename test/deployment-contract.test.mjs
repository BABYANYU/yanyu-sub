// Deployment acceptance: the files that actually ship (dist/worker.js, the asset
// map, wrangler config), the AGPL source archive and the post-deploy verifier must
// stay in sync with the source the other test files pin down. Runs offline; steps
// that need `npm run build` skip with a clear message instead of failing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {gunzipSync, gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import worker from '../src/worker.js';
import {collectAssets, assetTypeFor, REQUIRED_PUBLIC, PUBLIC_DIR} from '../scripts/build.mjs';
import {buildSourceArchive, collectSources, tarEntryNames, SOURCES, REQUIRED_PUBLIC_SOURCES, GENERATED} from '../scripts/source-archive.mjs';
import {verifyLive} from '../scripts/verify-live.mjs';

const read = (file) => fs.readFile(file, 'utf8');
const json = async (file) => JSON.parse(await read(file));
const wrangler = await json('wrangler.json');
const deployment = await json('scripts/deployment.json');
const pkg = await json('package.json');
const verify = await read('scripts/verify-live.mjs');
const ci = await read('.github/workflows/ci.yml');
const deploy = await read('.github/workflows/deploy.yml');
const archiveSource = await read('scripts/source-archive.mjs');
const buildSource = await read('scripts/build.mjs');
const built = existsSync('dist/worker.js') && existsSync('src/assets.generated.js') && existsSync('public/converter.js') && existsSync('public/source.tar.gz');
const skipUnlessBuilt = built ? false : 'run npm run build first';

/** Independent directory listing (not the build's own walker). */
async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of (await fs.readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'yanyu-deploy-'));
}

/** A KV namespace stand-in good enough for read-only route checks. */
const kvStub = () => ({get: async () => null, put: async () => {}, delete: async () => {}});

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

test('scripts/deployment.json is a verbatim mirror of wrangler.json plus the one-time route', () => {
  // wrangler deploy reads wrangler.json only; deployment.json documents the same
  // deployment. Any key drift means the documentation lies about what ships.
  for (const [key, value] of Object.entries(wrangler)) {
    assert.deepEqual(deployment[key], value, `scripts/deployment.json.${key} drifted from wrangler.json`);
  }
  const extras = Object.keys(deployment).filter((key) => !(key in wrangler));
  assert.deepEqual(extras, ['routes'], `only routes may live outside wrangler.json, found: ${extras.join(', ')}`);
  // The route is a one-time Cloudflare custom-domain setting; re-declaring it on
  // every deploy would recreate/remove the binding with the Worker.
  assert.equal(wrangler.routes, undefined, 'custom domain must not be managed by every deploy');
  assert.deepEqual(deployment.routes?.map((route) => route.pattern), ['sub.fakeyou.eu.org']);
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
});

test('deployment configuration files carry no credentials', async () => {
  for (const file of ['wrangler.json', 'scripts/deployment.json']) {
    const text = await read(file);
    assert.doesNotMatch(text, /(?:api[_-]?key|token|secret|password|bearer|authorization)\s*[:=]/i, `${file} must not hold credentials`);
    assert.doesNotMatch(text, /\$\{\{|process\.env|CLOUDFLARE_/i, `${file} must not reference ambient secrets`);
    // A KV namespace id is public; anything longer and opaque is a likely secret.
    assert.doesNotMatch(text, /[A-Za-z0-9_+/=-]{40,}/, `${file} contains an opaque credential-like value`);
  }
});

test('the deployed entry point is the file the build writes', () => {
  assert.equal(wrangler.main, 'dist/worker.js');
  assert.match(buildSource, /outfile:\s*'dist\/worker\.js'/);
  assert.match(buildSource, /outfile:\s*'public\/converter\.js'/);
});

test('verify-live.mjs checks the health field the Worker actually returns', async () => {
  const health = await (await worker.fetch(new Request('https://sub.fakeyou.eu.org/api/health'), {})).json();
  for (const key of ['revision', 'ok']) {
    assert.ok(key in health, `health must expose ${key}`);
    assert.ok(new RegExp(`data\\.${key}\\b`).test(verify), `verify-live must read ${key}`);
  }
  assert.match(verify, /process\.env\.GITHUB_SHA/, 'verification must be tied to the commit that was built');
  assert.match(verify, /\/api\/health/);
  assert.match(verify, /fetchImpl|globalThis\.fetch|fetch\(/, 'verification must perform a real request');
  assert.ok(/for\s*\(|while\s*\(/.test(verify), 'verification needs a bounded retry loop for propagation');
  assert.ok(/throw|process\.exit\(1\)/.test(verify), 'verification must fail the job');
  const host = verify.match(/https:\/\/([a-z0-9.-]+)\/api\/health/)?.[1];
  assert.ok(host, 'verify-live must target an explicit host');
  assert.deepEqual(deployment.routes.map((route) => route.pattern), [host], 'verified host must be the deployed custom domain');
  assert.doesNotMatch(verify, /CF_API_TOKEN|CLOUDFLARE_API_TOKEN|Bearer /, 'verification must not need or embed secrets');
});

test('build pins the revision that verify-live compares against', async () => {
  assert.match(buildSource, /GITHUB_SHA/, 'the build must stamp the commit into build-info');
  const info = await import('../src/build-info.generated.js').catch(() => null);
  if (!info) return;
  assert.equal(typeof info.default.revision, 'string');
  const health = await (await worker.fetch(new Request('https://sub.fakeyou.eu.org/api/health'), {})).json();
  assert.equal(health.revision, info.default.revision, 'health revision must come from the build stamp');
});

test('the asset map covers every file in public/ and nothing else', {skip: skipUnlessBuilt}, async () => {
  const {default: assets} = await import('../src/assets.generated.js');
  const served = await listFiles(PUBLIC_DIR);
  const expected = served.map((rel) => '/' + rel).sort();
  assert.deepEqual(Object.keys(assets).sort(), expected, 'every public file must be served, and no stale entry may remain');
  for (const rel of served) {
    const asset = assets['/' + rel];
    assert.ok(asset.type, `missing content type for /${rel}`);
    const kind = assetTypeFor(rel);
    if (rel === 'source.tar.gz') {
      assert.equal(asset.type, 'application/gzip');
      assert.equal(asset.base64, true, 'binary archive must be served from base64');
      continue;
    }
    assert.deepEqual({type: asset.type, base64: asset.base64 === true}, kind, `/${rel} must be served with its declared type`);
  }
  for (const name of REQUIRED_PUBLIC) assert.ok(assets['/' + name], `missing asset /${name}`);
  assert.equal(assets['/theme.js'].type, 'application/javascript; charset=utf-8', 'the theme bootstrap script must be served');
  // Every relative resource the page references must be in the map.
  const html = await read('public/index.html');
  for (const match of html.matchAll(/(?:src|href)="\.\/([\w./-]+)"/g)) {
    assert.ok(assets['/' + match[1]], `index.html references ./${match[1]} which is not served`);
  }
  assert.match(await read('public/app.js'), /from '\.\/converter\.js'/, 'app.js must import the bundled converter');
});

test('the asset map is derived from the directory, so new public files cannot 404', async () => {
  const dir = await tempDir();
  try {
    for (const name of REQUIRED_PUBLIC) await fs.writeFile(path.join(dir, name), 'x');
    await fs.writeFile(path.join(dir, 'source.tar.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    await fs.mkdir(path.join(dir, 'icons'), {recursive: true});
    await fs.writeFile(path.join(dir, 'robots.txt'), 'User-agent: *\n');
    await fs.writeFile(path.join(dir, 'icons', 'logo.svg'), '<svg/>');
    await fs.writeFile(path.join(dir, 'favicon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const assets = await collectAssets(dir);
    assert.deepEqual(Object.keys(assets).sort(), [
      '/app.js', '/converter.js', '/favicon.png', '/icons/logo.svg', '/index.html', '/robots.txt', '/source.tar.gz', '/style.css', '/theme.js',
    ]);
    assert.equal(assets['/robots.txt'].type, 'text/plain; charset=utf-8');
    assert.equal(assets['/icons/logo.svg'].type, 'image/svg+xml; charset=utf-8');
    assert.equal(assets['/favicon.png'].type, 'image/png');
    assert.equal(assets['/favicon.png'].base64, true);
    assert.equal(assets['/index.html'].base64, undefined, 'text assets are stored as text');
    // An extension without a declared type fails the build instead of shipping
    // with a guessed/mislabelled content type.
    await fs.writeFile(path.join(dir, 'blob.zzz'), '?');
    await assert.rejects(collectAssets(dir), /no declared content type/);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('the asset map refuses to build without a required public file or the source archive', async () => {
  const dir = await tempDir();
  try {
    await fs.writeFile(path.join(dir, 'index.html'), 'x');
    await fs.writeFile(path.join(dir, 'app.js'), 'x');
    await fs.writeFile(path.join(dir, 'theme.js'), 'x');
    await fs.writeFile(path.join(dir, 'source.tar.gz'), Buffer.from([0x1f, 0x8b]));
    await assert.rejects(collectAssets(dir), /public\/style\.css is required/);
    await fs.writeFile(path.join(dir, 'style.css'), 'x');
    await assert.rejects(collectAssets(dir), /public\/converter\.js is required/);
    await fs.writeFile(path.join(dir, 'converter.js'), 'x');
    await fs.rm(path.join(dir, 'source.tar.gz'));
    await assert.rejects(collectAssets(dir), /source\.tar\.gz is missing/, 'the AGPL archive must never be optional');
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('the shipped source archive carries every public source file and no generated bundle', {skip: skipUnlessBuilt}, async () => {
  const tar = gunzipSync(await fs.readFile('public/source.tar.gz'));
  const entries = tarEntryNames(tar);
  const names = entries.map((entry) => entry.name);
  assert.ok(entries.every((entry) => entry.size >= 0), 'archive entries must carry sizes');
  for (const rel of REQUIRED_PUBLIC_SOURCES) assert.ok(names.includes(rel), `${rel} must be in the archive`);
  // Whole-directory walk: a new public source file cannot be forgotten.
  const publicSources = (await listFiles(PUBLIC_DIR)).filter((rel) => rel !== 'converter.js' && rel !== 'source.tar.gz');
  for (const rel of publicSources) assert.ok(names.includes('public/' + rel), `public/${rel} is missing from the source archive`);
  assert.ok(publicSources.includes('theme.js'), 'theme.js is public source and must be archived');
  for (const generated of GENERATED) assert.ok(!names.includes(generated), `${generated} must not be archived`);
  for (const required of ['LICENSE', 'NOTICE.md', 'README.md', 'package.json', 'package-lock.json', 'wrangler.json', 'src/worker.js', 'src/converter.js', 'scripts/build.mjs', 'scripts/verify-live.mjs', 'test/deployment-contract.test.mjs', 'vendor/UPSTREAM.json', '.github/workflows/deploy.yml']) {
    assert.ok(names.includes(required), `${required} must be in the archive`);
  }
  assert.ok(!names.some((name) => /(^|\/)(?:node_modules|\.wrangler|dist|\.git)(\/|$)|(^|\/)\.env/.test(name)), 'no dependencies, deploy state or secrets may ship');
});

test('the source archive build fails loudly when a required source path is missing', async () => {
  const root = await tempDir();
  try {
    await fs.mkdir(path.join(root, 'public'), {recursive: true});
    await fs.writeFile(path.join(root, 'LICENSE'), 'license');
    await fs.writeFile(path.join(root, 'public', 'index.html'), '<html></html>');
    await assert.rejects(
      buildSourceArchive({root, out: path.join(root, 'public/source.tar.gz')}),
      /missing required paths:.*src/,
      'a missing source tree must abort the build instead of shipping a partial archive',
    );
    assert.equal(existsSync(path.join(root, 'public/source.tar.gz')), false, 'no archive may be written on failure');
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('every path the archive builder requires exists in this repository', async () => {
  for (const rel of [...SOURCES, ...REQUIRED_PUBLIC_SOURCES]) {
    assert.ok(existsSync(rel), `scripts/source-archive.mjs requires ${rel}, which does not exist`);
  }
  // No leftover references to files that were never added.
  assert.doesNotMatch(archiveSource, /CHANGELOG\.md/, 'CHANGELOG.md does not exist and must not be required');
  assert.doesNotMatch(archiveSource, /\.cjs/, 'no build helper is a .cjs file any more');
});

test('collectSources never silently drops a present public file', async () => {
  const files = await collectSources('.');
  assert.ok(files.includes('public/theme.js'));
  assert.ok(files.includes('public/app.js'));
  assert.ok(!files.includes('public/converter.js'), 'the browser bundle is generated, not source');
  assert.ok(!files.includes('public/source.tar.gz'), 'the archive must not contain itself');
  assert.ok(files.includes('scripts/source-archive.mjs'));
  assert.deepEqual(files, [...files].sort(), 'archive order must be deterministic');
  assert.equal(new Set(files).size, files.length, 'no duplicate entries');
});

// ---------------------------------------------------------------- verify-live

test('verify-live covers pages, every mapped asset, headers, the archive and short links', () => {
  for (const probe of ["'/'", "'/app.js'", "'/style.css'", "'/converter.js'", "'/theme.js'", "'/source.tar.gz'"]) {
    assert.ok(verify.includes(probe), `verify-live should smoke-test ${probe}`);
  }
  assert.match(verify, /Object\.entries\(expectedAssets\)/, 'verify-live must probe every asset in the build map');
  assert.match(verify, /assets\.generated\.js/, 'the expected asset map must come from the tested build');
  assert.match(verify, /index\.html references/, 'references found in the served HTML must be probed too');
  assert.match(verify, /content-security-policy/);
  assert.match(verify, /x-content-type-options/);
  assert.match(verify, /x-frame-options/i);
  assert.match(verify, /gunzipSync/, 'the source archive must be decompressed, not just magic-byte sniffed');
  assert.match(verify, /public\/theme\.js/, 'the archive must be checked for the theme source');
  assert.match(verify, /\/api\/publish/);
  assert.match(verify, /Origin: 'https:\/\/example\.invalid'/, 'publish probes must be cross-origin so they cannot store anything');
});

test('verify-live probes a never-published hosted short link without publishing', () => {
  // The probe must target the /s/<token> route with a token that was never stored,
  // so acceptance never writes to the CONFIGS namespace (no real publication).
  const probe = verify.match(/'\/s\/([A-Za-z0-9_-]+)'/);
  assert.ok(probe, 'verify-live must probe the /s/<token> short link route');
  assert.equal(probe[1].length, 8, 'hosted short links use 8-character tokens');
  assert.match(probe[1], /^[A-Za-z0-9_-]{8}$/);
  assert.equal(probe[1], 'AAAAAAAA', 'the probe token must be obviously unreal and unpublished');
  assert.ok(/short\.status\s*!==\s*404/.test(verify), 'the probe must require 404');
  assert.match(verify, /content-type/, 'the probe must check the content type');
  assert.match(verify, /text\/html/, 'an unknown short link must not fall through to the HTML shell');
  assert.doesNotMatch(verify, /\/api\/publish', \{method: 'POST'[^}]*Origin: base/, 'acceptance must never publish from the site origin');
  assert.match(verify, /Hosted short link guard verified/);
});

test('verify-live passes against the Worker and the build it ships', {skip: skipUnlessBuilt}, async () => {
  const {default: assets} = await import('../src/assets.generated.js');
  const {default: info} = await import('../src/build-info.generated.js');
  const env = {CONFIGS: kvStub()};
  const logs = [];
  await verifyLive({
    base: 'https://sub.fakeyou.eu.org',
    expectedRevision: info.revision,
    assets,
    log: (line) => logs.push(line),
    attempts: 2,
    retryDelayMs: 0,
    fetchImpl: (url, init = {}) => worker.fetch(new Request(url, init), env),
  });
  assert.ok(logs.some((line) => line.includes('Deployment verification passed')));
});

test('verify-live fails when a mapped asset is not served', {skip: skipUnlessBuilt}, async () => {
  const {default: assets} = await import('../src/assets.generated.js');
  const {default: info} = await import('../src/build-info.generated.js');
  const env = {CONFIGS: kvStub()};
  const dropTheme = (url, init = {}) =>
    url.endsWith('/theme.js') ? new Response('missing', {status: 404}) : worker.fetch(new Request(url, init), env);
  await assert.rejects(
    verifyLive({base: 'https://sub.fakeyou.eu.org', expectedRevision: info.revision, assets, attempts: 2, retryDelayMs: 0, fetchImpl: dropTheme, log: () => {}}),
    /theme\.js/,
    'a public file that 404s must fail acceptance',
  );
});

test('verify-live fails when the deployed revision is stale or the archive is incomplete', {skip: skipUnlessBuilt}, async () => {
  const {default: assets} = await import('../src/assets.generated.js');
  const {default: info} = await import('../src/build-info.generated.js');
  const env = {CONFIGS: kvStub()};
  const local = (url, init = {}) => worker.fetch(new Request(url, init), env);
  await assert.rejects(
    verifyLive({base: 'https://sub.fakeyou.eu.org', expectedRevision: '0'.repeat(40), assets, attempts: 2, retryDelayMs: 0, fetchImpl: local, log: () => {}}),
    /revision was not confirmed/,
  );
  // Serve an empty gzip (a valid gzip stream with no tar entries) in place of the
  // real archive: the verifier must decompress and reject it.
  const emptyArchive = gzipSync(Buffer.alloc(1024));
  const emptySource = (url, init = {}) =>
    url.endsWith('/source.tar.gz') ? new Response(emptyArchive, {headers: {'Content-Type': 'application/gzip'}}) : local(url, init);
  await assert.rejects(
    verifyLive({base: 'https://sub.fakeyou.eu.org', expectedRevision: info.revision, assets, attempts: 2, retryDelayMs: 0, fetchImpl: emptySource, log: () => {}}),
    /source archive is missing/,
    'an empty gzip must not pass the AGPL check',
  );
});

test('verify-live homepage probes exist in the shipped markup', async () => {
  const markup = await read(new URL('../public/index.html', import.meta.url));
  const literals = [...verify.matchAll(/'(id="[^']+")'/g)].map((match) => match[1]);
  assert.ok(literals.length > 0, 'verify-live must probe the homepage');
  for (const probe of literals) assert.ok(markup.includes(probe), `verify-live probes ${probe}, missing from index.html`);
  for (const probe of verify.matchAll(/html\.includes\('([^']+)'\)/g)) assert.ok(markup.includes(probe[1]), `verify-live probes ${probe[1]}, missing from index.html`);
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
  assert.match(ci, /timeout-minutes:/, 'CI needs a hard timeout');
  assert.match(ci, /concurrency:/, 'CI runs must be serialised per ref');
});

test('deploy workflow builds, tests, deploys the tested artifact and verifies it', () => {
  assert.ok(deploy.includes('wrangler deploy --config wrangler.json --no-bundle'), 'deploy must ship the built bundle without re-bundling');
  const deployAt = deploy.indexOf('wrangler deploy --config');
  const verifyAt = deploy.indexOf('verify-live.mjs');
  assert.ok(deployAt > 0 && verifyAt > deployAt, 'verification must run after deploy');
  assert.ok(deploy.indexOf('npm test') < deployAt, 'tests must pass before deploying');
  assert.ok(deploy.indexOf('npm run build') < deployAt);
  assert.match(deploy, /environment: production/, 'production environment gate required');
  assert.match(deploy, /secrets\.CF_API_TOKEN/);
  assert.match(deploy, /secrets\.CF_ACCOUNT_ID/);
  assert.match(deploy, /GITHUB_SHA: \$\{\{ github\.sha \}\}/, 'verification must compare against the deployed commit');
});

test('deploy workflow is serialised, time-boxed and can roll back a failed deploy', () => {
  // One deploy at a time, and never cancelled half-way: a cancelled upload can
  // leave production on an unverified version.
  assert.match(deploy, /concurrency:\s*\n\s*group: yanyu-sub-production/, 'production deploys must share one concurrency group');
  assert.match(deploy, /cancel-in-progress: false/, 'a running deploy must not be cancelled by the next push');
  assert.match(deploy, /timeout-minutes: 15/, 'the deploy job must have a hard timeout');
  // Rollback: record the serving version before upload, roll back only when an
  // upload was actually attempted, and prove the old version is healthy again.
  assert.match(deploy, /id: previous/, 'the current production version must be recorded before deploying');
  assert.match(deploy, /wrangler deployments list/, 'the rollback target comes from the live deployment list');
  assert.match(deploy, /id: deploy/, 'the deploy step needs an id so rollback can depend on its outcome');
  assert.match(deploy, /if: failure\(\) && steps\.deploy\.outcome == 'success'/, 'rollback must only run after an attempted upload');
  assert.match(deploy, /wrangler rollback/, 'a failed verification must restore the previous version');
  assert.match(deploy, /api\/health/, 'the rollback must be verified against live health');
  assert.ok(deploy.indexOf('wrangler rollback') > deploy.indexOf('verify-live.mjs'), 'rollback runs after failed verification');
  assert.match(deploy, /--tag/, 'deployed versions must be tagged with the commit for audit/rollback');
  // Least privilege: read-only repo token, no write permissions for the workflow.
  assert.match(deploy, /permissions:\s*\n\s*contents: read/);
});

test('deploy workflow documents the KV binding permission the token needs', () => {
  // Deploying writes the CONFIGS binding, so a token without KV edit fails the
  // upload. That requirement must be stated where the secrets are configured.
  assert.match(deploy, /Workers KV Storage[^\n]*Edit/i, 'the token needs Workers KV Storage: Edit for the CONFIGS binding');
  assert.match(deploy, /Workers Scripts[^\n]*Edit/i, 'the token needs Workers Scripts: Edit to upload the Worker');
  assert.match(deploy, /unauthorized to access KV namespace|authentication error/i, 'document the failure mode when KV rights are missing');
});

test('GitHub Actions are pinned to immutable commit SHAs', () => {
  for (const workflow of [ci, deploy]) {
    for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
      assert.match(match[1], /@[0-9a-f]{40}$/, `${match[1]} must be pinned to a full commit SHA`);
    }
  }
});

test('AGPL source archive keeps license files and excludes generated bundles and secrets', async () => {
  assert.match(archiveSource, /'LICENSE'/);
  assert.match(archiveSource, /'NOTICE\.md'/);
  assert.match(archiveSource, /'package-lock\.json'/, 'the archive must allow a reproducible build');
  const generated = archiveSource.match(/const GENERATED\s*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
  for (const bundle of ['src/assets.generated.js', 'src/build-info.generated.js', 'public/converter.js']) {
    assert.ok(generated.includes(bundle), `${bundle} must not be archived`);
  }
  assert.match(archiveSource, /Refusing to archive/, 'dependency/secret paths must be refused loudly');
  assert.match(buildSource, /from '\.\/source-archive\.mjs'/, 'the build must regenerate the source archive');
  assert.match(buildSource, /await buildSourceArchive\(\)/, 'the archive must be rebuilt on every build');
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
  assert.doesNotMatch(doc, /^## (?:上线验收|相关改动文件|部署与配置)\b/m,
    'the hosted-link guide is for users; deployment checks are tested directly');
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

test('corresponding-source archive includes the user-facing guide and excludes maintenance history', async () => {
  const files = await collectSources();
  assert.ok(files.includes('documentation/HOSTED-LINKS-2026-11-17.md'));
  assert.ok(!files.includes('documentation/DEPLOYMENT-2026-11-18.md'));
  assert.ok(!files.includes('documentation/UI-2026-11-17.md'));
  const archivedHistory = ['DEPLOYMENT-2026-11-18.md','UI-2026-11-17.md'];
  for (const file of archivedHistory) assert.ok(!files.some((path) => path.endsWith('/'+file)));
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('vendor/LICENSE'));
  assert.ok(files.includes('NOTICE.md'));
});

test('README links the user guide and corresponding source without deployment history', async () => {
  const readme = await read('README.md');
  assert.match(readme, /HOSTED-LINKS-2026-11-17\.md/, 'README must link the user-facing hosted-link guide');
  assert.match(readme, /source\.tar\.gz/, 'README must link corresponding source');
  assert.doesNotMatch(readme, /DEPLOYMENT-2026-11-18|Workers KV Storage: Edit|verify-live\.mjs/,
    'the user-facing README must not contain deployment operations');
});
