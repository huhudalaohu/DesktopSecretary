/**
 * 从 GitHub Release 同步构建产物到腾讯云 COS
 * 用法：node scripts/build/sync-from-github-to-cos.js --version=1.0.12
 */

const https = require('https');
const http = require('http');
const COS = require('cos-nodejs-sdk-v5');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  owner: 'huhudalaohu',
  repo: 'DesktopSecretary',
  bucket: 'ds-update-1420931574',
  region: 'ap-guangzhou',
};

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(destPath);

    client.get(url, { headers: { 'User-Agent': 'DesktopSecretary-Sync' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        console.log('[Sync] 跟随重定向: ' + res.headers.location);
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('下载失败: ' + res.statusCode));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

function uploadToCos(cos, key, filePath) {
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: CONFIG.bucket,
      Region: CONFIG.region,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentLength: fs.statSync(filePath).size,
    }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function main() {
  const versionArg = process.argv.find(arg => arg.startsWith('--version='));
  const version = versionArg ? versionArg.split('=')[1] : null;

  if (!version) {
    console.error('用法: node sync-from-github-to-cos.js --version=1.0.12');
    process.exit(1);
  }

  console.log('[Sync] 开始同步 v' + version + ' 从 GitHub Release 到 COS');

  const cos = new COS({
    SecretId: process.env.TENCENT_SECRET_ID,
    SecretKey: process.env.TENCENT_SECRET_KEY,
  });

  const tmpDir = path.join(__dirname, '..', '..', 'release', 'sync-tmp-' + version);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const apiUrl = 'https://api.github.com/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/releases/tags/v' + version;
    console.log('[Sync] 获取 Release: ' + apiUrl);

    const release = await new Promise((resolve, reject) => {
      https.get(apiUrl, { headers: { 'User-Agent': 'DesktopSecretary-Sync' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('JSON解析失败: ' + data.substring(0, 200)));
          }
        });
      }).on('error', reject);
    });

    const assets = release.assets || [];
    console.log('[Sync] Release 资产数: ' + assets.length);

    const files = assets.filter(function(a) {
      return a.name.endsWith('.exe') ||
             a.name.endsWith('.zip') ||
             a.name.endsWith('.dmg') ||
             a.name === 'latest-mac.yml' ||
             a.name === 'latest.yml';
    });

    console.log('[Sync] 需要同步 ' + files.length + ' 个文件');

    for (const file of files) {
      const localPath = path.join(tmpDir, file.name);
      console.log('[Sync] 下载: ' + file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + 'MB)');
      await downloadFile(file.browser_download_url, localPath);

      let cosKey;
      if (file.name === 'latest.yml') cosKey = 'updates/win/latest.yml';
      else if (file.name === 'latest-mac.yml') cosKey = 'updates/mac/latest-mac.yml';
      else if (file.name.endsWith('.exe')) cosKey = 'updates/win/' + file.name;
      else cosKey = 'updates/mac/' + file.name;

      console.log('[Sync] 上传: ' + cosKey);
      await uploadToCos(cos, cosKey, localPath);

      fs.unlinkSync(localPath);
      console.log('[Sync] 完成: ' + file.name);
    }

    fs.rmdirSync(tmpDir);
    console.log('[Sync] 全部完成!');

  } catch (err) {
    console.error('[Sync] 失败:', err.message);
    process.exit(1);
  }
}

main();
