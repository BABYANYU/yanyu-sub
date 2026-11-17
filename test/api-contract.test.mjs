// API contract for the Worker interface used by public/app.js (POST /api/fetch),
// the deploy verifier (/api/health) and the static asset surface.
// No network: every outbound fetch is stubbed. Rate-limit buckets are keyed by
// CF-Connecting-IP, so each test uses its own address.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import worker from '../src/worker.js';

const ORIGIN = 'https://sub.fakeyou.eu.org';
const origin = new URL(ORIGIN).origin;
const post = (body, headers = {}) => new Request(ORIGIN + '/api/fetch', {
  method: 'POST',
  headers: {Origin: origin, 'Content-Type': 'application/json', ...headers},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const ok = (text) => new Response(text, {status: 200, headers: {'content-type': 'text/plain'}});
const skipDns = {SKIP_DNS_PREFLIGHT: 'true'};

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return stub(...args);
  };
  try {
    return {calls, result: await run()};
  } finally {
    globalThis.fetch = original;
  }
}

test('health keeps the field names the deploy verifier reads', async () => {
  const response = await worker.fetch(new Request(ORIGIN + '/api/health'), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['engine', 'ok', 'revision', 'targets', 'version']);
  assert.equal(body.ok, true);
  assert.equal(typeof body.revision, 'string');
  assert.ok(body.revision.length > 0);
  assert.deepEqual(body.targets, ['Surge', 'Mihomo']);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('health exposes no env, secret or storage binding', async () => {
  const response = await worker.fetch(new Request(ORIGIN + '/api/health'), {
    SKIP_DNS_PREFLIGHT: true,
    SECRET_TOKEN: 'must-not-leak',
  });
  const text = await response.text();
  assert.doesNotMatch(text, /must-not-leak/);
  const body = JSON.parse(text);
  // Inspect the values, not the whole payload: the revision hash is hex and can
  // coincidentally contain short tokens such as "d1" or "r2".
  assert.deepEqual(Object.keys(body).sort(), ['engine', 'ok', 'revision', 'targets', 'version']);
  const values = [body.engine, body.version, ...(body.targets || [])].join(' ');
  assert.doesNotMatch(values, /kv|d1|r2|bucket|token|secret|skip_dns/i);
  assert.ok(body.revision === 'local' || /^[0-9a-f]{40}$/.test(body.revision));
});

test('static assets are served byte-identical with the hardened header set', async () => {
  for (const [path, file] of [['/', 'index.html'], ['/index.html', 'index.html'], ['/app.js', 'app.js'],
    ['/style.css', 'style.css'], ['/converter.js', 'converter.js']]) {
    const response = await worker.fetch(new Request(ORIGIN + path), {});
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), await fs.readFile('public/' + file, 'utf8'), path);
    assert.match(response.headers.get('content-type'), file === 'index.html' ? /text\/html; charset=utf-8/ : file.endsWith('.css') ? /text\/css/ : /application\/javascript/);
    for (const [key, value] of [['cache-control', /private, no-store/], ['x-content-type-options', 'nosniff'],
      ['referrer-policy', 'no-referrer'], ['x-frame-options', 'DENY'], ['permissions-policy', /camera=\(\)/]]) {
      assert.match(response.headers.get(key) || '', value instanceof RegExp ? value : new RegExp(value), `${path} ${key}`);
    }
    const csp = response.headers.get('content-security-policy') || '';
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
      "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive), `${path} CSP ${directive}`);
  }
});

test('source archive is downloadable and is real gzip (AGPL obligation)', async () => {
  let response;
  try {
    response = await worker.fetch(new Request(ORIGIN + '/source.tar.gz'), {});
  } catch (error) {
    assert.fail('worker did not serve /source.tar.gz: ' + error.message);
  }
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/gzip/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b]);
  assert.equal(response.headers.get('content-disposition'), null);
});

