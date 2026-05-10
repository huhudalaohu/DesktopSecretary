/**
 * DesktopSecretary — COS 旧版本归档清理脚本
 *
 * 扫描 updates/{version}/ 归档目录，保留最近 N 个版本，删除其余。
 * 不影响 updates/win/ 和 updates/mac/ 下的最新版本文件。
 *
 * 用法：
 *   node scripts/build/cleanup-cos.js              保留最近 5 个版本，删除其余归档
 *   node scripts/build/cleanup-cos.js --keep=3     保留最近 3 个版本
 *   node scripts/build/cleanup-cos.js --dry-run    预览，不实际删除
 */

require('dotenv').config();

const COS = require('cos-nodejs-sdk-v5');

const BUCKET = 'ds-update-1420931574';
const REGION = 'ap-guangzhou';

// ========== 解析命令行参数 ==========
const isDryRun = process.argv.includes('--dry-run');
const keepArg = process.argv.find((arg) => arg.startsWith('--keep='));
const keepCount = keepArg ? parseInt(keepArg.split('=')[1], 10) : 5;

// ========== Semver 比较 ==========
function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// ========== COS 工具函数 ==========

/**
 * 列出 updates/ 下的版本号归档目录（如 1.0.12、1.0.11）
 * 使用 Delimiter 高效获取，不遍历所有对象
 */
async function listVersionDirs(cos) {
  const versions = [];
  let marker = null;
  while (true) {
    const res = await new Promise((resolve, reject) => {
      cos.getBucket(
        {
          Bucket: BUCKET,
          Region: REGION,
          Prefix: 'updates/',
          Delimiter: '/',
          MaxKeys: 1000,
          Marker: marker,
        },
        (err, data) => {
          if (err) reject(err);
          else resolve(data);
        }
      );
    });

    for (const cp of res.CommonPrefixes || []) {
      const prefix = cp.Prefix;
      // 只匹配版本号目录，排除 win/ mac/
      const match = prefix.match(/^updates\/(\d+\.\d+\.\d+)\/$/);
      if (match) {
        versions.push(match[1]);
      }
    }

    if (!res.IsTruncated) break;
    marker = res.NextMarker;
  }
  return versions;
}

/**
 * 列出指定前缀下的所有对象
 */
async function listObjectsByPrefix(cos, prefix) {
  const keys = [];
  let marker = null;
  while (true) {
    const res = await new Promise((resolve, reject) => {
      cos.getBucket(
        { Bucket: BUCKET, Region: REGION, Prefix: prefix, MaxKeys: 1000, Marker: marker },
        (err, data) => {
          if (err) reject(err);
          else resolve(data);
        }
      );
    });
    for (const obj of res.Contents || []) {
      keys.push(obj.Key);
    }
    if (!res.IsTruncated) break;
    marker = res.NextMarker;
  }
  return keys;
}

async function deleteObject(cos, key) {
  return new Promise((resolve, reject) => {
    cos.deleteObject({ Bucket: BUCKET, Region: REGION, Key: key }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ========== 主流程 ==========
async function main() {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;

  if (!secretId || !secretKey) {
    throw new Error('未找到腾讯云密钥，请配置环境变量 TENCENT_SECRET_ID 和 TENCENT_SECRET_KEY');
  }

  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

  console.log(`[Cleanup] 开始清理 COS 旧版本归档${isDryRun ? ' (dry-run)' : ''}`);
  console.log(`[Cleanup] 保留最近 ${keepCount} 个版本归档`);
  console.log(`[Cleanup] 不影响 updates/win/ 和 updates/mac/ 下的最新版本文件\n`);

  // 获取所有版本号目录
  const versions = (await listVersionDirs(cos)).sort(compareVersion).reverse();
  console.log(`[Cleanup] 发现 ${versions.length} 个版本归档: ${versions.join(', ')}`);

  if (versions.length <= keepCount) {
    console.log('[Cleanup] 版本数量未超过保留上限，无需清理');
    return;
  }

  const versionsToDelete = versions.slice(keepCount);
  console.log(`[Cleanup] 将删除 ${versionsToDelete.length} 个旧版本归档: ${versionsToDelete.join(', ')}`);

  let deletedCount = 0;
  for (const ver of versionsToDelete) {
    const prefix = `updates/${ver}/`;
    const keysToDelete = await listObjectsByPrefix(cos, prefix);

    if (keysToDelete.length === 0) continue;

    console.log(`\n[Cleanup] 版本 ${ver}: ${keysToDelete.length} 个文件`);
    for (const key of keysToDelete) {
      if (isDryRun) {
        console.log(`  [dry-run] 将删除: ${key}`);
      } else {
        await deleteObject(cos, key);
        console.log(`  [已删除] ${key}`);
      }
      deletedCount++;
    }
  }

  console.log('');
  console.log(`[Cleanup] 完成${isDryRun ? ' (dry-run)' : ''}`);
  console.log(`[Cleanup] 共${isDryRun ? '预览' : '删除'} ${deletedCount} 个文件，保留 ${Math.min(versions.length, keepCount)} 个版本归档`);
}

main().catch((err) => {
  console.error(`[Cleanup] 失败: ${err.message}`);
  process.exit(1);
});
