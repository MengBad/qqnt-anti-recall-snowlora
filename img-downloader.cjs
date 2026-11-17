'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { RkeyManager } = require('./rkey-manager.cjs');

const IMAGE_HTTP_HOST = 'https://gchat.qpic.cn';
const IMAGE_HTTP_HOST_NT = 'https://multimedia.nt.qq.com.cn';

class ImgDownloader {
  constructor(options = {}) {
    this.rkeyManager = options.rkeyManager || new RkeyManager('https://llob.linyuchen.net/rkey');
    this.output = options.output || (() => {});
    this.maxRedirects = options.maxRedirects ?? 5;
  }

  async getImageUrl(element) {
    if (!element) return '';
    const url = element.originImageUrl;
    const md5HexStr = element.md5HexStr;
    if (url) {
      let parsed;
      try { parsed = new URL(IMAGE_HTTP_HOST + url); }
      catch { return ''; }
      const appid = parsed.searchParams.get('appid');
      const isNewPic = appid && ['1406', '1407'].includes(appid);
      if (!isNewPic) return IMAGE_HTTP_HOST + url;
      if (parsed.searchParams.get('rkey')) return IMAGE_HTTP_HOST_NT + url;
      const rkeyData = await this.rkeyManager.getRkey();
      const rkey = appid === '1406' ? rkeyData.private_rkey : rkeyData.group_rkey;
      if (!rkey) return '';
      parsed.searchParams.set('rkey', rkey);
      return IMAGE_HTTP_HOST_NT + parsed.pathname + parsed.search;
    }
    if (md5HexStr) return IMAGE_HTTP_HOST + '/gchatpic_new/0/0-0-' + String(md5HexStr).toUpperCase() + '/0';
    this.output('[warn][image] url-miss', { keys: Object.keys(element || {}) });
    return '';
  }

  async downloadPic(msgItem) {
    if (!msgItem || !Array.isArray(msgItem.elements)) return;
    for (const el of msgItem.elements) {
      if (!el || !el.picElement) continue;
      const pic = el.picElement;
      const picUrl = await this.getImageUrl(pic);
      if (!picUrl || !pic.sourcePath) continue;
      let needDownload = false;
      try { needDownload = !fs.existsSync(pic.sourcePath) || fs.statSync(pic.sourcePath).size <= 100; }
      catch { needDownload = true; }
      if (!needDownload) continue;
      let body;
      try { body = await this.request(picUrl); }
      catch (error) { this.output('[warn][image] download-failed', { error: error && error.message, msgId: msgItem && msgItem.msgId }); continue; }
      try { JSON.parse(body.toString('utf8')); this.output('[warn][image] expired', { msgId: msgItem && msgItem.msgId }); continue; }
      catch { /* 二进制图片，继续写入 */ }
      try {
        fs.mkdirSync(path.dirname(pic.sourcePath), { recursive: true });
        fs.writeFileSync(pic.sourcePath, body);
        this.output('[info][image] downloaded', { msgId: msgItem && msgItem.msgId, bytes: body.length });
      } catch (error) { this.output('[warn][image] write-failed', { error: error.message, msgId: msgItem && msgItem.msgId }); }
      if (pic.thumbPath && typeof pic.thumbPath === 'object') {
        pic.thumbPath = new Map([[0, pic.sourcePath], [198, pic.sourcePath], [720, pic.sourcePath]]);
      }
    }
  }

  request(url, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > this.maxRedirects) return reject(new Error('重定向次数过多'));
      let protocol;
      try { protocol = new URL(url).protocol === 'https:' ? https : http; }
      catch (error) { return reject(error); }
      const req = protocol.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode <= 399 && res.headers.location) {
          res.resume();
          return resolve(this.request(new URL(res.headers.location, url).href, redirects + 1));
        }
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('error', reject);
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.setTimeout(15000, () => req.destroy(new Error('图片下载超时')));
      req.on('error', reject);
    });
  }
}

module.exports = { ImgDownloader };