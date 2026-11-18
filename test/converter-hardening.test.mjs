// Robustness boundaries of the converter that adversarial input reaches:
// pathological YAML nesting (superlinear parse cost), unbounded line counts, node
// names that are structural inside the generated Surge line, and a non-JSON answer
// from /api/fetch. Each test pins the guard that now stops the input early.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {convertTexts, convertSources, parseInput} from '../public/converter.js';

const capture = (fn) => { try { fn(); return null; } catch (error) { return error; } };
const captureAsync = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };
const node = (extra = {}) => ({name: 'N', type: 'trojan', server: 'node.example.com', port: 443, password: 'p', ...extra});

// 200 KB of "proxies: [[[[…" used to spend ~13 s inside the YAML parser before it
// reported a syntax error, freezing the page for a body well under the 1 MiB cap.
test('deeply nested flow collections are refused in linear time', () => {
  for (const depth of [2000, 200000]) {
    const started = Date.now();
    const error = capture(() => parseInput('proxies: ' + '['.repeat(depth)));
    const elapsed = Date.now() - started;
    assert.equal(error?.name, 'ConversionError', `depth ${depth}: ${error?.message}`);
    assert.match(error.message, /嵌套过深/, `depth ${depth}`);
    assert.ok(elapsed < 5000, `depth ${depth} took ${elapsed}ms`);
  }
});

// The guard is a depth limit, not a ban on flow style: shallow collections still
// reach the YAML parser and get its own (unrelated) diagnostics.
test('flow collections below the depth limit still reach the YAML parser', () => {
  const error = capture(() => parseInput('proxies: ' + '['.repeat(60)));
  assert.equal(error?.name, 'ConversionError');
  assert.match(error.message, /YAML 格式错误/);
  const ok = parseInput('proxies: [{name: A, type: trojan, server: node.example.com, port: 443, password: p}]');
  assert.equal(ok.length, 1);
});

// The per-line parser used to run over every line before the node-count limit was
// checked, so a 1 MiB body of short lines cost seconds of CPU for an error.
test('the line count is checked before any line is parsed', () => {
  const lines = Array.from({length: 3000}, (_, i) => `n${i}:x`).join('\n');
  const error = capture(() => parseInput(lines));
  assert.equal(error?.name, 'ConversionError');
  assert.match(error.message, /最多 2000 个/, `got: ${error.message}`);

  const atLimit = Array.from({length: 2000}, (_, i) => `trojan://p@node.example.com:443#L${i}`).join('\n');
  assert.equal(parseInput(atLimit).length, 2000);
  const overLimit = atLimit + '\ntrojan://p@node.example.com:443#Extra';
  assert.match(capture(() => parseInput(overLimit))?.message || '', /最多 2000 个/);
});

// A backslash is an escape character in the generated Surge line, so a name ending in
// one made "A\" + ", B" read as a single escaped separator.
test('a backslash in a node name cannot escape a structural separator', () => {
  const proxies = [node({name: 'A\\'}), node({name: 'B'}), node({name: 'C\\,D'})];
  const content = convertTexts({target: 'Surge', sources: [JSON.stringify({proxies})]}).content;
  const group = content.split('\n').find((line) => line.startsWith('Proxy ='));
  assert.doesNotMatch(group, /\\/);
  assert.equal(group, 'Proxy = select, A, B, C D');
  for (const line of content.split('\n').filter((line) => line.includes('=trojan'))) {
    assert.doesNotMatch(line, /\\/);
  }
  // Mihomo keeps the same names and never needs the escape.
  const mihomo = convertTexts({target: 'Mihomo', sources: [JSON.stringify({proxies})]});
  assert.deepEqual(parse(mihomo.content).proxies.map((proxy) => proxy.name), ['A', 'B', 'C D']);
});

// convertSources() reads /api/fetch, which can answer with an edge error page instead
// of JSON. A raw SyntaxError from r.json() used to escape to the UI unchanged.
test('convertSources maps a non-JSON or failed /api/fetch answer to a ConversionError', async () => {
  const original = globalThis.fetch;
  const cases = [
    ['html edge error', () => new Response('<html>bad gateway</html>', {status: 502}), /读取失败/],
    ['200 without JSON', () => new Response('not json', {status: 200}), /读取失败/],
    ['json without text', () => Response.json({ok: true}, {status: 200}), /读取失败/],
    ['quota message', () => Response.json({message: '请求过于频繁，请稍后重试'}, {status: 429}), /请求过于频繁/],
  ];
  try {
    for (const [name, stub, pattern] of cases) {
      globalThis.fetch = async () => stub();
      const error = await captureAsync(() => convertSources({target: 'Surge', sources: ['https://subscription.example.org/sub']}));
      assert.equal(error?.name, 'ConversionError', `${name}: ${error?.name} ${error?.message}`);
      assert.match(error.message, pattern, name);
    }
    globalThis.fetch = async () => Response.json({text: 'trojan://p@node.example.com:443#Ok'});
    const converted = await convertSources({target: 'Surge', sources: ['https://subscription.example.org/sub']});
    assert.equal(converted.count, 1);
  } finally {
    globalThis.fetch = original;
  }
});