test('HEAD returns headers only', async () => {
  const response = await worker.fetch(new Request(ORIGIN + '/', {method: 'HEAD'}), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
});

test('unknown paths are JSON 404 and never echo the request path', async () => {
  for (const [path, message] of [['/nope', '页面不存在'], ['/api/nope', '接口不存在'], ['/../../src/worker.js', '页面不存在']]) {
    const response = await worker.fetch(new Request(ORIGIN + path), {});
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), {message});
  }
});

test('api/fetch rejects everything but POST', async () => {
  const response = await worker.fetch(new Request(ORIGIN + '/api/fetch'), {});
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), {message: '请使用 POST 请求'});
});

test('api/fetch rejects foreign origin, missing origin and non-JSON content type before any outbound call', async () => {
  const cases = [
    post({url: 'https://subscription.example.org/sub'}, {Origin: 'https://attacker.example'}),
    post({url: 'https://subscription.example.org/sub'}, {Origin: null}),
    post('url=https://subscription.example.org/sub', {'Content-Type': 'application/x-www-form-urlencoded'}),
  ];
  let index = 0;
  for (const request of cases) {
    index += 1;
    // Deleting Origin must not fall back to a truthy default.
    if (request.headers.get('Origin') === null) request.headers.delete('Origin');
    const {calls, result} = await withFetch(() => ok('trojan://x@host.example:443#n'), () =>
      worker.fetch(request, {...skipDns, ip: `203.0.113.${index}`}));
    assert.equal(result.status, 403, `case ${index}`);
    assert.deepEqual(await result.json(), {message: '请求来源不匹配'});
    assert.equal(calls.length, 0, `case ${index} must not reach the network`);
  }
});

test('api/fetch returns the upstream text on success with the fixed outbound contract', async () => {
  const body = 'trojan://fixture@node.example.com:443?sni=t.example.com#Fixture';
  const {calls, result} = await withFetch(() => ok(body), () =>
    worker.fetch(post({url: 'https://subscription.example.org/s?token=fixture'}, {'CF-Connecting-IP': '198.51.100.1',
      Authorization: 'Bearer caller-secret', Cookie: 'session=caller'}), skipDns));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {text: body});
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://subscription.example.org/s?token=fixture');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(options.headers.Origin, undefined);
});

test('api/fetch maps upstream failures to stable user-facing messages', async () => {
  const scenarios = [
    ['redirect', () => new Response(null, {status: 302, headers: {Location: 'https://elsewhere.example/'}}), 422, /跳转/],
    ['server error', () => new Response('', {status: 503}), 422, /暂时未返回可用内容/],
    ['html page', () => new Response('<!doctype html><html><body>login</body></html>', {status: 200}), 422, /返回了网页/],
    ['declared oversize', () => new Response('x', {status: 200, headers: {'content-length': String(2 * 1024 * 1024)}}), 413, /1 MiB/],
  ];
  let index = 0;
  for (const [name, stub, status, pattern] of scenarios) {
    index += 1;
    const {result} = await withFetch(stub, () => worker.fetch(post({url: 'https://subscription.example.org/sub'},
      {'CF-Connecting-IP': `198.51.100.${10 + index}`}), skipDns));
    assert.equal(result.status, status, name);
    assert.match((await result.json()).message, pattern, name);
    assert.equal(result.headers.get('cache-control'), 'private, no-store', name);
  }
});

test('api/fetch streams a bounded body and rejects oversize without content-length', async () => {
  const big = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 3; i += 1) controller.enqueue(new Uint8Array(512 * 1024).fill(0x41));
      controller.close();
    },
  });
  const {result} = await withFetch(() => new Response(big, {status: 200}), () =>
    worker.fetch(post({url: 'https://subscription.example.org/sub'}, {'CF-Connecting-IP': '198.51.100.20'}), skipDns));
  assert.equal(result.status, 413);
  assert.match((await result.json()).message, /1 MiB/);
});

test('api/fetch rejects invalid UTF-8 upstream bodies instead of mojibake', async () => {
  const {result} = await withFetch(() => new Response(new Uint8Array([0x74, 0xff, 0xfe, 0x0a]), {status: 200}), () =>
    worker.fetch(post({url: 'https://subscription.example.org/sub'}, {'CF-Connecting-IP': '198.51.100.21'}), skipDns));
  assert.equal(result.status, 422);
});

