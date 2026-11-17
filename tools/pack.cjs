'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildZip } = require('./zip.cjs');

const root = path.resolve(__dirname, '..');
const INCLUDE = [
  'snowlora-plugin.json', 'package.json', 'load.js',
  'config.cjs', 'logger.cjs', 'store.cjs', 'rkey-manager.cjs', 'img-downloader.cjs',
  'recall-intercept.cjs', 'resources.cjs',
  'renderer/host.js', 'renderer/overlay.js', 'renderer/upstream.js', 'renderer/settings.js',
  'renderer/settings-page.js',
  'assets/anti-recall.css',
  'README.md', 'PORTING-NOTES.md', 'LICENSE',
  'upstream/renderer.js'
];

function collect() {
  return INCLUDE.map(name => {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) throw new Error('打包缺少文件：' + name);
    return { name, data: fs.readFileSync(file) };
  });
}

function pack(outDir) {
  const dir = outDir || path.join(root, 'dist');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'snowlora-plugin.json'), 'utf8'));
  const out = path.join(dir, manifest.id + '-' + manifest.version + '.zip');
  const zip = buildZip(collect(), { mtime: new Date() });
  fs.writeFileSync(out, zip);
  return { out, bytes: zip.length, entries: INCLUDE.length };
}

if (require.main === module) {
  const result = pack();
  console.log('packed', result.out, result.bytes, 'bytes,', result.entries, 'entries');
}

module.exports = { pack, INCLUDE };