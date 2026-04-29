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
 *     │   └── 1.0.8/               ← 旧版本归档（win + mac 混合）
 *
 * 用法：
 *   node publish.js --platform=win    (默认)
 *   node publish.js --platform=mac
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
const isMac = platform === 'mac';
const isWin = platform === 'win';

// ========== 读取 package.json 版本号 ==========
const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;

// electron-builder 输出目录
const outputDir = pkg.build?.directories?.output || 'release';
const distPath = path.join(__dirname, outputDir);

// ========== 读取密钥 ==========
function getCredentials() {
  const envId = process.env.TENCENT_SECRET_ID;
  const envKey = process.env.TENCENT_SECRET_KEY;
  if (envId && envKey) {
    console.log('[Publish] 使用环境变量密钥');
    return { secretId: envId, secretKey: envKey };
  }

  const configPath = path.join(__dirname, 'config', 'publish-config.json');
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

// ========== 读取 release notes ==========
function getReleaseNotes(ver) {
  const notesPath = path.join(__dirname, 'config', 'release-notes.json');
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
  console.log(`[Publish] 开始发布，平台: ${platform.toUpperCase()}，版本: ${version}`);

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
    uploadList.push({ local: path.join(distPath, installer), remote: `updates/${version}/${installer}` });
  }

  if (isMac) {
    // macOS: .dmg + .zip + latest-mac.yml
    const dmgs = files.filter((f) => f.endsWith('.dmg') && f.includes(version));
    const zips = files.filter((f) => f.endsWith('.zip') && f.includes(version) && !f.endsWith('.blockmap'));
    const latestMacYml = files.find((f) => f === 'latest-mac.yml');

    if (dmgs.length === 0) throw new Error(`在 ${distPath} 下未找到 .dmg 安装包`);
    if (!latestMacYml) throw new Error(`在 ${distPath} 下未找到 latest-mac.yml`);

    for (const f of dmgs) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/mac/${f}` });
    }
    for (const f of zips) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/mac/${f}` });
    }
    uploadList.push({ local: path.join(distPath, latestMacYml), remote: 'updates/mac/latest-mac.yml' });

    // 归档
    for (const f of dmgs) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/${version}/${f}` });
    }
    for (const f of zips) {
      uploadList.push({ local: path.join(distPath, f), remote: `updates/${version}/${f}` });
    }
  }

  // 执行上传
  for (const item of uploadList) {
    console.log(`[Publish] 上传: ${item.remote}`);
    await uploadFile(cos, item.remote, item.local);
  }

  console.log('');
  console.log(`[Publish] 发布完成！平台: ${platform.toUpperCase()}，版本: ${version}`);
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
