/**
 * DesktopSecretary — 本地发布脚本（自动检测平台）
 *
 * 用法：
 *   node scripts/build/publish.js                  自动检测平台并上传
 *   node scripts/build/publish.js --dry-run        预览，不实际上传/删除
 *   node scripts/build/publish.js --no-cleanup     跳过清理旧版本，直接上传
 */

const fs = require('fs');
const path = require('path');
const COS = require('cos-nodejs-sdk-v5');

// ========== 配置 ==========
const BUCKET = 'ds-update-1420931574';
const REGION = 'ap-guangzhou';
const BASE_URL = `https://${BUCKET}.cos.${REGION}.myqcloud.com`;

// ========== 解析命令行参数 ==========
const isDryRun = process.argv.includes('--dry-run');
const skipCleanup = process.argv.includes('--no-cleanup');

// ========== 读取 package.json 版本号 ==========
const pkgPath = path.join(__dirname, '..', '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;

// electron-builder 输出目录
const outputDir = pkg.build?.directories?.output || 'release';
const distPath = path.join(__dirname, '..', '..', outputDir);

// ========== 读取密钥 ==========
function getCredentials() {
  const envId = process.env.TENCENT_SECRET_ID;
  const envKey = process.env.TENCENT_SECRET_KEY;
  if (envId && envKey) {
    console.log('[Publish] 使用环境变量密钥');
    return { secretId: envId, secretKey: envKey };
  }

  const configPath = path.join(__dirname, '..', '..', 'config', 'publish-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.secretId && config.secretKey) {
        console.log('[Publish] 使用配置文件密钥');
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

function uploadFile(cos, key, filePath) {
  const size = fs.statSync(filePath).size;
  const sizeMB = (size / 1024 / 1024).toFixed(1);
  return new Promise((resolve, reject) => {
    // 大于 50MB 的文件使用分片上传，避免超时
    if (size > 50 * 1024 * 1024) {
      console.log(`[Publish] 分片上传 ${key} (${sizeMB}MB)...`);
      cos.sliceUploadFile(
        {
          Bucket: BUCKET,
          Region: REGION,
          Key: key,
          FilePath: filePath,
          onProgress: (progressData) => {
            const pct = Math.round(progressData.percent * 100);
            if (pct % 10 === 0) {
              console.log(`[Publish] ${key}: ${pct}%`);
            }
          },
        },
        (err, data) => {
          if (err) reject(err);
          else resolve(data);
        }
      );
    } else {
      cos.putObject(
        {
          Bucket: BUCKET,
          Region: REGION,
          Key: key,
          Body: fs.createReadStream(filePath),
          ContentLength: size,
        },
        (err, data) => {
          if (err) reject(err);
          else resolve(data);
        }
      );
    }
  });
}

function checkCosFileExists(cos, key) {
  return new Promise((resolve) => {
    cos.headObject(
      { Bucket: BUCKET, Region: REGION, Key: key },
      (err, data) => {
        if (err) {
          if (err.statusCode === 404) {
            resolve(false);
          } else {
            console.log(`[Publish] 检查 COS 文件状态异常: ${err.message}`);
            resolve(false);
          }
        } else {
          resolve(true);
        }
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

/**
 * 列出 COS 中指定前缀下的所有对象
 */
async function listObjects(cos, prefix) {
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
      if (obj.Key !== prefix) keys.push(obj.Key);
    }
    if (!res.IsTruncated) break;
    marker = res.NextMarker;
  }
  return keys;
}

/**
 * 清理 updates/{platform}/ 下的所有旧文件
 */
async function cleanPlatformDir(cos, platform) {
  const prefix = `updates/${platform}/`;
  const keys = await listObjects(cos, prefix);
  if (keys.length === 0) {
    console.log(`[Publish] ${prefix} 下无旧文件需要清理`);
    return;
  }
  console.log(`[Publish] 发现 ${prefix} 下有 ${keys.length} 个旧文件，准备清理:`);
  for (const key of keys) {
    console.log(`  - ${key}`);
  }
  if (isDryRun) {
    console.log('[Publish] [dry-run] 跳过删除');
    return;
  }
  for (const key of keys) {
    await deleteCosObject(cos, key);
    console.log(`  [已删除] ${key}`);
  }
}

// ========== 主流程 ==========
async function main() {
  console.log(`[Publish] 开始发布，版本: ${version}${isDryRun ? ' (dry-run)' : ''}`);

  if (!fs.existsSync(distPath)) {
    throw new Error(`构建输出目录不存在: ${distPath}，请先运行 npm run dist`);
  }

  // 读取密钥
  const { secretId, secretKey } = getCredentials();
  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

  const files = fs.readdirSync(distPath);

  // ========== 自动检测平台 ==========
  const hasWin = files.some((f) => f.endsWith('.exe') && f.includes(version)) || files.includes('latest.yml');
  const hasMac = files.some((f) => f.endsWith('.dmg') && f.includes(version)) || files.includes('latest-mac.yml');

  if (!hasWin && !hasMac) {
    throw new Error(`在 ${distPath} 下未找到任何构建产物，请先运行 npm run dist`);
  }

  console.log(`[Publish] 检测到平台: ${[hasWin && 'Windows', hasMac && 'macOS'].filter(Boolean).join(', ')}`);

  // ========== 构建上传列表 ==========
  const uploadList = [];

  if (hasWin) {
    const installer = files.find((f) => f.endsWith('.exe') && !f.endsWith('.blockmap') && f.includes(version));
    const blockmap = files.find((f) => f.endsWith('.exe.blockmap') && f.includes(version));
    const latestYml = files.find((f) => f === 'latest.yml');

    if (!installer) throw new Error(`在 ${distPath} 下未找到 .exe 安装包`);
    if (!latestYml) throw new Error(`在 ${distPath} 下未找到 latest.yml`);

    uploadList.push({ local: path.join(distPath, installer), remote: `updates/win/${installer}`, platform: 'win' });
    if (blockmap) uploadList.push({ local: path.join(distPath, blockmap), remote: `updates/win/${blockmap}`, platform: 'win' });
    uploadList.push({ local: path.join(distPath, latestYml), remote: 'updates/win/latest.yml', platform: 'win' });

    // 归档
    uploadList.push({ local: path.join(distPath, installer), remote: `updates/${version}/win/${installer}`, platform: 'win' });
    if (blockmap) uploadList.push({ local: path.join(distPath, blockmap), remote: `updates/${version}/win/${blockmap}`, platform: 'win' });
  }

  if (hasMac) {
    const dmgs = files.filter((f) => f.endsWith('.dmg') && f.includes(version));
    const zips = files.filter((f) => f.endsWith('.zip') && f.includes(version) && !f.endsWith('.blockmap'));
    const latestMacYml = files.find((f) => f === 'latest-mac.yml');

    if (dmgs.length === 0) throw new Error(`在 ${distPath} 下未找到 .dmg 安装包`);
    if (!latestMacYml) throw new Error(`在 ${distPath} 下未找到 latest-mac.yml。请确保 mac 构建成功并生成了该文件。`);

    for (const f of dmgs) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/mac/${f}`, platform: 'mac' });
    }
    for (const f of zips) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/mac/${f}`, platform: 'mac' });
    }
    uploadList.push({ local: path.join(distPath, latestMacYml), remote: 'updates/mac/latest-mac.yml', platform: 'mac' });

    // 归档
    for (const f of dmgs) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/${version}/mac/${f}`, platform: 'mac' });
    }
    for (const f of zips) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/${version}/mac/${f}`, platform: 'mac' });
    }
  }

  // ========== COS 排重检查 ==========
  console.log('');
  const skipList = [];
  const needUploadList = [];

  for (const item of uploadList) {
    const exists = await checkCosFileExists(cos, item.remote);
    if (exists) {
      skipList.push(item);
    } else {
      needUploadList.push(item);
    }
  }

  if (skipList.length > 0) {
    console.log(`[Publish] ${skipList.length} 个文件已存在于 COS，将跳过:`);
    for (const item of skipList) {
      console.log(`  ✓ ${item.remote}`);
    }
  }

  if (needUploadList.length === 0) {
    console.log('[Publish] 所有文件均已存在于 COS，无需上传。');
    return;
  }

  console.log(`[Publish] 将要上传 ${needUploadList.length} 个文件:`);
  for (const item of needUploadList) {
    console.log(`  → ${item.remote}`);
  }

  // ========== 清理旧版本（只对需要上传的平台）==========
  if (skipCleanup) {
    console.log('[Publish] --no-cleanup: 跳过清理旧版本');
  } else {
    const platformsToClean = new Set(needUploadList.map((item) => item.platform));
    for (const platform of platformsToClean) {
      try {
        await Promise.race([
          cleanPlatformDir(cos, platform),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('CLEANUP_TIMEOUT')), 15000)
          ),
        ]);
      } catch (err) {
        if (err.message === 'CLEANUP_TIMEOUT') {
          console.log(`[Publish] 清理 ${platform} 旧文件超时（15秒），跳过清理继续上传`);
        } else {
          throw err;
        }
      }
    }
  }

  // ========== 执行上传 ==========
  if (isDryRun) {
    console.log('[Publish] [dry-run] 跳过实际上传');
  } else {
    for (const item of needUploadList) {
      console.log(`[Publish] 上传: ${item.remote}`);
      await uploadFile(cos, item.remote, item.local);
    }
  }

  console.log('');
  console.log(`[Publish] 发布完成！版本: ${version}${isDryRun ? ' (dry-run)' : ''}`);
  if (hasWin) {
    console.log(`[Publish] Windows 更新检查: ${BASE_URL}/updates/win/latest.yml`);
  }
  if (hasMac) {
    console.log(`[Publish] macOS 更新检查: ${BASE_URL}/updates/mac/latest-mac.yml`);
  }
}

main().catch((err) => {
  console.error(`[Publish] 失败: ${err.message}`);
  process.exit(1);
});
