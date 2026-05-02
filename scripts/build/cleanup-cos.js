/**
 * COS 清理脚本 — 删除 updates/ 根目录下错误残留的 Windows 安装包和 latest.yml
 *
 * 用法：
 *   node scripts/build/cleanup-cos.js --dry-run    # 预览将要删除的文件
 *   node scripts/build/cleanup-cos.js              # 执行删除
 */

const fs = require('fs');
const path = require('path');
const COS = require('cos-nodejs-sdk-v5');

const BUCKET = 'ds-update-1420931574';
const REGION = 'ap-guangzhou';

const KEYS_TO_DELETE = [
  'updates/latest.yml',
  'updates/DesktopSecretary Setup 1.0.6.exe',
  'updates/DesktopSecretary Setup 1.0.6.exe.blockmap',
  'updates/DesktopSecretary Setup 1.0.7.exe',
  'updates/DesktopSecretary Setup 1.0.7.exe.blockmap',
];

function getCredentials() {
  const envId = process.env.TENCENT_SECRET_ID;
  const envKey = process.env.TENCENT_SECRET_KEY;
  if (envId && envKey) {
    return { secretId: envId, secretKey: envKey };
  }

  const configPath = path.join(__dirname, '..', '..', 'config', 'publish-config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.secretId && config.secretKey) {
      return { secretId: config.secretId, secretKey: config.secretKey };
    }
  }

  throw new Error(
    '未找到腾讯云密钥，请配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY 或 config/publish-config.json'
  );
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const { secretId, secretKey } = getCredentials();
  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

  console.log(`[Cleanup] 模式: ${isDryRun ? '预览 (dry-run)' : '执行删除'}`);
  console.log(`[Cleanup] 将要处理的 Key 数量: ${KEYS_TO_DELETE.length}\n`);

  // 先验证这些 Key 是否存在
  const existingKeys = [];
  for (const key of KEYS_TO_DELETE) {
    try {
      await new Promise((resolve, reject) => {
        cos.headObject({ Bucket: BUCKET, Region: REGION, Key: key }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
      existingKeys.push(key);
      console.log(`  [存在] ${key}`);
    } catch {
      console.log(`  [不存在/跳过] ${key}`);
    }
  }

  if (existingKeys.length === 0) {
    console.log('\n[Cleanup] 没有需要删除的文件。');
    return;
  }

  console.log(`\n[Cleanup] 实际存在且将要删除的 Key 数量: ${existingKeys.length}`);

  if (isDryRun) {
    console.log('[Cleanup] dry-run 模式，未执行删除。');
    return;
  }

  // 执行删除
  console.log('[Cleanup] 开始删除...');
  for (const key of existingKeys) {
    try {
      await new Promise((resolve, reject) => {
        cos.deleteObject({ Bucket: BUCKET, Region: REGION, Key: key }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log(`  [已删除] ${key}`);
    } catch (err) {
      console.error(`  [删除失败] ${key}: ${err.message}`);
    }
  }

  console.log('\n[Cleanup] 清理完成。');
}

main().catch((err) => {
  console.error(`[Cleanup] 失败: ${err.message}`);
  process.exit(1);
});
