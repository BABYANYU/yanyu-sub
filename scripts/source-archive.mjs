// AGPL-3.0 §13: the site must offer the complete corresponding source of exactly
// what is deployed. This script packs the repository sources into public/source.tar.gz.
//
// Fail-fast rules (a silently incomplete source archive is a licence violation):
//   * every entry in SOURCES must exist — no path is allowed to be quietly skipped;
//   * every public/ source file is included (the whole directory is walked), except
//     the two files the build itself generates;
//   * generated bundles, dependencies and secrets are refused, and symlinks abort.
import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';

// Tracked paths that belong in the archive. A missing one fails the build.
export const SOURCES = [
  '.gitignore',
  '.github',
  'LICENSE',
  'NOTICE.md',
  'README.md',
  'documentation/HOSTED-LINKS-2026-11-17.md',
  'package.json',
  'package-lock.json',
  'wrangler.json',
  'src',
  'scripts',
  'test',
  'vendor',
  'public',
];
// public/ is walked wholesale, but these must be present: the page cannot be
// rebuilt or reviewed without them.
export const REQUIRED_PUBLIC_SOURCES = ['public/index.html', 'public/app.js', 'public/style.css', 'public/theme.js'];
// Written by the build itself: shipping them would ship a generated blob, not source.
export const GENERATED = new Set(['src/assets.generated.js', 'src/build-info.generated.js', 'public/converter.js', 'public/source.tar.gz']);
const FORBIDDEN = /(^|\/)(?:node_modules|\.wrangler|dist)(?:\/|$)|(^|\/)\.git(?:\/|$)|(^|\/)\.(?:dev\.vars|env)(?:\.|$)/;

/** Absolute-ish path join that keeps archive names POSIX and root-relative. */
const join = (root, rel) => (root === '.' ? rel : path.join(root, rel));

async function walk(root, rel, files) {
  const full = join(root, rel);
  const stat = await fs.lstat(full);
  if (stat.isSymbolicLink()) throw Error(`Source archive does not include symlinks: ${rel}`);
  if (FORBIDDEN.test(rel)) throw Error(`Refusing to archive ${rel}: dependencies, deploy state and secrets stay out`);
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(full)).sort()) await walk(root, rel + '/' + name, files);
  } else if (!GENERATED.has(rel)) files.push(rel);
}

/**
 * Collect the archive file list, checking every required path first so a missing
 * file produces one clear error instead of a subtly incomplete tarball.
 */
export async function collectSources(root = '.') {
  const missing = [];
  for (const rel of [...SOURCES, ...REQUIRED_PUBLIC_SOURCES]) {
    try {
      await fs.lstat(join(root, rel));
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length) throw Error(`Source archive is missing required paths: ${missing.join(', ')}`);
  const files = [];
  for (const rel of SOURCES) await walk(root, rel, files);
  return files.sort();
}

function header(name, size) {
  const out = Buffer.alloc(512);
  let leaf = name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/');
    prefix = name.slice(0, cut);
    leaf = name.slice(cut + 1);
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(leaf) > 100) throw Error(`Archive path too long: ${name}`);
  }
  const oct = (n, size) => n.toString(8).padStart(size - 1, '0') + '\0';
  out.write(leaf, 0, 100);
  out.write(oct(0o644, 8), 100);
  out.write(oct(0, 8), 108);
  out.write(oct(0, 8), 116);
  out.write(oct(size, 12), 124);
  out.write(oct(0, 12), 136);
  out.fill(32, 148, 156);
  out.write('0', 156);
  out.write('ustar\0', 257);
  out.write('00', 263);
  out.write(prefix, 345, 155);
  let sum = 0;
  for (const byte of out) sum += byte;
  out.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return out;
}

/** Uncompressed tar → entry names, used by the acceptance tests. */
export function tarEntryNames(tar) {
  const names = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const field = (start, length) => block.subarray(start, start + length).toString('latin1').replace(/\0.*$/, '');
    const name = field(345, 155) ? field(345, 155) + '/' + field(0, 100) : field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    names.push({name, size});
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

/** Write public/source.tar.gz from the repository sources. Returns the entry count. */
export async function buildSourceArchive({root = '.', out = join(root, 'public/source.tar.gz')} = {}) {
  const files = await collectSources(root);
  const blocks = [];
  for (const rel of files) {
    const body = await fs.readFile(join(root, rel));
    blocks.push(header(rel.replaceAll('\\', '/'), body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  await fs.mkdir(path.dirname(out), {recursive: true});
  await fs.writeFile(out, gzipSync(Buffer.concat(blocks), {level: 9}));
  console.log(`Packaged ${files.length} corresponding source files (no credentials or generated bundles)`);
  return files.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildSourceArchive();
