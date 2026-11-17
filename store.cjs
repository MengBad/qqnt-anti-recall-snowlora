'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 替代上游的 level-party：单文件 JSON，避免 SnowLora 插件携带原生依赖。
class RecalledStore {
  constructor(dataDir, output = () => {}) {
    this.file = path.join(dataDir, 'recalled-messages.json');
    this.output = output;
    this.records = new Map();
    this.enabled = false;
    this.loaded = false;
  }

  setEnabled(value) {
    const enabled = Boolean(value);
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this._load();
  }

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, record] of Object.entries(raw)) {
          if (record && typeof record === 'object' && record.msg) this.records.set(String(id), record);
        }
      }
      this.output('[info][store] loaded', { records: this.records.size, file: this.file });
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.output('[warn][store] load-failed', { error: error.message, code: error.code });
    }
  }

  get(id) {
    this._load();
    return this.records.get(String(id)) || null;
  }

  put(record) {
    if (!record || record.id == null) return false;
    this._load();
    const id = String(record.id);
    if (this.records.has(id)) return false;
    this.records.set(id, { id, sender: record.sender || '', msg: record.msg });
    if (this.enabled) this.flush();
    return true;
  }

  clear() {
    this.records.clear();
    this.flush();
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records)), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.output('[warn][store] flush-failed', { error: error.message });
    }
  }

  get size() { this._load(); return this.records.size; }
  ids() { this._load(); return [...this.records.keys()]; }
}

module.exports = { RecalledStore };