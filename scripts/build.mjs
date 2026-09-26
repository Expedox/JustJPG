// Checks the extension and packs it into dist/justjpg-<version>.zip for upload
// to the Chrome Web Store. No dependencies - needs only Node.js 18+.
//
//   node scripts/build.mjs          (or: npm run build)

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const IGNORE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.git.*|.*~|.*\.swp)$/i;

const errors = [];
const warnings = [];
const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
const exists = (p) => fs.existsSync(path.join(SRC, p));

// ---------------------------------------------------------------- manifest
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) errors.push(`invalid version "${manifest.version}"`);

const referenced = new Set([
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.action?.default_popup,
  manifest.options_page,
  manifest.background?.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
]);
for (const file of referenced) if (file && !exists(file)) errors.push(`manifest references missing file: ${file}`);

if (manifest.default_locale && !exists(`_locales/${manifest.default_locale}/messages.json`)) {
  errors.push(`default_locale "${manifest.default_locale}" has no messages.json`);
}

// __MSG_x__ keys must exist in every locale
const msgKeys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
if (exists('_locales')) {
  for (const locale of fs.readdirSync(path.join(SRC, '_locales'))) {
    const messages = JSON.parse(fs.readFileSync(path.join(SRC, '_locales', locale, 'messages.json'), 'utf8'));
    for (const key of msgKeys) if (!messages[key]) errors.push(`_locales/${locale} is missing "${key}"`);
  }
}

// ---------------------------------------------------------------- files
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full) : [full];
  });
}
const files = walk(SRC)
  .filter((f) => !IGNORE.test(rel(f)))
  .sort();

// scripts and styles referenced from HTML pages must exist
for (const file of files.filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(file, 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    const target = path.join(path.dirname(file), ref);
    if (!fs.existsSync(target)) errors.push(`${rel(file)} references missing file: ${ref}`);
  }
}

// syntax check every script
for (const file of files.filter((f) => /\.(m?js)$/.test(f) && !rel(f).startsWith('lib/libheif/'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    errors.push(`syntax error in ${rel(file)}:\n${e.stderr}`);
  }
}

// ---------------------------------------------------------------- translations
{
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(SRC, 'translations.js'), 'utf8'), { globalThis: sandbox });
  const T = sandbox.JustJPGTranslations;
  const keys = Object.keys(T.en);
  const vars = (v) => (JSON.stringify(v ?? '').match(/\{\w+\}/g) || []).sort().join();
  for (const [code, texts] of Object.entries(T)) {
    const missing = keys.filter((k) => !(k in texts));
    const unknown = Object.keys(texts).filter((k) => !(k in T.en));
    if (missing.length) warnings.push(`translation "${code}" falls back to English for ${missing.length} text(s): ${missing.join(', ')}`);
    if (unknown.length) warnings.push(`translation "${code}" has unknown keys (typo?): ${unknown.join(', ')}`);
    for (const k of keys) {
      if (k in texts && vars(texts[k]) !== vars(T.en[k])) errors.push(`translation "${code}" / "${k}": placeholders differ from English`);
    }
  }
}

// ---------------------------------------------------------------- report
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\nBuild failed with ${errors.length} error(s).`);
  process.exit(1);
}

// ---------------------------------------------------------------- zip
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  // fixed timestamp keeps the zip reproducible: 2024-01-01 00:00
  const dosTime = 0;
  const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += header.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, `justjpg-${manifest.version}.zip`);
const entries = files.map((f) => ({ name: rel(f), data: fs.readFileSync(f) }));
fs.writeFileSync(out, zip(entries));

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`JustJPG ${manifest.version}: ${entries.length} files, ${kb(entries.reduce((a, e) => a + e.data.length, 0))} -> ${path.relative(ROOT, out)} (${kb(fs.statSync(out).size)})`);
