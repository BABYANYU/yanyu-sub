/*
 * Preflight policy for subscription sources, NOT a complete DNS-rebinding defense.
 * Cloudflare fetch() resolves the hostname again and does not expose a general
 * checked-IP dial/pinning API. DoH approval therefore has a DNS-to-connect race.
 * Keep redirects disabled in the caller. Strong arbitrary-host SSRF guarantees
 * require a controlled egress gateway that pins checked IPs and enforces egress ACLs.
 * No user URL, DNS answer, credential, or upstream error is logged or retained.
 */
const DENIED = 'SOURCE_DENIED';
const DEFAULT_OWN_HOST = 'sub.fakeyou.eu.org';
const DNS_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DNS_TIMEOUT_MS = 3000;
const MAX_ANSWERS = 64;
const MAX_CNAME_DEPTH = 8;

function deny() { throw new Error(DENIED); }

function dnsName(value) {
  if (typeof value !== 'string') deny();
  const name = value.toLowerCase().replace(/\.$/, '');
  if (name.length > 253 || !name.includes('.') ||
      !name.split('.').every(label => label.length >= 1 && label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) deny();
  if (/(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|onion|arpa)$/.test(name) ||
      /(?:^|\.)example\.(?:com|net|org)$/.test(name) || /^\d+(?:\.\d+)*$/.test(name)) deny();
  return name;
}

function assertNotOwnHost(host, ownHost) {
  if (host === ownHost || host.endsWith('.' + ownHost) || host === 'fakeyou.eu.org' ||
      host.endsWith('.fakeyou.eu.org')) deny();
}

function ipv4(value) {
  if (typeof value !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) deny();
  const parts = value.split('.');
  if (parts.some(part => Number(part) > 255 || (part.length > 1 && part[0] === '0'))) deny();
  return parts.reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}

function ipv6(value) {
  if (typeof value !== 'string' || !value.includes(':') || /[^0-9a-f:.]/i.test(value)) deny();
  let text = value.toLowerCase();
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    const tail = ipv4(text.slice(colon + 1));
    text = text.slice(0, colon + 1) + (tail >> 16n).toString(16) + ':' + (tail & 65535n).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) deny();
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) deny();
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) deny();
  const words = [...left, ...Array(missing).fill('0'), ...right];
  return words.reduce((result, word) => (result << 16n) | BigInt('0x' + word), 0n);
}

function inPrefix(value, base, length, bits) {
  const shift = BigInt(bits - length);
  return (value >> shift) === (base >> shift);
}

// Conservative exclusions: some globally reachable special-purpose exceptions
// inside these blocks are intentionally excluded. Keep policy reviewed with IANA.
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, length]) => [ipv4(base), length]);
const V6_BLOCKS = [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
].map(([base, length]) => [ipv6(base), length]);

function assertPublicAddress(type, value) {
  if (type === 1) {
    const address = ipv4(value);
    if (V4_BLOCKS.some(([base, length]) => inPrefix(address, base, length, 32))) deny();
  } else if (type === 28) {
    const address = ipv6(value);
    // Accept only ordinary global-unicast 2000::/3. This also excludes mapped
    // IPv4, NAT64, ULA, link-local, loopback, unspecified, multicast and zones.
    if (!inPrefix(address, ipv6('2000::'), 3, 128) ||
        V6_BLOCKS.some(([base, length]) => inPrefix(address, base, length, 128))) deny();
  } else deny();
}

function validateUrl(input, ownHost) {
  if (!(input instanceof URL)) deny();
  const source = new URL(input.href);
  if (source.href.length > 8192 || source.protocol !== 'https:' || source.username ||
      source.password || source.hash || (source.port && source.port !== '443') ||
      source.hostname.endsWith('.') || /[\u0000-\u0020\u007f\\]/u.test(source.href)) deny();
  const host = dnsName(source.hostname);
  const own = dnsName(ownHost);
  assertNotOwnHost(host, own);
  return source;
}

/**
 * Resolve both address families with a fixed DoH service; reject any non-public
 * answer. An empty family is valid (IPv4-only/IPv6-only hosts), but the combined
 * result must contain an address. Failures expose only SOURCE_DENIED.
 *
 * Input is already a URL: callers accepting raw text must reject control chars,
 * backslashes and invalid escapes BEFORE new URL(), which normalizes that text.
 * Returns a fresh URL; its hostname is not replaced with a resolved address.
 */
export async function validateResolvedSource(input, {
  resolverFetch = fetch,
  ownHost = DEFAULT_OWN_HOST,
} = {}) {
  const controller = new AbortController();
  let timer;
  try {
    const source = validateUrl(input, ownHost);
    if (typeof resolverFetch !== 'function') deny();
    const host = source.hostname;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(DENIED));
      }, DNS_TIMEOUT_MS);
    });
    const resolve = async type => {
      const endpoint = new URL(DNS_ENDPOINT);
      endpoint.searchParams.set('name', host);
      endpoint.searchParams.set('type', type === 1 ? 'A' : 'AAAA');
      const response = await resolverFetch(endpoint.href, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/dns-json' },
      });
      if (!response || !response.ok || response.redirected ||
          Number(response.headers?.get('content-length')) > 65536) deny();
      const body = await response.json();
      if (!body || body.Status !== 0 || body.TC === true ||
          (body.Answer !== undefined && !Array.isArray(body.Answer))) deny();
      const answers = body.Answer ?? [];
      if (answers.length > MAX_ANSWERS) deny();
      return answers;
    };
    const groups = await Promise.race([Promise.all([resolve(1), resolve(28)]), deadline]);
    const answers = groups.flat();
    const aliases = new Map();
    for (const answer of answers) {
      if (!answer || typeof answer !== 'object' || !Number.isInteger(answer.type)) deny();
      const owner = dnsName(answer.name);
      if (answer.type === 5) {
        const target = dnsName(answer.data);
        assertNotOwnHost(target, dnsName(ownHost));
        if (aliases.has(owner) && aliases.get(owner) !== target) deny();
        aliases.set(owner, target);
      } else if (answer.type === 1 || answer.type === 28) {
        assertPublicAddress(answer.type, answer.data);
      } else deny();
    }
    const reachable = new Set([host]);
    let current = host;
    for (let depth = 0; aliases.has(current); depth++) {
      if (depth >= MAX_CNAME_DEPTH) deny();
      current = aliases.get(current);
      if (reachable.has(current)) deny();
      reachable.add(current);
    }
    // Only records on the queried host's alias chain can approve the source.
    if (answers.some(answer => !reachable.has(dnsName(answer.name)))) deny();
    const addresses = answers.filter(answer => answer.type === 1 || answer.type === 28);
    if (!addresses.length || addresses.some(answer => aliases.has(dnsName(answer.name)))) deny();
    return source;
  } catch {
    throw new Error(DENIED);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
