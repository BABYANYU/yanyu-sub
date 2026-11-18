// Build: regenerate the AGPL source archive, bundle the browser converter, turn the
// whole public/ directory into the Worker asset map, then bundle the Worker.
//
// The asset map is derived from the directory tree instead of a hardcoded list: a
// new file in public/ is served automatically, and a file whose content type is
// unknown fails the build instead of shipping silently mislabelled. Anything that
// is referenced by index.html but absent from public/ still fails a test.
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {buildSourceArchive, REQUIRED_PUBLIC_SOURCES} from './source-archive.mjs';

export const PUBLIC_DIR = 'public';
export const SOURCE_ARCHIVE = 'source.tar.gz';
// Built by this script (converter.js) or by source-archive.mjs (source.tar.gz).
export const GENERATED_PUBLIC = new Set(['converter.js', SOURCE_ARCHIVE]);
// Files the Worker must always be able to serve; a missing one is fatal.
export const REQUIRED_PUBLIC = ['index.html', 'app.js', 'style.css', 'theme.js', 'converter.js'];

const TEXT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};
const BINARY_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** Content type (and delivery encoding) for one served file, or null if unknown. */
export function assetTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_TYPES[ext]) return {type: TEXT_TYPES[ext], base64: false};
  if (BINARY_TYPES[ext]) return {type: BINARY_TYPES[ext], base64: true};
  return null;
}

async function walk(dir, prefix = '') {
  const names = (await fs.readdir(dir)).sort();
  const out = [];
  for (const name of names) {
    const full = path.join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    const stat = await fs.stat(full);
    if (stat.isDirectory()) out.push(...(await walk(full, rel)));
    else out.push(rel);
  }
  return out;
}

/**
 * Turn a public/ directory into the Worker asset map. Source archives are handled
 * separately (binary gzip, always present); every other file is mapped, and an
 * extension with no declared content type is a build error.
 */
export async function collectAssets(dir = PUBLIC_DIR) {
  const files = await walk(dir);
  const assets = {};
  for (const rel of files) {
    if (rel === SOURCE_ARCHIVE) continue;
    const kind = assetTypeFor(rel);
    if (!kind) {
      throw Error(`public/${rel} has no declared content type; add it to build.mjs so it cannot 404 or ship mislabelled`);
    }
    const body = await fs.readFile(path.join(dir, rel));
    assets['/' + rel] = kind.base64
      ? {body: body.toString('base64'), type: kind.type, base64: true}
      : {body: body.toString('utf8'), type: kind.type};
  }
  const archive = path.join(dir, SOURCE_ARCHIVE);
  if (!existsSync(archive)) throw Error(`public/${SOURCE_ARCHIVE} is missing; the AGPL source archive must ship with the site`);
  assets['/' + SOURCE_ARCHIVE] = {body: (await fs.readFile(archive)).toString('base64'), type: 'application/gzip', base64: true};
  for (const name of REQUIRED_PUBLIC) {
    if (!assets['/' + name]) throw Error(`public/${name} is required by the page but was not mapped`);
  }
  return assets;
}

export async function main() {
  await buildSourceArchive();
  const revision = process.env.GITHUB_SHA || process.env.BUILD_REVISION || 'local';
  await fs.writeFile('src/build-info.generated.js', 'export default ' + JSON.stringify({revision, version: '1.0.0'}) + ';');

  // The page loads theme.js as a classic script and app.js as a module; converter.js
  // is bundled first because app.js imports it.
  const vendor = path.resolve('vendor/sub-store');
  const alias = {
    name: 'isolated-vendor',
    setup(b) {
      b.onResolve({filter: /^@\//}, (a) => {
        let p = a.path === '@/core/app' ? path.resolve('src/app-shim.js') : path.join(vendor, a.path.slice(2));
        if (!p.endsWith('.js')) p = existsSync(p + '.js') ? p + '.js' : path.join(p, 'index.js');
        return {path: p};
      });
    },
  };
  await build({entryPoints: ['src/converter.js'], bundle: true, format: 'esm', platform: 'browser', outfile: 'public/converter.js', minify: true, target: 'es2022', plugins: [alias], logLevel: 'warning'});

  const assets = await collectAssets(PUBLIC_DIR);
  await fs.writeFile('src/assets.generated.js', 'export default ' + JSON.stringify(assets) + ';');

  await build({entryPoints: ['src/worker.js'], bundle: true, format: 'esm', platform: 'browser', outfile: 'dist/worker.js', minify: true, target: 'es2022', logLevel: 'warning'});

  const text = await fs.readFile('public/converter.js', 'utf8');
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) throw Error('Runtime dynamic code remains');
  console.log(`Built browser converter and Worker; mapped ${Object.keys(assets).length} assets from ${PUBLIC_DIR}/`);
  console.log(`Archive must keep these public sources: ${REQUIRED_PUBLIC_SOURCES.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
