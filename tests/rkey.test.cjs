'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RkeyManager } = require('../rkey-manager.cjs');
const { ImgDownloader } = require('../img-downloader.cjs');

test('rkey 过期才刷新、失败保留旧值', async () => {
  let calls = 0;
  const manager = new RkeyManager('https://example.invalid/rkey', {
    fetch: async () => {
      calls++;
      return { ok: true, json: async () => ({ group_rkey: 'G', private_rkey: 'P', expired_time: Date.now() / 1000 + 3600 }) };
    }
  });
  const a = await manager.getRkey();
  const b = await manager.getRkey();
  assert.equal(calls, 1);
  assert.equal(a.group_rkey, 'G');
  assert.equal(b.private_rkey, 'P');
  const broken = new RkeyManager('x', { fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(await broken.getRkey(), { group_rkey: '', private_rkey: '', expired_time: 0 });
});

test('图片 URL：老图 / md5 / 新图 rkey', async () => {
  const downloader = new ImgDownloader({
    rkeyManager: { getRkey: async () => ({ group_rkey: 'GRP', private_rkey: 'PRIV' }) },
    output: () => {}
  });
  assert.equal(await downloader.getImageUrl({ originImageUrl: '/gchatpic_new/0/0-0-ABC/0' }),
    'https://gchat.qpic.cn/gchatpic_new/0/0-0-ABC/0');
  assert.equal(await downloader.getImageUrl({ md5HexStr: 'abcdef' }),
    'https://gchat.qpic.cn/gchatpic_new/0/0-0-ABCDEF/0');
  const groupUrl = await downloader.getImageUrl({ originImageUrl: '/download?appid=1407&fileid=x' });
  assert.match(groupUrl, /multimedia\.nt\.qq\.com\.cn/);
  assert.match(groupUrl, /rkey=GRP/);
  const privUrl = await downloader.getImageUrl({ originImageUrl: '/download?appid=1406&fileid=x' });
  assert.match(privUrl, /rkey=PRIV/);
  const withRkey = await downloader.getImageUrl({ originImageUrl: '/download?appid=1407&rkey=OLD' });
  assert.match(withRkey, /rkey=OLD/);
  assert.equal(await downloader.getImageUrl(null), '');
});
