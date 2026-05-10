/**
 * 从 GitHub Release 同步构建产物到腾讯云 COS
 * 用法：node scripts/build/sync-from-github-to-cos.js --version=1.0.12
 */

require('dotenv').config();

const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const COS = require('cos-nodejs-sdk-v5');
const fs = require('fs');
const path = require('path');

const PROXY_URL = process.env.PROXY_URL || null;
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

const CONFIG = {
  owner: 'huhudalaohu',
  repo: 'DesktopSecretary',
  bucket: 'ds-update-1420931574',
  region: 'ap-guangzhou',
};

function _downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(destPath);

    const options = { headers: { 'User-Agent': 'DesktopSecretary-Sync' } };
    if (proxyAgent) options.agent = proxyAgent;

    client.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        console.log('[Sync] 跟随重定向: ' + res.headers.location);
        _downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('下载失败: ' + res.statusCode));
        return;
      }

      const totalSize = parseInt(res.headers['content-length'], 10) || 0;
      let downloaded = 0;
      let lastPercent = -1;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalSize > 0) {
          const percent = Math.floor((downloaded / totalSize) * 100);
          if (percent !== lastPercent) {
            process.stdout.write('\r[Sync] 下载进度: ' + percent + '% (' + (downloaded / 1024 / 1024).toFixed(1) + 'MB / ' + (totalSize / 1024 / 1024).toFixed(1) + 'MB)');
            lastPercent = percent;
          }
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        process.stdout.write('\n');
        file.close();
        resolve();
      });
    }).on('error', reject);
  });
}

async function downloadFile(url, destPath) {
  const MAX_RETRIES = 3;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      if (i > 0) {
        console.log('[Sync] 第 ' + (i + 1) + ' 次重试下载...');
      }
      await _downloadFile(url, destPath);
      return;
    } catch (err) {
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      if (i === MAX_RETRIES - 1) {
        throw new Error('下载失败（已重试 ' + MAX_RETRIES + ' 次）: ' + err.message);
      }
      console.log('[Sync] 下载出错，3秒后重试: ' + err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
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

function checkCosFileExists(cos, key) {
  return new Promise((resolve) => {
    cos.headObject({
      Bucket: CONFIG.bucket,
      Region: CONFIG.region,
      Key: key,
    }, (err, data) => {
      if (err) {
        if (err.statusCode === 404) {
          resolve(false);
        } else {
          console.log('[Sync] 检查 COS 文件状态异常: ' + err.message);
          resolve(false);
        }
      } else {
        resolve(true);
      }
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
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const apiUrl = 'https://api.github.com/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/releases/tags/v' + version;
    console.log('[Sync] 获取 Release: ' + apiUrl);

    const release = await new Promise((resolve, reject) => {
      const apiOptions = { headers: { 'User-Agent': 'DesktopSecretary-Sync' } };
      if (proxyAgent) apiOptions.agent = proxyAgent;
      https.get(apiUrl, apiOptions, (res) => {
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

    if (release.message) {
      throw new Error('GitHub API 错误: ' + release.message + (release.documentation_url ? ' (' + release.documentation_url + ')' : ''));
    }

    const assets = release.assets || [];
    console.log('[Sync] Release 资产数: ' + assets.length);

    if (assets.length === 0) {
      throw new Error('该 Release 没有上传任何构建产物，请确认 GitHub Release 页面已有附件。');
    }

    const files = assets.filter(function(a) {
      return a.name.endsWith('.exe') ||
             a.name.endsWith('.exe.blockmap') ||
             a.name.endsWith('.zip') ||
             a.name.endsWith('.dmg') ||
             a.name === 'latest-mac.yml' ||
             a.name === 'latest.yml';
    });

    console.log('[Sync] 需要同步 ' + files.length + ' 个文件');

    for (const file of files) {
      let cosKey;
      if (file.name === 'latest.yml') cosKey = 'updates/win/latest.yml';
      else if (file.name === 'latest-mac.yml') cosKey = 'updates/mac/latest-mac.yml';
      else if (file.name.endsWith('.exe') || file.name.endsWith('.exe.blockmap')) cosKey = 'updates/win/' + file.name;
      else cosKey = 'updates/mac/' + file.name;

      // yml 元数据每次发版必须覆盖（文件名不变但内容是新版）
      const isMetaFile = file.name === 'latest.yml' || file.name === 'latest-mac.yml';
      if (!isMetaFile) {
        const exists = await checkCosFileExists(cos, cosKey);
        if (exists) {
          console.log('[Sync] 跳过（已存在）: ' + cosKey);
          continue;
        }
      }

      const localPath = path.join(tmpDir, file.name);
      console.log('[Sync] 下载: ' + file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + 'MB)');
      await downloadFile(file.browser_download_url, localPath);

      console.log('[Sync] 上传: ' + cosKey);
      await uploadToCos(cos, cosKey, localPath);

      fs.unlinkSync(localPath);
      console.log('[Sync] 完成: ' + file.name);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[Sync] 全部完成!');

  } catch (err) {
    console.error('[Sync] 失败:', err.message);
    process.exit(1);
  }
}

main();
