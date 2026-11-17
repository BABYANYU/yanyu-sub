// DNS preflight policy (src/source-policy.js) had no tests at all, and it is the
// only control that stops /api/fetch from being used against loopback, RFC1918,
// CGNAT, link-local/metadata or DNS-rebinding targets. Everything here runs
// offline against a fake DoH resolver.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateResolvedSource} from '../src/source-policy.js';

const OWN = 'sub.fakeyou.eu.org';
const HOST = 'sub.hackclub.dev';
const A = (name, data, type = 1) => ({name, type, data, TTL: 60});

function resolver(map, calls = []) {
  return async (url, options) => {
    const target = new URL(url);
    calls.push({url, options});
    const type = target.searchParams.get('type');
    const name = target.searchParams.get('name');
    const answers = map[`${name}/${type}`] ?? [];
    return Response.json(answers.length ? {Status: 0, Answer: answers} : {Status: 0});
  };
}

const run = (url, map, extra = {}) => validateResolvedSource(new URL(url), {resolverFetch: resolver(map), ownHost: OWN, ...extra});
const denied = async (url, map, extra) => assert.rejects(() => run(url, map, extra), (error) => {
  assert.equal(error.message, 'SOURCE_DENIED', 'internal detail must not be exposed');
  return true;
});

test('queries the fixed DoH endpoint for both families without following redirects', async () => {
  const calls = [];
  await validateResolvedSource(new URL(`https://${HOST}/x`), {
    resolverFetch: resolver({[`${HOST}/A`]: [A(HOST, '93.184.216.34')]}, calls),
    ownHost: OWN,
  });
  assert.equal(calls.length, 2);
  const seen = calls.map(({url}) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://cloudflare-dns.com');
    assert.equal(target.pathname, '/dns-query');
    assert.equal(target.searchParams.get('name'), HOST);
    return target.searchParams.get('type');
  });
  assert.deepEqual(seen.sort(), ['A', 'AAAA']);
  for (const {options} of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Accept, 'application/dns-json');
  }
});

test('accepts public IPv4, IPv6 and a CNAME chain that ends in a public address', async () => {
  assert.ok(await run(`https://${HOST}/x`, {[`${HOST}/A`]: [A(HOST, '93.184.216.34')]}));
  assert.ok(await run(`https://${HOST}/x`, {
    [`${HOST}/A`]: [A(HOST, '93.184.216.34')],
    [`${HOST}/AAAA`]: [A(HOST, '2606:2800:220:1:248:1893:25c8:1946', 28)],
  }));
  assert.ok(await run(`https://${HOST}/x`, {
    [`${HOST}/A`]: [A(HOST, 'edge.cdn.hackclub.dev', 5), A('edge.cdn.hackclub.dev', '93.184.216.34')],
  }));
  // DoH answers are commonly echoed with mixed case and a trailing dot.
  assert.ok(await run(`https://${HOST}/x`, {[`${HOST}/A`]: [A('SUB.HACKCLUB.DEV.', '93.184.216.34')]}));
});

test('rejects every non-public IPv4 range', async () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.1.1', '127.0.0.1', '169.254.169.254', '172.16.5.5',
    '192.0.0.8', '192.0.2.10', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.7',
    '224.0.0.1', '240.0.0.1', '255.255.255.255']) {
    await denied(`https://${HOST}/x`, {[`${HOST}/A`]: [A(HOST, address)]});
  }
});

test('rejects non-global IPv6 and IPv4-mapped forms', async () => {
  for (const address of ['::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fe80::1', 'fc00::1', 'fd00:ec2::254',
    '2001:db8::1', '2001::1', '2002::1', 'ff02::1']) {
    await denied(`https://${HOST}/x`, {[`${HOST}/AAAA`]: [A(HOST, address, 28)]});
  }
});

test('rejects malformed, out-of-range and non-canonical addresses', async () => {
  for (const address of ['93.184.216', '93.184.216.256', '93.184.216.01', '1.2.3.4.5', 'localhost', '93.184.216.34 ']) {
    await denied(`https://${HOST}/x`, {[`${HOST}/A`]: [A(HOST, address)]});
  }
});

test('an empty answer set is rejected instead of trusted', async () => {
  await denied(`https://${HOST}/x`, {});
  // A CNAME without any address record cannot approve the source.
  await denied(`https://${HOST}/x`, {[`${HOST}/A`]: [A(HOST, 'edge.cdn.hackclub.dev', 5)]});
});

