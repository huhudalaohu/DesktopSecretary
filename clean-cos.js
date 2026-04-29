/**
 * DesktopSecretary — COS 清理脚本
 *
 * 按照最新发布规范清理 COS 根目录下的散乱文件：
 *   - 保留 updates/win/、updates/mac/、updates/{version}/ 目录结构
 *   - 删除根目录下的 .exe、.blockmap、latest.yml、update.json 等散乱文件
 *
 * 用法：
 *   node clean-cos.js        (默认预览模式，只打印待删除文件)
 *   node clean-cos.js --exec  (真正执行删除)
 */

const COS = require('cos-nodejs-sdk-v5');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const BUCKET = 'ds-update-1420931574';
const REGION = 'ap-guangzhou';
const PREFIX = 'updates/';

// 允许保留的根目录前缀（符合规范的目录）
const ALLOWED_ROOT_PREFIXES = [
  'updates/win/',
  'updates/mac/',
];

// 允许保留的版本归档目录正则：updates/X.Y.Z/
const ALLOWED_VERSION_DIR = /^updates\/\d+\.\d+\.\d+\//;

// ========== 读取密钥 ==========
function getCredentials() {
  const envId = process.env.TENCENT_SECRET_ID;
  const envKey = process.env.TENCENT_SECRET_KEY;
  if (envId && envKey) {
    return { secretId: envId, secretKey: envKey };
  }

  const configPath = path.join(__dirname, 'config', 'publish-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.secretId && config.secretKey) {
        return { secretId: config.secretId, secretKey: config.secretKey };
      }
    } catch (err) {
      throw new Error(`配置文件解析失败: ${configPath}\n${err.message}`);
    }
  }

  throw new Error(
    '未找到腾讯云密钥，请通过以下方式之一配置：\n' +
    '  1. 环境变量：TENCENT_SECRET_ID 和 TENCENT_SECRET_KEY\n' +
    '  2. 配置文件：config/publish-config.json'
  );
}

// ========== COS 工具函数 ==========
function listObjects(cos, prefix) {
  return new Promise((resolve, reject) => {
    cos.getBucket(
      {
        Bucket: BUCKET,
        Region: REGION,
        Prefix: prefix,
        MaxKeys: 1000,
      },
      (err, data) => {
        if (err) reject(err);
        else resolve(data.Contents || []);
      }
    );
  });
}

function deleteCosObject(cos, key) {
  return new Promise((resolve, reject) => {
    cos.deleteObject(
      { Bucket: BUCKET, Region: REGION, Key: key },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function isAllowed(key) {
  // 允许保留的规范目录
  for (const prefix of ALLOWED_ROOT_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  // 允许保留的版本归档目录
  if (ALLOWED_VERSION_DIR.test(key)) return true;
  return false;
}

// ========== 主流程 ==========
async function main() {
  const isExec = process.argv.includes('--exec');
  const modeText = isExec ? '【执行删除】' : '【预览模式】';
  console.log(`[COS Clean] ${modeText} 开始清理 COS 散乱文件...\n`);

  const { secretId, secretKey } = getCredentials();
  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

  // 列出 updates/ 前缀下的所有对象
  const objects = await listObjects(cos, PREFIX);
  console.log(`[COS Clean] 共发现 ${objects.length} 个对象\n`);

  const toDelete = [];
  const toKeep = [];

  for (const obj of objects) {
    const key = obj.Key;
    if (isAllowed(key)) {
      toKeep.push(key);
    } else {
      toDelete.push(key);
    }
  }

  console.log('=== 保留的文件 ===');
  for (const key of toKeep) {
    console.log(`  [保留] ${key}`);
  }

  console.log(`\n=== 待删除的文件 (${toDelete.length} 个) ===`);
  for (const key of toDelete) {
    console.log(`  [删除] ${key}`);
  }

  if (toDelete.length === 0) {
    console.log('\n[COS Clean] 没有需要清理的文件，目录结构已规范。');
    return;
  }

  if (!isExec) {
    console.log(`\n[COS Clean] 以上 ${toDelete.length} 个文件待删除。`);
    console.log('[COS Clean] 这是预览模式，未真正删除。');
    console.log('[COS Clean] 确认无误后执行：node clean-cos.js --exec');
    return;
  }

  console.log(`\n[COS Clean] 开始删除 ${toDelete.length} 个文件...`);
  for (const key of toDelete) {
    process.stdout.write(`  删除中: ${key} ... `);
    try {
      await deleteCosObject(cos, key);
      console.log('OK');
    } catch (err) {
      console.log(`失败 (${err.message})`);
    }
  }

  console.log('\n[COS Clean] 清理完成！');
  console.log('[COS Clean] 当前规范目录结构：');
  console.log('  updates/win/    ← Windows 最新版本（latest.yml + exe + blockmap）');
  console.log('  updates/mac/    ← macOS 最新版本（latest-mac.yml + dmg + zip）');
  console.log('  updates/X.Y.Z/  ← 历史版本归档');
}

main().catch((err) => {
  console.error(`[COS Clean] 失败: ${err.message}`);
  process.exit(1);
});
