'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const SCRIPTS = [
  'renderer/host.js',
  'renderer/upstream.js',
  'renderer/overlay.js',
  'renderer/settings.js',
  'renderer/settings-page.js'
];
const STYLES = ['assets/anti-recall.css'];
const NAMES = [...SCRIPTS, ...STYLES];
let cache = null;

async function loadResources(root) {
  root = path.resolve(root);
  const stats = await Promise.all(NAMES.map(async name => {
    const st = await fs.stat(path.join(root, name), { bigint: true });
    return [name, String(st.size) + ':' + String(st.mtimeNs)];
  }));
  const signature = JSON.stringify(stats);
  if (cache && cache.root === root && cache.signature === signature) return cache.value;
  const pairs = await Promise.all(NAMES.map(async name =>
    [name, await fs.readFile(path.join(root, name), 'utf8')]
  ));
  const text = Object.fromEntries(pairs);
  const value = {
    source: SCRIPTS.map(name => '\n// ===== ' + name + ' =====\n' + text[name]).join('\n'),
    css: STYLES.map(name => text[name]).join('\n')
  };
  cache = { root, signature, value };
  return value;
}

module.exports = { loadResources, SCRIPTS, STYLES };