test('rejects answers whose owner is outside the queried alias chain', async () => {
  await denied(`https://${HOST}/x`, {[`${HOST}/A`]: [A(HOST, '93.184.216.34'), A('other.hackclub.dev', '93.184.216.34')]});
});

test('rejects CNAME loops, over-deep chains and redirects to our own host', async () => {
  await denied(`https://${HOST}/x`, {[`${HOST}/A`]: [A(HOST, 'edge.hackclub.dev', 5), A('edge.hackclub.dev', HOST, 5)]});
  const chain = {};
  for (let i = 0; i < 12; i += 1) chain[`h${i}.hackclub.dev/A`] = [A(`h${i}.hackclub.dev`, `h${i + 1}.hackclub.dev`, 5)];
  chain['h12.hackclub.dev/A'] = [A('h12.hackclub.dev', '93.184.216.34')];
  await denied(`https://${HOST}/x`, {[`${HOST}/A`]: [A(HOST, 'h0.hackclub.dev', 5)], ...chain});
  await denied(`https://${HOST}/x`, {
    [`${HOST}/A`]: [A(HOST, 'sub.fakeyou.eu.org', 5), A('sub.fakeyou.eu.org', '93.184.216.34')],
  });
});

test('rejects reserved and internal names, credentials, ports and fragments', async () => {
  for (const url of ['https://localhost/x', 'https://metadata.google.internal/x', 'https://printer/x',
    'https://sub.local/x', 'https://sub.internal/x', 'https://sub.home.arpa/x', 'https://sub.onion/x',
    'https://subscription.example.com/x', 'https://2130706433/x', 'https://user:pass@sub.hackclub.dev/x',
    'https://sub.hackclub.dev:8443/x', 'https://sub.hackclub.dev/x#frag', 'http://sub.hackclub.dev/x',
    'https://sub.hackclub.dev./x']) {
    await denied(url, {[`${HOST}/A`]: [A(HOST, '93.184.216.34')]});
  }
});

test('rejects the deployment host itself', async () => {
  await denied('https://sub.fakeyou.eu.org/api/health', {});
  await denied('https://api.fakeyou.eu.org/x', {});
});

test('rejects hostile DoH responses instead of trusting them', async () => {
  const bad = (response) => () => validateResolvedSource(new URL(`https://${HOST}/x`), {resolverFetch: async () => response, ownHost: OWN});
  await assert.rejects(bad(Response.json({Status: 2})));
  await assert.rejects(bad(Response.json({Status: 0, TC: true, Answer: [A(HOST, '93.184.216.34')]})));
  await assert.rejects(bad(Response.json({Status: 0, Answer: {not: 'an array'}})));
  await assert.rejects(bad(Response.json({Status: 0, Answer: Array.from({length: 65}, (_, i) => A(HOST, `93.184.216.${i}`))})));
  await assert.rejects(bad(Response.json({Status: 0, Answer: [{name: HOST, type: 16, data: 'v=spf1 -all'}]})));
  await assert.rejects(bad(new Response('not json', {status: 200})));
  await assert.rejects(bad(new Response('{}', {status: 500})));
  await assert.rejects(bad(new Response('x'.repeat(70000), {status: 200})));
  const redirected = Response.json({Status: 0, Answer: [A(HOST, '93.184.216.34')]});
  Object.defineProperty(redirected, 'redirected', {value: true});
  await assert.rejects(bad(redirected));
});

test('non-URL input is refused before any lookup', async () => {
  let used = 0;
  const resolverFetch = async () => { used += 1; return Response.json({Status: 0, Answer: [A(HOST, '93.184.216.34')]}); };
  await assert.rejects(() => validateResolvedSource(`https://${HOST}/x`, {resolverFetch, ownHost: OWN}));
  assert.equal(used, 0);
});

test('a hanging resolver is cut off by the fixed timeout', async () => {
  const started = Date.now();
  await assert.rejects(() => validateResolvedSource(new URL(`https://${HOST}/x`), {
    resolverFetch: () => new Promise(() => {}),
    ownHost: OWN,
  }), /SOURCE_DENIED/);
  assert.ok(Date.now() - started < 5000, 'must not wait beyond the 3s DoH budget');
});
