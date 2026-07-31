/**
 * 把本地目录(release/sync-tmp-<version>/)里的构建产物上传到腾讯云 COS
 * 用途:GitHub 直连/代理在本机 node 下不稳定时,先用 curl 下载资产,再跑本脚本上传
 * 用法:node scripts/build/upload-local-to-cos.js --version=1.0.19
 */

require('dotenv').config();

const COS = require('cos-nodejs-sdk-v5');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  bucket: 'ds-update-1420931574',
  region: 'ap-guangzhou',
};

const version = (process.argv.find(a => a.startsWith('--version=')) || '').split('=')[1];
if (!version) {
  console.error('用法: node scripts/build/upload-local-to-cos.js --version=x.y.z');
  process.exit(2);
}

function cosKeyFor(name) {
  if (name === 'latest.yml') return 'updates/win/latest.yml';
  if (name === 'latest-mac.yml') return 'updates/mac/latest-mac.yml';
  if (name.endsWith('.exe') || name.endsWith('.exe.blockmap')) return 'updates/win/' + name;
  return 'updates/mac/' + name;
}

function checkCosFileExists(cos, key) {
  return new Promise((resolve) => {
    cos.headObject({ Bucket: CONFIG.bucket, Region: CONFIG.region, Key: key }, (err) => {
      resolve(!err);
    });
  });
}

function uploadToCos(cos, key, filePath) {
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: CONFIG.bucket,
      Region: CONFIG.region,
      Key: key,
      Body: fs.createReadStream(filePath),
    }, (err) => (err ? reject(err) : resolve()));
  });
}

(async () => {
  const cos = new COS({
    SecretId: process.env.TENCENT_SECRET_ID,
    SecretKey: process.env.TENCENT_SECRET_KEY,
  });

  const tmpDir = path.join(__dirname, '..', '..', 'release', 'sync-tmp-' + version);
  if (!fs.existsSync(tmpDir)) {
    console.error('[Upload] 目录不存在: ' + tmpDir);
    process.exit(1);
  }

  const files = fs.readdirSync(tmpDir).filter((name) =>
    name.endsWith('.exe') || name.endsWith('.exe.blockmap') ||
    name.endsWith('.zip') || name.endsWith('.dmg') ||
    name === 'latest.yml' || name === 'latest-mac.yml'
  );
  console.log('[Upload] 待上传 ' + files.length + ' 个文件');

  try {
    for (const name of files) {
      const key = cosKeyFor(name);
      const localPath = path.join(tmpDir, name);

      // yml 元数据每次发版必须覆盖(文件名不变但内容是新版)
      const isMetaFile = name === 'latest.yml' || name === 'latest-mac.yml';
      if (!isMetaFile) {
        const exists = await checkCosFileExists(cos, key);
        if (exists) {
          console.log('[Upload] 跳过(已存在): ' + key);
          continue;
        }
      }

      console.log('[Upload] 上传: ' + key + ' (' + (fs.statSync(localPath).size / 1024 / 1024).toFixed(1) + 'MB)');
      await uploadToCos(cos, key, localPath);
      console.log('[Upload] 完成: ' + name);
    }
    console.log('[Upload] 全部完成!');
  } catch (err) {
    console.error('[Upload] 失败:', err.message || err);
    process.exit(1);
  }
})();
