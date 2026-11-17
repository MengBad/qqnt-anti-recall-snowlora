'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// 按 mtime 取最新包，避免字典序挑到旧的 snowlora.1。
const file = fs.readdirSync(path.join(root, 'dist'))
  .filter(n => n.endsWith('.zip'))
  .sort((a, b) => fs.statSync(path.join(root, 'dist', b)).mtimeMs - fs.statSync(path.join(root, 'dist', a)).mtimeMs)[0];
const buf = fs.readFileSync(path.join(root, 'dist', file));
// 解析本地文件头序列
const names = [];
let off = 0;
while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const compSize = buf.readUInt32LE(off + 18);
  const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
  names.push({ name, bytes: compSize });
  off += 30 + nameLen + extraLen + compSize;
}
console.log('ZIP:', file, buf.length, 'bytes');
for (const n of names) console.log('  -', n.name, n.bytes);
console.log('entries:', names.length);
// 扫描运行时残留
const runtime = ['load.js','config.cjs','store.cjs','rkey-manager.cjs','img-downloader.cjs','recall-intercept.cjs','resources.cjs','renderer/host.js','renderer/overlay.js','renderer/settings.js','renderer/upstream.js','tools/pack.cjs','tools/zip.cjs','tools/build-renderer.cjs'];
const bad = /LiteLoader\.path|require\(["']level-party|contextBridge|ipcRenderer|ipcMain\.handle/;
for (const r of runtime) {
  const src = fs.readFileSync(path.join(root, r), 'utf8');
  for (const [i, line] of src.split('\n').entries()) {
    if (bad.test(line) && !/上游|残留|替代|不再/.test(line)) console.log('RESIDUE', r + ':' + (i+1), line.trim());
  }
}
console.log('runtime residue scan done');