test('api/fetch validates the submitted url: scheme, shape, credentials and body JSON', async () => {
  const urls = ['http://subscription.example.org/sub', 'https://user:pass@subscription.example.org/sub',
    'https://subscription.example.org/sub#frag', 'https://subscription.example.org:8443/sub',
    'file:///etc/passwd', 'https://sub.fakeyou.eu.org/sub', 'https://198.51.100.9/sub', 'not a url'];
  let index = 0;
  for (const url of urls) {
    index += 1;
    const {calls, result} = await withFetch(() => ok(''), () => worker.fetch(post({url},
      {'CF-Connecting-IP': `203.0.113.${100 + index}`}), skipDns));
    assert.equal(result.status, 422, url);
    assert.equal(calls.length, 0, url);
    assert.doesNotMatch((await result.json()).message, /subscription\.example\.org|etc\/passwd/, url);
  }
  const {result: notJson} = await withFetch(() => ok(''), () =>
    worker.fetch(post('{not json', {'CF-Connecting-IP': '203.0.113.150'}), skipDns));
  assert.equal(notJson.status, 422);
  const {result: noUrl} = await withFetch(() => ok(''), () =>
    worker.fetch(post({}, {'CF-Connecting-IP': '203.0.113.151'}), skipDns));
  assert.equal(noUrl.status, 422);
});

test('reserved documentation domains are refused by the DNS policy itself', async () => {
  const {calls, result} = await withFetch(() => ok(''), () =>
    worker.fetch(post({url: 'https://subscription.example.org/sub'}, {'CF-Connecting-IP': '198.51.100.32'}), {}));
  assert.equal(result.status, 422);
  assert.match((await result.json()).message, /网络策略检查/);
  assert.equal(calls.length, 0, 'the policy must reject before any DoH query');
});

test('request body above the 16 KiB upload limit is refused', async () => {
  const {calls, result} = await withFetch(() => ok(''), () =>
    worker.fetch(post({url: 'https://subscription.example.org/sub', pad: 'x'.repeat(20000)},
      {'CF-Connecting-IP': '198.51.100.31'}), skipDns));
  assert.equal(result.status, 413);
  assert.equal(calls.length, 0);
});

test('DNS preflight runs by default and blocks private answers before the upstream call', async () => {
  const dns = (request) => {
    const target = new URL(request);
    const type = target.searchParams.get('type');
    return Promise.resolve(Response.json({
      Status: 0,
      Answer: [{name: target.searchParams.get('name'), type: type === 'A' ? 1 : 28, data: type === 'A' ? '10.0.0.7' : 'fd00::7'}],
    }));
  };
  const {calls, result} = await withFetch(dns, () => worker.fetch(post({url: 'https://sub.hackclub.dev/sub'},
    {'CF-Connecting-IP': '198.51.100.41'}), {}));
  assert.equal(result.status, 422);
  assert.match((await result.json()).message, /网络策略检查/);
  assert.equal(calls.length, 2, 'exactly the two DoH lookups must run');
});

test('SKIP_DNS_PREFLIGHT accepts both true and "true" and skips DoH', async () => {
  for (const [index, env] of [{SKIP_DNS_PREFLIGHT: true}, {SKIP_DNS_PREFLIGHT: 'true'}, {SKIP_DNS_PREFLIGHT: ' false '}].entries()) {
    const {calls, result} = await withFetch((request) => {
      if (String(request).includes('dns-query')) return Promise.resolve(Response.json({Status: 0, Answer: [{name: 'sub.hackclub.dev', type: 1, data: '93.184.216.34'}]}));
      return Promise.resolve(ok('trojan://a@node.example.com:443#n'));
    }, () => worker.fetch(post({url: 'https://sub.hackclub.dev/sub'},
      {'CF-Connecting-IP': `198.51.100.${50 + index}`}), env));
    const dnsCalls = calls.filter(([request]) => String(request).includes('dns-query')).length;
    assert.equal(result.status, 200, JSON.stringify(env));
    assert.equal(dnsCalls, env.SKIP_DNS_PREFLIGHT === ' false ' ? 2 : 0, JSON.stringify(env));
  }
});

