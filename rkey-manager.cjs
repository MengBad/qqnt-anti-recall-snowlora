'use strict';

// 摘自 LLOneBot / 上游 rkeyManager.js，改为可注入 fetch 便于离线测试。
class RkeyManager {
  constructor(serverUrl, options = {}) {
    this.serverUrl = serverUrl;
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.rkeyData = { group_rkey: '', private_rkey: '', expired_time: 0 };
  }

  isExpired() {
    return Date.now() / 1000 > this.rkeyData.expired_time;
  }

  async getRkey() {
    if (this.isExpired()) {
      try {
        this.rkeyData = await this.fetchServerRkey();
      } catch (error) {
        console.log('[Anti-Recall] 获取 rkey 失败', error?.message || error);
      }
    }
    return this.rkeyData;
  }

  async fetchServerRkey() {
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch 不可用');
    const response = await this.fetchImpl(this.serverUrl);
    if (!response || !response.ok) throw new Error((response && response.statusText) || 'rkey 请求失败');
    const data = await response.json();
    if (!data || typeof data !== 'object') throw new Error('rkey 响应格式错误');
    return {
      group_rkey: data.group_rkey || '',
      private_rkey: data.private_rkey || '',
      expired_time: Number(data.expired_time) || 0
    };
  }
}

module.exports = { RkeyManager };
