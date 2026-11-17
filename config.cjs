'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  mainColor: '#ff6d6d',
  saveDb: false,
  enableShadow: true,
  enableTip: true,
  isAntiRecallSelfMsg: false,
  maxMsgSaveLimit: 10000,
  deleteMsgCountPerTime: 500,
  debugIpc: false,
  debugLog: false
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalize(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const color = typeof src.mainColor === 'string' && /^#[0-9a-f]{6}$/i.test(src.mainColor.trim())
    ? src.mainColor.trim().toLowerCase()
    : DEFAULTS.mainColor;
  return {
    mainColor: color,
    saveDb: typeof src.saveDb === 'boolean' ? src.saveDb : DEFAULTS.saveDb,
    enableShadow: typeof src.enableShadow === 'boolean' ? src.enableShadow : DEFAULTS.enableShadow,
    enableTip: typeof src.enableTip === 'boolean' ? src.enableTip : DEFAULTS.enableTip,
    isAntiRecallSelfMsg: typeof src.isAntiRecallSelfMsg === 'boolean'
      ? src.isAntiRecallSelfMsg : DEFAULTS.isAntiRecallSelfMsg,
    maxMsgSaveLimit: clampInt(src.maxMsgSaveLimit, 1, 99999999, DEFAULTS.maxMsgSaveLimit),
    deleteMsgCountPerTime: clampInt(src.deleteMsgCountPerTime, 1, 99999, DEFAULTS.deleteMsgCountPerTime),
    debugIpc: typeof src.debugIpc === 'boolean' ? src.debugIpc : DEFAULTS.debugIpc,
    debugLog: typeof src.debugLog === 'boolean' ? src.debugLog : DEFAULTS.debugLog
  };
}

function createConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let current = { ...DEFAULTS };
  try {
    current = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error && error.code !== 'ENOENT') console.warn('[Anti-Recall] 配置读取失败，使用默认值：', error.message);
  }
  function save(next) {
    current = normalize({ ...current, ...(next && typeof next === 'object' ? next : {}) });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ...current };
  }
  if (!fs.existsSync(file)) save(current);
  return {
    file,
    defaults: DEFAULTS,
    normalize,
    get: () => ({ ...current }),
    save
  };
}

module.exports = { DEFAULTS, normalize, createConfig };