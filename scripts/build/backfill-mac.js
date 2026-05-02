/**
 * mac 历史产物补传脚本
 * 将本地保留的旧版本 mac 构建产物上传到 COS 归档目录
 *
 * 用法：
 *   node scripts/build/backfill-mac.js --dry-run    # 预览
 *   node scripts/build/backfill-mac.js              # 执行上传
 */

const fs = require('fs');
const path = require('path');
const COS = require('cos-nodejs-sdk-v5');

const BUCKET = 'ds-update-1420931574';
const REGION = 'ap-guangzhou';

// 本地产物列表（相对于项目根目录）
const BACKFILL_ITEMS = [
  {
    version: '1.0.5',
    localPath: 'release/DesktopSecretary-1.0.5-mac-arm64.zip',
    remoteKey: 'updates/1.0.5/mac/DesktopSecretary-1.0.5-mac-arm64.zip',
  },
  {
    version: '1.0.5',
    localPath: 'release/DesktopSecretary-1.0.5-mac-x64.zip',
    remoteKey: 'updates/1.0.5/mac/DesktopSecretary-1.0.5-mac-x64.zip',
  },
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

  throw new Error('未找到腾讯云密钥');
}

function uploadFile(cos, key, filePath) {
  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: BUCKET,
        Region: REGION,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentLength: fs.statSync(filePath).size,
      },
      (err, data) => {
        if (err) reject(err);
        else resolve(data);
      }
    );
  });
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const { secretId, secretKey } = getCredentials();
  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

  console.log(`[Backfill] 模式: ${isDryRun ? '预览 (dry-run)' : '执行上传'}\n`);

  const projectRoot = path.join(__dirname, '..', '..');
  const toUpload = [];

  for (const item of BACKFILL_ITEMS) {
    const fullPath = path.join(projectRoot, item.localPath);
    if (!fs.existsSync(fullPath)) {
      console.log(`  [跳过] 本地文件不存在: ${item.localPath}`);
      continue;
    }
    toUpload.push({ ...item, fullPath });
    console.log(`  [待上传] ${item.localPath} → ${item.remoteKey}`);
  }

  if (toUpload.length === 0) {
    console.log('\n[Backfill] 没有可上传的文件。');
    return;
  }

  if (isDryRun) {
    console.log('\n[Backfill] dry-run 模式，未实际上传。');
    return;
  }

  console.log('\n[Backfill] 开始上传...');
  for (const item of toUpload) {
    try {
      await uploadFile(cos, item.remoteKey, item.fullPath);
      console.log(`  [已上传] ${item.remoteKey}`);
    } catch (err) {
      console.error(`  [上传失败] ${item.remoteKey}: ${err.message}`);
    }
  }

  console.log('\n[Backfill] 补传完成。');
}

main().catch((err) => {
  console.error(`[Backfill] 失败: ${err.message}`);
  process.exit(1);
});