test('per-IP quota rejects the 11th request inside a minute', async () => {
  const ip = '198.51.100.61';
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    const {result} = await withFetch(() => ok('trojan://a@node.example.com:443#n'), () =>
      worker.fetch(post({url: 'https://subscription.example.org/sub'}, {'CF-Connecting-IP': ip}), skipDns));
    statuses.push(result.status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.deepEqual(statuses.slice(10), [429, 429]);
});

// Rejected cross-origin traffic must not burn the visitor's conversion quota.
test('rejected cross-origin calls do not consume the caller quota', async () => {
  const ip = '198.51.100.71';
  for (let i = 0; i < 10; i += 1) {
    const {result} = await withFetch(() => ok(''), () => worker.fetch(post({url: 'https://subscription.example.org/sub'},
      {Origin: 'https://attacker.example', 'CF-Connecting-IP': ip}), {}));
    assert.equal(result.status, 403);
  }
  const {result} = await withFetch(() => ok('trojan://a@node.example.com:443#n'), () =>
    worker.fetch(post({url: 'https://subscription.example.org/sub'}, {'CF-Connecting-IP': ip}), skipDns));
  assert.equal(result.status, 200);
});


// Short-link hosting shares the Worker with the converter, so its routes must be
// matched before the static handler, answer in the same JSON error shape and never
// echo the requested path. The KV binding is deliberately absent here: every route
// has to fail closed with 503 instead of throwing.
test('publish and short-link routes are routed ahead of the static handler', async () => {
  const checks = [
    [new Request(ORIGIN + '/api/publish'), 405, 'POST'],
    [new Request(ORIGIN + '/api/publish', {method: 'PUT', headers: {Origin: origin}}), 405, 'POST'],
    [new Request(ORIGIN + '/s/AbCd1234'), 503, null],
    [new Request(ORIGIN + '/s/AbCd1234', {method: 'HEAD'}), 503, null],
    [new Request(ORIGIN + '/s/AbCd1234', {method: 'POST', body: 'x'}), 405, 'GET, HEAD'],
    [new Request(ORIGIN + '/api/publish/AbCd1234', {method: 'DELETE', headers: {Origin: origin}}), 503, null],
  ];
  for (const [request, status, allow] of checks) {
    const response = await worker.fetch(request, {});
    assert.equal(response.status, status, `${request.method} ${new URL(request.url).pathname}`);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('cache-control'), /no-store/);
    if (allow) assert.equal(response.headers.get('allow'), allow);
    assert.ok((await response.json()).message.length > 0);
  }
});

test('short-link errors are generic and never reflect the requested path', async () => {
  for (const path of ['/s/nope', '/s/..%2f..%2fsrc%2fworker.js', '/s/AbCd1234/extra', '/s/AbCd1234%20']) {
    const response = await worker.fetch(new Request(ORIGIN + path), {});
    assert.equal(response.status, 404, path);
    const text = await response.text();
    assert.deepEqual(Object.keys(JSON.parse(text)), ['message']);
    assert.doesNotMatch(text, /worker\.js|nope|AbCd|\.\.|kv|CONFIGS/i, path);
  }
  // A malformed revoke path is a plain 404 too, never a stack trace or a KV detail.
  const revoke = await worker.fetch(new Request(ORIGIN + '/api/publish/%2e%2e%2f%2e%2e', {
    method: 'DELETE', headers: {Origin: origin, 'X-Manage-Token': 'a'.repeat(64), 'CF-Connecting-IP': '203.0.113.240'},
  }), {});
  assert.equal(revoke.status, 404);
  assert.doesNotMatch(await revoke.text(), /worker\.js|\.\.|kv|CONFIGS/i);
});
