/**
 * 一次性修复脚本：为 1.0.12 重新生成正确的 latest-mac.yml 并上传到 COS
 *
 * 背景：1.0.12 通过老的 GitHub Action 链路发布，未上传 latest-mac.yml，
 *      导致 COS 上的 latest-mac.yml 还停留在 1.0.8，mac 客户端检测不到更新。
 *
 * 流程：
 *   1. 从 COS 流式下载 mac 4 个文件，计算 sha512 (base64) 和 size
 *   2. 生成 latest-mac.yml
 *   3. 上传覆盖 COS 上 updates/mac/latest-mac.yml
 *
 * 用法：
 *   node scripts/build/fix-mac-yml.js                   # 实际执行
 *   node scripts/build/fix-mac-yml.js --dry-run         # 只生成 yml 内容并打印，不上传
 */

require('dotenv').config();

const https = require('https');
const crypto = require('crypto');
const COS = require('cos-nodejs-sdk-v5');

const BUCKET = 'ds-update-1420931574';
const REGION = 'ap-guangzhou';
const BASE_URL = `https://${BUCKET}.cos.${REGION}.myqcloud.com`;
const VERSION = '1.0.12';

const isDryRun = process.argv.includes('--dry-run');

// 四个 mac 文件，顺序与之前 latest-mac.yml 中一致
const MAC_FILES = [
  `DesktopSecretary-${VERSION}-mac-arm64.zip`,
  `DesktopSecretary-${VERSION}-mac-x64.zip`,
  `DesktopSecretary-${VERSION}-arm64.dmg`,
  `DesktopSecretary-${VERSION}-x64.dmg`,
];

function hashRemoteFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return hashRemoteFile(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`下载失败 ${url}: ${res.statusCode}`));
      }

      const totalSize = parseInt(res.headers['content-length'], 10) || 0;
      const hash = crypto.createHash('sha512');
      let downloaded = 0;
      let lastPercent = -1;

      res.on('data', (chunk) => {
        hash.update(chunk);
        downloaded += chunk.length;
        if (totalSize > 0) {
          const percent = Math.floor((downloaded / totalSize) * 100);
          if (percent !== lastPercent && percent % 5 === 0) {
            process.stdout.write(`\r  ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(totalSize / 1024 / 1024).toFixed(1)}MB)`);
            lastPercent = percent;
          }
        }
      });
      res.on('end', () => {
        process.stdout.write('\n');
        resolve({ sha512: hash.digest('base64'), size: downloaded });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function uploadYml(cos, key, content) {
  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: BUCKET,
        Region: REGION,
        Key: key,
        Body: Buffer.from(content, 'utf8'),
      },
      (err, data) => {
        if (err) reject(err);
        else resolve(data);
      }
    );
  });
}

async function main() {
  console.log(`[FixMacYml] 开始修复 latest-mac.yml (v${VERSION})${isDryRun ? ' [dry-run]' : ''}`);

  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error('未找到 TENCENT_SECRET_ID / TENCENT_SECRET_KEY');
  }
  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

  const results = [];
  for (const name of MAC_FILES) {
    const url = `${BASE_URL}/updates/mac/${name}`;
    console.log(`[FixMacYml] 计算 ${name}`);
    const { sha512, size } = await hashRemoteFile(url);
    console.log(`  sha512: ${sha512.substring(0, 32)}...  size: ${size}`);
    results.push({ name, sha512, size });
  }

  // 主分发包：mac 自动更新走 zip，arm64 优先（与之前 1.0.8 yml 保持一致）
  const main = results.find((r) => r.name.endsWith('mac-arm64.zip'));
  if (!main) throw new Error('未找到 mac-arm64.zip');

  const filesYaml = results
    .map((r) => `  - url: ${r.name}\n    sha512: ${r.sha512}\n    size: ${r.size}`)
    .join('\n');

  const releaseDate = new Date().toISOString();
  const yml =
    `version: ${VERSION}\n` +
    `files:\n${filesYaml}\n` +
    `path: ${main.name}\n` +
    `sha512: ${main.sha512}\n` +
    `releaseDate: '${releaseDate}'\n`;

  console.log('\n[FixMacYml] 生成的 latest-mac.yml 内容:');
  console.log('--------------------------------');
  console.log(yml);
  console.log('--------------------------------');

  if (isDryRun) {
    console.log('[FixMacYml] [dry-run] 跳过上传');
    return;
  }

  console.log('[FixMacYml] 上传到 COS: updates/mac/latest-mac.yml');
  await uploadYml(cos, 'updates/mac/latest-mac.yml', yml);
  console.log('[FixMacYml] 完成！1.0.12 mac 客户端现在应该能检测到新版本了。');
  console.log(`[FixMacYml] 验证: curl ${BASE_URL}/updates/mac/latest-mac.yml`);
}

main().catch((err) => {
  console.error(`[FixMacYml] 失败: ${err.message}`);
  process.exit(1);
});
