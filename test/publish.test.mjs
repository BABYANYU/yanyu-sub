// Short subscription hosting contract: POST /api/publish, GET|HEAD /s/:token and
// DELETE /api/publish/:token. The KV binding (CONFIGS) is replaced with an in-memory
// Map so the suite runs offline and can inspect what would be written. Every test
// uses its own CF-Connecting-IP because the publish bucket allows 15 per 5 minutes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ORIGIN = 'https://sub.fakeyou.eu.org';
const origin = new URL(ORIGIN).origin;

function memoryKV(initial = new Map()) {
  const store = new Map(initial);
  const puts = [];
  const gets = [];
  const deletes = [];
  const lists = [];
  return {
    store,
    puts,
    gets,
    deletes,
    lists,
    async get(key) {
      gets.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      puts.push({key, value, options});
      store.set(key, value);
    },
    async delete(key) {
      deletes.push(key);
      store.delete(key);
    },
    // No route may scan the namespace any more; keeping list() proves that.
    async list(options = {}) {
      lists.push(options);
      const names = [...store.keys()].filter((key) => key.startsWith(options.prefix || ''));
      return {keys: names.slice(0, options.limit || 1000).map((name) => ({name})), list_complete: true};
    },
  };
}

let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter += 1) % 250}`;

const publish = (body, headers = {}) => new Request(ORIGIN + '/api/publish', {
  method: 'POST',
  headers: {Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp(), ...headers},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const content = 'trojan://fixture@node.example.com:443?sni=t.example.com#Fixture';

test('publish stores the config, returns a permanent short URL and serves it back verbatim', async () => {
  const CONFIGS = memoryKV();
  const published = await worker.fetch(publish({content, target: 'Mihomo'}), {CONFIGS});
  assert.equal(published.status, 200);
  assert.equal(published.headers.get('cache-control'), 'private, no-store');
  assert.equal(published.headers.get('x-content-type-options'), 'nosniff');
  const body = await published.json();
  assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'manageToken', 'url']);
  assert.equal(body.expiresAt, null, 'a default publication never expires');

  const token = body.url.slice((origin + '/s/').length);
  assert.equal(body.url, origin + '/s/' + token);
  assert.match(token, /^[A-Za-z0-9]{8}$/);
  assert.match(body.manageToken, /^[0-9a-f]{64}$/, 'manage token must be 32 random bytes, hex encoded');

  // Stored record: one KV write, private fields, no expiry at all.
  assert.equal(CONFIGS.puts.length, 1);
  const [{key, value, options}] = CONFIGS.puts;
  assert.equal(key, 's:' + token);
  assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ['content', 'createdAt', 'expiresAt', 'manageHash', 'target']);
  const stored = JSON.parse(value);
  assert.equal(stored.content, content);
  assert.equal(stored.target, 'Mihomo');
  assert.equal(stored.expiresAt, null, 'permanent records keep expiresAt=null');
  assert.equal(options?.expirationTtl, undefined, 'a default publication must not set expirationTtl');
  assert.equal(options?.expiration, undefined);
  assert.match(stored.manageHash, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.manageHash, body.manageToken, 'only the hash may be stored');
  assert.equal(JSON.parse(value).content === body.manageToken, false);

  const served = await worker.fetch(new Request(body.url), {CONFIGS});
  assert.equal(served.status, 200);
  assert.equal(await served.text(), content);
  assert.equal(served.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(served.headers.get('cache-control'), 'private, no-store');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(served.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(served.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('HEAD /s/:token sends the same headers without a body', async () => {
  const CONFIGS = memoryKV();
  const {url} = await (await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS})).json();
  const head = await worker.fetch(new Request(url, {method: 'HEAD'}), {CONFIGS});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(head.headers.get('cache-control'), 'private, no-store');
  assert.equal(head.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
});

test('an explicit legacy TTL is still honoured end to end', async () => {
  for (const ttlSeconds of [3600, 86400, 604800, 2592000]) {
    const CONFIGS = memoryKV();
    const response = await worker.fetch(publish({content, target: 'Surge', ttlSeconds}), {CONFIGS});
    assert.equal(response.status, 200, String(ttlSeconds));
    const {expiresAt} = await response.json();
    const stored = JSON.parse(CONFIGS.puts[0].value);
    assert.equal(CONFIGS.puts[0].options.expirationTtl, ttlSeconds);
    assert.equal(Date.parse(expiresAt) - Date.parse(stored.expiresAt), 0);
    const span = Date.parse(expiresAt) - Date.parse(stored.createdAt);
    assert.equal(span, ttlSeconds * 1000, `expiresAt must be createdAt + ${ttlSeconds}s`);
    assert.ok(Date.parse(expiresAt) > Date.now() - 5000);
    // The explicit TTL also still gates serving once the record is stale.
    const stale = memoryKV();
    await stale.put('s:AbCd1234', JSON.stringify({content, target: 'Surge', createdAt: new Date(Date.now() - 2 * ttlSeconds * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), manageHash: 'a'.repeat(64)}));
    assert.equal((await worker.fetch(new Request(origin + '/s/AbCd1234'), {CONFIGS: stale})).status, 404);
  }
});

test('a publication without ttlSeconds is permanent and never lapses in GET', async () => {
  const CONFIGS = memoryKV();
  const response = await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.expiresAt, null);
  assert.equal(CONFIGS.puts[0].options?.expirationTtl, undefined, 'no expirationTtl for permanent links');
  assert.equal(JSON.parse(CONFIGS.puts[0].value).expiresAt, null);

  // expiresAt:null, expiresAt omitted and a missing field all serve: only a real
  // timestamp in the past may retire a record.
  const token = body.url.split('/').pop();
  for (const [name, record] of [
    ['permanent', {content, target: 'Surge', createdAt: new Date().toISOString(), expiresAt: null, manageHash: 'a'.repeat(64)}],
    ['legacy-null', {content, target: 'Surge', createdAt: new Date().toISOString(), manageHash: 'a'.repeat(64)}],
    ['legacy-future', {content, target: 'Surge', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400e3).toISOString(), manageHash: 'a'.repeat(64)}],
  ]) {
    const kv = memoryKV();
    await kv.put('s:' + token, JSON.stringify(record));
    const served = await worker.fetch(new Request(body.url), {CONFIGS: kv});
    assert.equal(served.status, 200, name);
    assert.equal(await served.text(), content, name);
  }
  // A record that only KV expiry would have removed is still gone once the
  // timestamp has passed (old data keeps its original expiry).
  const legacy = memoryKV();
  await legacy.put('s:' + token, JSON.stringify({content, target: 'Surge', createdAt: new Date(Date.now() - 7200e3).toISOString(),
    expiresAt: new Date(Date.now() - 3600e3).toISOString(), manageHash: 'a'.repeat(64)}));
  assert.equal((await worker.fetch(new Request(body.url), {CONFIGS: legacy})).status, 404);
});

test('an out-of-range or non-numeric ttl is refused before anything is stored', async () => {
  for (const ttlSeconds of [0, 1, 3601, 86401, 604801, 2592001, -3600, '3600', 1.5, null, true]) {
    const CONFIGS = memoryKV();
    const response = await worker.fetch(publish({content, target: 'Surge', ttlSeconds}), {CONFIGS});
    assert.equal(response.status, 400, JSON.stringify(ttlSeconds));
    assert.equal(CONFIGS.puts.length, 0);
    assert.match((await response.json()).message, /有效期/);
  }
});

test('the request body is capped at 2 MiB', async () => {
  const CONFIGS = memoryKV();
  const huge = await worker.fetch(publish({content: 'x'.repeat(2 * 1024 * 1024), target: 'Surge'}), {CONFIGS});
  assert.equal(huge.status, 413);
  assert.equal(CONFIGS.puts.length, 0);
  assert.doesNotMatch(JSON.stringify(await huge.json()), /xxxx/, 'the refusal must not echo the body');

  // Declared length alone is enough to refuse, and a near-limit body still works.
  const declared = await worker.fetch(new Request(ORIGIN + '/api/publish', {
    method: 'POST',
    headers: {Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp(), 'Content-Length': String(3 * 1024 * 1024)},
    body: JSON.stringify({content, target: 'Surge'}),
  }), {CONFIGS});
  assert.equal(declared.status, 413);
  assert.equal(CONFIGS.puts.length, 0);

  const ok = await worker.fetch(publish({content: 'y'.repeat(1024 * 1024), target: 'Surge'}), {CONFIGS});
  assert.equal(ok.status, 200);
  assert.equal(CONFIGS.puts.length, 1);
});

test('publish requires a same-origin request with a JSON content type', async () => {
  const cases = [
    publish({content, target: 'Surge'}, {Origin: 'https://attacker.example'}),
    publish({content, target: 'Surge'}, {Origin: 'https://sub.fakeyou.eu.org.evil.example'}),
    publish({content, target: 'Surge'}, {'Content-Type': 'text/plain'}),
    new Request(ORIGIN + '/api/publish', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({content, target: 'Surge'})}),
  ];
  for (const [index, request] of cases.entries()) {
    const CONFIGS = memoryKV();
    const response = await worker.fetch(request, {CONFIGS});
    assert.equal(response.status, 403, `case ${index}`);
    assert.deepEqual(await response.json(), {message: '请求来源不匹配'});
    assert.equal(CONFIGS.puts.length, 0);
    assert.equal(CONFIGS.gets.length, 0, 'rejected traffic must not touch KV');
  }
  const wrongMethod = await worker.fetch(new Request(ORIGIN + '/api/publish'), {CONFIGS: memoryKV()});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
});

test('a missing CONFIGS binding answers 503 on every short-link route', async () => {
  for (const env of [{}, {CONFIGS: null}, {CONFIGS: {}}]) {
    const published = await worker.fetch(publish({content, target: 'Surge'}), env);
    assert.equal(published.status, 503, JSON.stringify(env));
    assert.match((await published.json()).message, /未配置|不可用/);
  }
  const serve = await worker.fetch(new Request(origin + '/s/AbCd1234'), {});
  assert.equal(serve.status, 503);
  const revoke = await worker.fetch(new Request(origin + '/api/publish/AbCd1234', {
    method: 'DELETE', headers: {Origin: origin, 'X-Manage-Token': 'a'.repeat(64), 'CF-Connecting-IP': nextIp()},
  }), {});
  assert.equal(revoke.status, 503);
});

test('the short token is exactly 8 base62 characters, random and collision-checked', async () => {
  const CONFIGS = memoryKV();
  const tokens = new Set();
  for (let i = 0; i < 20; i += 1) {
    const response = await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS});
    assert.equal(response.status, 200);
    const token = (await response.json()).url.split('/').pop();
    assert.match(token, /^[A-Za-z0-9]{8}$/);
    assert.equal(token.length, 8);
    tokens.add(token);
  }
  assert.equal(tokens.size, 20, 'tokens must not repeat');

  // A stored token is retried, up to five attempts, then published under a free one.
  const occupied = new Set();
  const collision = memoryKV();
  collision.get = async (key) => {
    collision.gets.push(key);
    if (collision.gets.length <= 2) {
      occupied.add(key);
      return JSON.stringify({content, target: 'Surge', manageHash: 'a'.repeat(64)});
    }
    return null;
  };
  const retried = await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS: collision});
  assert.equal(retried.status, 200);
  const fresh = (await retried.json()).url.split('/').pop();
  assert.equal(collision.gets.length, 3, 'two collisions then a free token');
  assert.equal(occupied.has('s:' + fresh), false);

  // Five collisions in a row give up with a generic error and write nothing.
  const exhausted = memoryKV();
  exhausted.put = async (key, value) => {exhausted.puts.push({key, value});};
  exhausted.get = async (key) => {exhausted.gets.push(key); return JSON.stringify({content, target: 'Surge'});};
  const failed = await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS: exhausted});
  assert.equal(failed.status, 503);
  assert.equal(exhausted.gets.length, 5);
  assert.equal(exhausted.puts.length, 0);
});

test('publish validates content and target without echoing what was sent', async () => {
  const bad = [
    [{target: 'Surge'}, 422],
    [{content: '', target: 'Surge'}, 422],
    [{content: '   \n\t ', target: 'Surge'}, 422],
    [{content: 42, target: 'Surge'}, 422],
    [{content, target: 'Clash'}, 422],
    [{content, target: 'surge'}, 422],
    [{content}, 422],
    ['[]', 400],
    ['null', 400],
    ['"text"', 400],
    ['{not json', 400],
  ];
  for (const [body, status] of bad) {
    const CONFIGS = memoryKV();
    const response = await worker.fetch(publish(body), {CONFIGS});
    assert.equal(response.status, status, JSON.stringify(body).slice(0, 40));
    assert.equal(CONFIGS.puts.length, 0);
    const text = await response.text();
    assert.doesNotMatch(text, /node\.example\.com|trojan:\/\//, 'errors must not echo the payload');
    assert.ok(JSON.parse(text).message.length > 0);
  }
  const invalidUtf8 = await worker.fetch(new Request(ORIGIN + '/api/publish', {
    method: 'POST',
    headers: {Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp()},
    body: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
  }), {CONFIGS: memoryKV()});
  assert.equal(invalidUtf8.status, 400);
  assert.match((await invalidUtf8.json()).message, /UTF-8/);
});

test('unknown, malformed and traversing short tokens are 404 without path echo', async () => {
  const CONFIGS = memoryKV();
  for (const path of ['/s/AbCd1234', '/s/abcdefgh', '/s/00000000']) {
    const response = await worker.fetch(new Request(origin + path), {CONFIGS});
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), {message: '短链接不存在'});
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const path of ['/s/', '/s/short', '/s/AbCd12345', '/s/AbCd123', '/s/AbCd-123', '/s/AbCd%2e123',
    '/s/AbCd1234/extra', '/s/%2e%2e%2f%2e%2e%2fsrc', '/s/AbCd1234?x=1']) {
    const response = await worker.fetch(new Request(origin + path), {CONFIGS});
    assert.equal(response.status, 404, path);
    const text = await response.text();
    assert.doesNotMatch(text, /AbCd|\.\.|src\/worker/, `${path} must not be echoed`);
  }
  const wrongMethod = await worker.fetch(new Request(origin + '/s/AbCd1234', {method: 'POST', body: 'x'}), {CONFIGS});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
});

test('GET serves only the stored text, never the manage hash', async () => {
  const CONFIGS = memoryKV();
  const published = await (await worker.fetch(publish({content: 'mihomo: 配置', target: 'Surge'}), {CONFIGS})).json();
  const served = await worker.fetch(new Request(published.url), {CONFIGS});
  const text = await served.text();
  assert.equal(text, 'mihomo: 配置');
  assert.doesNotMatch(text, new RegExp(published.manageToken));
  assert.doesNotMatch(await (await worker.fetch(new Request(origin + '/s/ZZZZZZZZ'), {CONFIGS})).text(), /kv|namespace|CONFIGS/i);
});

test('revoke deletes the key with the right manage token and refuses everything else', async () => {
  const CONFIGS = memoryKV();
  const published = await (await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS})).json();
  const token = published.url.split('/').pop();
  const revoke = (manageToken, headers = {}) => new Request(origin + '/api/publish/' + token, {
    method: 'DELETE',
    headers: {Origin: origin, 'X-Manage-Token': manageToken, 'CF-Connecting-IP': nextIp(), ...headers},
  });

  const wrong = await worker.fetch(revoke('b'.repeat(64)), {CONFIGS});
  assert.equal(wrong.status, 403);
  assert.deepEqual(await wrong.json(), {message: '管理令牌无效'});
  assert.equal(CONFIGS.deletes.length, 0);
  assert.equal((await worker.fetch(new Request(published.url), {CONFIGS})).status, 200);

  const missing = await worker.fetch(new Request(origin + '/api/publish/' + token, {
    method: 'DELETE', headers: {Origin: origin, 'CF-Connecting-IP': nextIp()},
  }), {CONFIGS});
  assert.equal(missing.status, 403);

  const foreign = await worker.fetch(new Request(origin + '/api/publish/' + token, {
    method: 'DELETE', headers: {Origin: 'https://attacker.example', 'X-Manage-Token': published.manageToken, 'CF-Connecting-IP': nextIp()},
  }), {CONFIGS});
  assert.equal(foreign.status, 403);
  assert.deepEqual(await foreign.json(), {message: '请求来源不匹配'});

  const ok = await worker.fetch(revoke(published.manageToken), {CONFIGS});
  assert.equal(ok.status, 204);
  assert.equal(await ok.text(), '');
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(CONFIGS.deletes, ['s:' + token]);
  assert.equal((await worker.fetch(new Request(published.url), {CONFIGS})).status, 404);
  assert.equal((await worker.fetch(revoke(published.manageToken), {CONFIGS})).status, 404);
});

test('revoke answers 404 for unknown or malformed tokens and 405 for other methods', async () => {
  const CONFIGS = memoryKV();
  for (const token of ['AbCd1234', 'short', 'AbCd12345', '']) {
    const response = await worker.fetch(new Request(origin + '/api/publish/' + token, {
      method: 'DELETE', headers: {Origin: origin, 'X-Manage-Token': 'a'.repeat(64), 'CF-Connecting-IP': nextIp()},
    }), {CONFIGS});
    assert.equal(response.status, 404, token);
    assert.deepEqual(await response.json(), {message: '短链接不存在'});
  }
  const wrongMethod = await worker.fetch(new Request(origin + '/api/publish/AbCd1234', {
    method: 'POST', headers: {Origin: origin}, body: '{}',
  }), {CONFIGS});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'DELETE');
});

test('publish and revoke share a 15-per-5-minute bucket per client address', async () => {
  const ip = '203.0.113.200';
  const CONFIGS = memoryKV();
  const statuses = [];
  for (let i = 0; i < 17; i += 1) {
    statuses.push((await worker.fetch(publish({content, target: 'Surge'}, {'CF-Connecting-IP': ip}), {CONFIGS})).status);
  }
  assert.deepEqual(statuses, [...Array(15).fill(200), 429, 429]);
  assert.equal(CONFIGS.puts.length, 15, 'rejected requests must not be stored');

  // Revoke draws from the same bucket, so the same address stays blocked.
  const published = JSON.parse(CONFIGS.puts[0].value);
  const revoked = await worker.fetch(new Request(origin + '/api/publish/ZZZZZZZZ', {
    method: 'DELETE', headers: {Origin: origin, 'X-Manage-Token': 'a'.repeat(64), 'CF-Connecting-IP': ip},
  }), {CONFIGS});
  assert.equal(revoked.status, 429);
  assert.equal(published.target, 'Surge');

  // A different address keeps its own budget.
  const other = await worker.fetch(publish({content, target: 'Surge'}, {'CF-Connecting-IP': '203.0.113.201'}), {CONFIGS});
  assert.equal(other.status, 200);

  // The /api/fetch quota (20/min) is a separate bucket and stays unaffected.
  const fetchStatuses = [];
  for (let i = 0; i < 3; i += 1) {
    const request = new Request(ORIGIN + '/api/fetch', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.202'},
      body: JSON.stringify({url: 'https://subscription.example.org/sub'}),
    });
    fetchStatuses.push((await worker.fetch(request, {SKIP_DNS_PREFLIGHT: 'true'})).status);
  }
  assert.deepEqual(fetchStatuses, [422, 422, 422], 'fetch quota must not be consumed by publish');
  const stillAllowed = await worker.fetch(publish({content, target: 'Surge'}, {'CF-Connecting-IP': '203.0.113.202'}), {CONFIGS});
  assert.equal(stillAllowed.status, 200);
});

test('a revoked or expiring record never leaks content through errors or console', async () => {
  const calls = [];
  const original = {log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug};
  for (const name of Object.keys(original)) console[name] = (...args) => calls.push([name, args.join(' ')]);
  try {
    const CONFIGS = memoryKV();
    const published = await (await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS})).json();
    await worker.fetch(new Request(published.url), {CONFIGS});
    await worker.fetch(new Request(published.url, {method: 'HEAD'}), {CONFIGS});
    await worker.fetch(new Request(origin + '/api/publish/' + published.url.split('/').pop(), {
      method: 'DELETE', headers: {Origin: origin, 'X-Manage-Token': published.manageToken, 'CF-Connecting-IP': nextIp()},
    }), {CONFIGS});
    await worker.fetch(new Request(published.url), {CONFIGS});
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(calls, [], 'the worker must not log requests, content or tokens');
});

test('a KV failure surfaces as a generic 503, never as an internal error string', async () => {
  const failing = {
    get: async () => { throw new Error('KV GET failed: s:AbCd1234 CONFIGS namespace'); },
    put: async () => { throw new Error('KV PUT failed: s:AbCd1234'); },
    delete: async () => { throw new Error('KV DELETE failed: s:AbCd1234'); },
  };
  const published = await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS: failing});
  assert.equal(published.status, 503);
  const served = await worker.fetch(new Request(origin + '/s/AbCd1234'), {CONFIGS: failing});
  assert.equal(served.status, 503);
  for (const response of [published, served]) {
    const text = await response.text();
    assert.doesNotMatch(text, /KV |namespace|CONFIGS|s:AbCd1234/);
  }
  // A record that outlived its TTL is treated as gone.
  const stale = memoryKV(new Map([['s/AbCd1234', '']]));
  const expired = memoryKV();
  await expired.put('s:AbCd1234', JSON.stringify({content, target: 'Surge', createdAt: new Date(Date.now() - 7200e3).toISOString(),
    expiresAt: new Date(Date.now() - 3600e3).toISOString(), manageHash: 'a'.repeat(64)}));
  assert.equal((await worker.fetch(new Request(origin + '/s/AbCd1234'), {CONFIGS: expired})).status, 404);
  assert.equal(stale.store.size, 1);
});

test('the existing API surface and headers are unchanged by the publish routes', async () => {
  const health = await worker.fetch(new Request(ORIGIN + '/api/health'), {});
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(await health.json()).sort(), ['engine', 'ok', 'revision', 'targets', 'version']);
  assert.equal((await worker.fetch(new Request(ORIGIN + '/api/nope'), {})).status, 404);
  assert.equal((await worker.fetch(new Request(ORIGIN + '/nope'), {})).status, 404);
  const page = await worker.fetch(new Request(ORIGIN + '/'), {});
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

// An older UI put the 64-hex manage token in the DELETE path. That alias made the
// secret alone sufficient to revoke (plus a KV list scan per request), so it is gone:
// the path must be the short token and the secret must arrive in the header.
test('a 64-hex manage token in the DELETE path is refused without touching KV', async () => {
  const CONFIGS = memoryKV();
  const published = await (await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS})).json();
  const short = published.url.split('/').pop();
  const revoke = (pathToken, manageToken) => new Request(origin + '/api/publish/' + pathToken, {
    method: 'DELETE',
    headers: {Origin: origin, 'X-Manage-Token': manageToken, 'CF-Connecting-IP': nextIp()},
  });

  const before = {gets: CONFIGS.gets.length, puts: CONFIGS.puts.length, deletes: CONFIGS.deletes.length, lists: CONFIGS.lists.length};
  for (const [pathToken, manageToken] of [
    [published.manageToken, published.manageToken],
    [published.manageToken, 'c'.repeat(64)],
    ['d'.repeat(64), 'd'.repeat(64)],
  ]) {
    const response = await worker.fetch(revoke(pathToken, manageToken), {CONFIGS});
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {message: '短链接不存在'});
  }
  assert.deepEqual({gets: CONFIGS.gets.length, puts: CONFIGS.puts.length, deletes: CONFIGS.deletes.length, lists: CONFIGS.lists.length}, before,
    'a rejected path shape must not read, list or write KV');
  assert.equal((await worker.fetch(new Request(published.url), {CONFIGS})).status, 200, 'the link is still live');

  // Revocation capability is unchanged: short token in the path + secret in the header.
  const ok = await worker.fetch(new Request(origin + '/api/publish/' + short, {
    method: 'DELETE', headers: {Origin: origin, 'X-Manage-Token': published.manageToken, 'CF-Connecting-IP': nextIp()},
  }), {CONFIGS});
  assert.equal(ok.status, 204);
  assert.deepEqual(CONFIGS.deletes, ['s:' + short]);
  assert.equal((await worker.fetch(new Request(published.url), {CONFIGS})).status, 404);
});

// The short-token path is the only revoke shape, so no short-link route may ever scan
// the namespace (the removed alias did one list() plus up to 200 get() per request).
test('no short-link route lists the KV namespace', async () => {
  const CONFIGS = memoryKV();
  const published = await (await worker.fetch(publish({content, target: 'Surge'}), {CONFIGS})).json();
  const short = published.url.split('/').pop();
  await worker.fetch(new Request(published.url), {CONFIGS});
  await worker.fetch(new Request(published.url, {method: 'HEAD'}), {CONFIGS});
  await worker.fetch(new Request(origin + '/api/publish/' + short, {
    method: 'DELETE', headers: {Origin: origin, 'X-Manage-Token': published.manageToken, 'CF-Connecting-IP': nextIp()},
  }), {CONFIGS});
  assert.deepEqual(CONFIGS.lists, []);
});

test('a full publish bucket rejects new addresses instead of growing without bound', async () => {
  const CONFIGS = memoryKV();
  // One address that already holds a bucket before the table fills.
  const known = '192.0.2.240';
  assert.equal((await worker.fetch(publish({content, target: 'Surge'}, {'CF-Connecting-IP': known}), {CONFIGS})).status, 200);

  // Every publish attempt consumes a bucket before validation, so an invalid payload
  // fills the table cheaply (422 = counted, 429 = table full and the key is new).
  const statuses = [];
  for (let i = 0; i < 1200; i += 1) {
    const ip = `100.${Math.floor(i / 250)}.${i % 250}.7`;
    statuses.push((await worker.fetch(publish({target: 'Surge'}, {'CF-Connecting-IP': ip}), {CONFIGS})).status);
  }
  const capped = statuses.indexOf(429);
  assert.ok(capped > 0, 'the table must stop accepting new addresses once it is full');
  assert.ok(capped >= 600, 'the table only refuses once ~1000 buckets exist');
  assert.ok(!statuses.slice(capped).includes(422), 'once full, no further new address is counted');
  assert.equal(CONFIGS.puts.length, 1, 'nothing capped out may reach KV');

  // Fail closed for a brand-new address, even with a valid payload.
  const fresh = await worker.fetch(publish({content, target: 'Surge'}, {'CF-Connecting-IP': '100.250.250.250'}), {CONFIGS});
  assert.equal(fresh.status, 429);
  assert.equal(CONFIGS.puts.length, 1);

  // An address that already holds a bucket keeps working while the table is full.
  assert.equal((await worker.fetch(publish({content, target: 'Surge'}, {'CF-Connecting-IP': known}), {CONFIGS})).status, 200);
});
