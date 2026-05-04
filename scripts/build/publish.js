/**
 * DesktopSecretary — 发布脚本（支持 Windows / macOS 双平台）
 *
 * COS 目录结构：
 *   cos://{bucket}/
 *     ├── updates/
 *     │   ├── win/
 *     │   │   ├── latest.yml
 *     │   │   ├── DesktopSecretary-1.0.8-win-x64.exe
 *     │   │   └── DesktopSecretary-1.0.8-win-x64.exe.blockmap
 *     │   ├── mac/
 *     │   │   ├── latest-mac.yml
 *     │   │   ├── DesktopSecretary-1.0.8-mac-arm64.dmg
 *     │   │   ├── DesktopSecretary-1.0.8-mac-x64.dmg
 *     │   │   ├── DesktopSecretary-1.0.8-mac-arm64.zip
 *     │   │   └── DesktopSecretary-1.0.8-mac-x64.zip
 *     │   └── 1.0.8/               ← 旧版本归档（按平台子目录分离）
 *     │       ├── win/
 *     │       │   └── DesktopSecretary-1.0.8-win-x64.exe
 *     │       └── mac/
 *     │           └── DesktopSecretary-1.0.8-mac-arm64.zip
 *
 * 用法：
 *   node publish.js --platform=win                (默认)
 *   node publish.js --platform=mac
 *   node publish.js --platform=win --dry-run      (预览，不实际上传/删除)
 */

const fs = require('fs');
const path = require('path');
const COS = require('cos-nodejs-sdk-v5');

// ========== 配置 ==========
const BUCKET = 'ds-update-1420931574';
const REGION = 'ap-guangzhou';
const BASE_URL = `https://${BUCKET}.cos.${REGION}.myqcloud.com`;

// ========== 解析命令行参数 ==========
const platform = process.argv.includes('--platform=mac') ? 'mac' : 'win';
const isDryRun = process.argv.includes('--dry-run');
const isMac = platform === 'mac';
const isWin = platform === 'win';

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

// ========== 读取 release notes ==========
function getReleaseNotes(ver) {
  const notesPath = path.join(__dirname, '..', '..', 'config', 'release-notes.json');
  if (!fs.existsSync(notesPath)) return null;
  try {
    const notes = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
    return notes[ver] || null;
  } catch {
    return null;
  }
}

// ========== 主流程 ==========
async function main() {
  console.log(`[Publish] 开始发布，平台: ${platform.toUpperCase()}，版本: ${version}${isDryRun ? ' (dry-run)' : ''}`);

  // 读取密钥
  const { secretId, secretKey } = getCredentials();
  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

  const files = fs.readdirSync(distPath);
  const uploadList = [];

  if (isWin) {
    // Windows: .exe + .blockmap + latest.yml
    const installer = files.find((f) => f.endsWith('.exe') && !f.endsWith('.blockmap') && f.includes(version));
    const blockmap = files.find((f) => f.endsWith('.exe.blockmap') && f.includes(version));
    const latestYml = files.find((f) => f === 'latest.yml');

    if (!installer) throw new Error(`在 ${distPath} 下未找到 .exe 安装包`);
    if (!latestYml) throw new Error(`在 ${distPath} 下未找到 latest.yml`);

    uploadList.push({ local: path.join(distPath, installer), remote: `updates/win/${installer}` });
    if (blockmap) uploadList.push({ local: path.join(distPath, blockmap), remote: `updates/win/${blockmap}` });
    uploadList.push({ local: path.join(distPath, latestYml), remote: 'updates/win/latest.yml' });

    // 归档
    uploadList.push({ local: path.join(distPath, installer), remote: `updates/${version}/win/${installer}` });
    if (blockmap) uploadList.push({ local: path.join(distPath, blockmap), remote: `updates/${version}/win/${blockmap}` });
  }

  if (isMac) {
    // macOS: .dmg + .zip + latest-mac.yml
    const dmgs = files.filter((f) => f.endsWith('.dmg') && f.includes(version));
    const zips = files.filter((f) => f.endsWith('.zip') && f.includes(version) && !f.endsWith('.blockmap'));
    const latestMacYml = files.find((f) => f === 'latest-mac.yml');

    if (dmgs.length === 0) throw new Error(`在 ${distPath} 下未找到 .dmg 安装包`);
    if (!latestMacYml) throw new Error(`在 ${distPath} 下未找到 latest-mac.yml。请确保 mac 构建成功并生成了该文件。`);

    for (const f of dmgs) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/mac/${f}` });
    }
    for (const f of zips) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/mac/${f}` });
    }
    uploadList.push({ local: path.join(distPath, latestMacYml), remote: 'updates/mac/latest-mac.yml' });

    // 归档
    for (const f of dmgs) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/${version}/mac/${f}` });
    }
    for (const f of zips) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/${version}/mac/${f}` });
    }
  }

  // 清理旧版本
  await cleanPlatformDir(cos, platform);

  // 执行上传
  console.log('');
  console.log(`[Publish] 将要上传 ${uploadList.length} 个文件:`);
  for (const item of uploadList) {
    console.log(`  → ${item.remote}`);
  }

  if (isDryRun) {
    console.log('[Publish] [dry-run] 跳过实际上传');
  } else {
    for (const item of uploadList) {
      console.log(`[Publish] 上传: ${item.remote}`);
      await uploadFile(cos, item.remote, item.local);
    }
  }

  console.log('');
  console.log(`[Publish] 发布完成！平台: ${platform.toUpperCase()}，版本: ${version}${isDryRun ? ' (dry-run)' : ''}`);
  if (isWin) {
    console.log(`[Publish] Windows 更新检查: ${BASE_URL}/updates/win/latest.yml`);
  }
  if (isMac) {
    console.log(`[Publish] macOS 更新检查: ${BASE_URL}/updates/mac/latest-mac.yml`);
  }
}

main().catch((err) => {
  console.error(`[Publish] 失败: ${err.message}`);
  process.exit(1);
});
