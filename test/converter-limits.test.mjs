// Interface limits and shapes of convertTexts/parseInput that public/app.js and
// the README promise to users. These are the boundaries a UI revamp or a
// "helpful" refactor tends to move silently.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {convertTexts, parseInput} from '../public/converter.js';

const node = (extra = {}) => ({name: 'N', type: 'trojan', server: 'node.example.com', port: 443, password: 'p', ...extra});
const json = (nodes) => JSON.stringify({proxies: nodes});
const uri = 'trojan://p@node.example.com:443?sni=t.example.com#Test';

test('1–4 sources are accepted, 0 and 5 are rejected', () => {
  for (const count of [1, 2, 3, 4]) {
    assert.equal(convertTexts({target: 'Surge', sources: Array(count).fill(uri)}).count, count);
  }
  for (const sources of [[], Array(5).fill(uri)]) {
    assert.throws(() => convertTexts({target: 'Surge', sources}), /1–4 个订阅来源/);
  }
});

test('target whitelist is exactly Surge/Mihomo and is case sensitive', () => {
  for (const target of ['Surge', 'Mihomo']) assert.doesNotThrow(() => convertTexts({target, sources: [uri]}));
  for (const target of ['surge', 'mihomo', 'Clash', 'Loon', '', undefined]) {
    assert.throws(() => convertTexts({target, sources: [uri]}), /仅支持 Surge 或 Mihomo/);
  }
});

test('result shape is stable for both targets', () => {
  for (const target of ['Surge', 'Mihomo']) {
    const result = convertTexts({target, sources: [uri]});
    assert.deepEqual(Object.keys(result).sort(), ['content', 'count', 'warnings']);
    assert.equal(typeof result.content, 'string');
    assert.ok(result.content.endsWith('\n'), `${target} output should end with a newline`);
    assert.ok(Number.isInteger(result.count));
    assert.deepEqual(result.warnings, [], 'no silent partial conversion is reported today');
  }
});

test('Mihomo output never drops a node', () => {
  const nodes = [node(), node({name: 'B', type: 'vless', uuid: '00000000-0000-4000-8000-000000000001'}),
    node({name: 'C', type: 'hysteria2', obfs: 'salamander', 'obfs-password': 'x'}),
    node({name: 'D', type: 'anytls'})];
  const result = convertTexts({target: 'Mihomo', sources: [json(nodes)]});
  const parsed = parse(result.content);
  assert.equal(result.count, nodes.length);
  assert.equal(parsed.proxies.length, nodes.length);
  assert.equal(parsed['proxy-groups'][0].proxies.length, nodes.length);
  assert.deepEqual(parsed.rules, ['GEOIP,cn,DIRECT', 'MATCH,Proxy']);
  assert.equal(parsed['proxy-groups'].length, 1, 'exactly one select group is generated');
});

test('Surge output keeps one select group and the fixed rule set', () => {
  const content = convertTexts({target: 'Surge', sources: [uri, uri.replace('#Test', '#Two')]}).content;
  const groups = content.split('\n').filter((line) => line.startsWith('Proxy ='));
  assert.equal(groups.length, 1);
  assert.match(groups[0], /^Proxy = select, Test, Two$/);
  assert.match(content, /\[General\]\ndns-server = 223\.5\.5\.5\nipv6 = false/);
  assert.match(content, /\[Rule\]\nGEOIP,CN,DIRECT\nFINAL,Proxy\n$/);
});

test('node count and name length boundaries are enforced', () => {
  const many = Array.from({length: 2001}, (_, i) => node({name: `n${i}`}));
  assert.throws(() => parseInput(json(many)), /最多 2000 个/);
  assert.equal(parseInput(json(many.slice(0, 2000))).length, 2000);
  assert.throws(() => convertTexts({target: 'Surge', sources: [json([node({name: 'x'.repeat(121)})])]}), /名称无效/);
  assert.equal(convertTexts({target: 'Surge', sources: [json([node({name: 'y'.repeat(120)})])]}).count, 1);
});

test('oversize input is refused before parsing', () => {
  assert.throws(() => parseInput('x'.repeat(1024 * 1024 + 1)), /最多 1 MiB/);
});

test('names that only differ by structural characters stay unique', () => {
  const result = convertTexts({target: 'Mihomo', sources: [json([node({name: 'A,B'}), node({name: 'A;B'}), node({name: 'A B'})])]});
  const names = parse(result.content).proxies.map((proxy) => proxy.name);
  assert.equal(new Set(names).size, 3);
  for (const name of names) assert.doesNotMatch(name, /[,;"'[\]|#]/);
});

test('built-in Surge policy names, including Proxy, are never reused as node names', () => {
  const content = convertTexts({target: 'Surge', sources: [json([node({name: 'Proxy'}), node({name: 'DIRECT'})])]}).content;
  const group = content.split('\n').find((line) => line.startsWith('Proxy = select'));
  assert.doesNotMatch(group.slice('Proxy = select, '.length), /^(?:Proxy|DIRECT)(?:,|$)/m);
  assert.match(group, /Proxy 节点, DIRECT 节点/);
});

test('Surge config input is read from [Proxy] only, other sections are ignored', () => {
  const config = ['[General]', 'dns-server = 1.1.1.1', '[Proxy]', '# comment',
    'TROJAN-A = trojan, node.example.com, 443, password=p, sni=t.example.com',
    '[Proxy Group]', 'Proxy = select, TROJAN-A', '[Rule]', 'FINAL,DIRECT'].join('\n');
  const parsed = parseInput(config);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].server, 'node.example.com');
});

const capture = (fn) => { try { fn(); return null; } catch (error) { return error; } };

test('unsupported protocols block the whole conversion instead of being skipped', () => {
  for (const target of ['Surge', 'Mihomo']) {
    assert.ok(capture(() => convertTexts({target, sources: [uri + '\nunknown://user@node.example.com:443']})), `${target} must reject the batch`);
  }
  const ssr = json([node({type: 'ssr'})]);
  assert.throws(() => convertTexts({target: 'Surge', sources: [ssr]}), /暂不支持输出 Surge/);
  assert.equal(convertTexts({target: 'Mihomo', sources: [ssr]}).count, 1);
});

// Unknown schemes must be classified like any other bad node so the UI can show
// an actionable message instead of a raw TypeError.
test('an unrecognized scheme is reported as a ConversionError naming the line', () => {
  for (const input of ['unknown://user@node.example.com:443', 'foo://bar', 'not-a-node']) {
    const error = capture(() => parseInput(input));
    assert.ok(error, `${input} must be rejected`);
    assert.equal(error.name, 'ConversionError', `${input} leaks ${error.name}: ${error.message}`);
    assert.match(error.message, /第 1 个节点/);
  }
});

// GAP (robustness): every rejection should be a ConversionError carrying the
// offending line, so the UI keeps its actionable message.
test('every parse failure is a ConversionError naming the offending line', () => {
  for (const input of ['unknown://user@node.example.com:443', 'foo://bar']) {
    const error = capture(() => parseInput(input));
    assert.equal(error?.name, 'ConversionError');
    assert.match(error.message, /第 1 个节点/);
  }
});
