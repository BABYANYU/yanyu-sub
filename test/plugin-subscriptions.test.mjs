import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import worker from '../src/worker.js';

test('authenticated plugin publication and dynamic refresh use the same short link', async (t) => {
  const origin = 'https://sub.fakeyou.eu.org';
  const token = 'a'.repeat(64);
  const entries = new Map();
  const kv = {
    get: async key => entries.get(key) ?? null,
    put: async (key, value) => entries.set(key, value),
    delete: async key => entries.delete(key),
  };
  const env = {
    CONFIGS: kv,
    PLUGIN_TOKEN_HASH: createHash('sha256').update(token).digest('hex'),
    SKIP_DNS_PREFLIGHT: true,
  };
  const post = (data, bearer) => worker.fetch(new Request(origin + '/api/plugin/publish', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer},
    body: JSON.stringify(data),
  }), env);
  const portable = {target: 'Mihomo', content: 'proxies: []', ttlSeconds: 365 * 86400};
  assert.equal((await post(portable, 'b'.repeat(64))).status, 401);
  assert.equal(entries.size, 0);
  const snapshot = await post(portable, token);
  assert.equal(snapshot.status, 200);
  const {url: snapshotUrl} = await snapshot.json();
  assert.equal(await (await worker.fetch(new Request(snapshotUrl), env)).text(), 'proxies: []');

  let upstreamHost = 'before.example.com';
  const upstream = 'https://subscription.example.com/hidden-source';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, upstream);
    assert.equal(options.redirect, 'manual');
    return new Response('trojan://fixture-pass@' + upstreamHost + ':443#Test');
  });
  const published = await post({target: 'Surge', sources: [upstream]}, token);
  assert.equal(published.status, 200);
  const {url} = await published.json();
  assert.equal(new URL(url).origin, origin);
  assert.equal(new URL(url).search, '');
  assert.match(await (await worker.fetch(new Request(url), env)).text(), /before\.example\.com/);
  upstreamHost = 'after.example.com';
  const updated = await (await worker.fetch(new Request(url), env)).text();
  assert.match(updated, /after\.example\.com/);
  assert.doesNotMatch(updated, /hidden-source|before\.example\.com/);
  assert.equal((await post({target: 'Surge', sources: ['https://127.0.0.1/']}, token)).status, 422);
});
