/**
 * DesktopSecretary — 发布脚本（electron-updater 版）
 *
 * COS 目录结构：
 *   cos://{bucket}/
 *     ├── update.json              ← 兼容旧客户端的更新检查入口
 *     └── updates/
 *         ├── latest.yml           ← electron-updater 读取
 *         ├── DesktopSecretary Setup 1.0.6.exe
 *         ├── DesktopSecretary Setup 1.0.6.exe.blockmap
 *         └── 1.0.5/               ← 旧版本归档
 *             └── DesktopSecretary Setup 1.0.5.exe
 */

const fs = require('fs');
const path = require('path');
const COS = require('cos-nodejs-sdk-v5');

// ========== 配置 ==========
const BUCKET = 'ds-update-1420931574';
const REGION = 'ap-guangzhou';
const BASE_URL = `https://${BUCKET}.cos.${REGION}.myqcloud.com`;

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
  console.log(`[Publish] 开始发布，版本: ${version}`);

  // 读取密钥
  const { secretId, secretKey } = getCredentials();
  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

  // 扫描本地文件（按版本号精确匹配，防止多版本共存时扫错）
  const files = fs.readdirSync(distPath);
  const installer = files.find((f) => f.endsWith('.exe') && !f.endsWith('.blockmap') && f.includes(version));
  const blockmap = files.find((f) => f.endsWith('.exe.blockmap') && f.includes(version));
  const latestYml = files.find((f) => f === 'latest.yml');

  if (!installer) {
    throw new Error(`在 ${distPath} 下未找到 .exe 安装包`);
  }
  if (!latestYml) {
    throw new Error(`在 ${distPath} 下未找到 latest.yml，请先确认 package.json 中配置了 publish`);
  }

  const installerPath = path.join(distPath, installer);
  const blockmapPath = blockmap ? path.join(distPath, blockmap) : null;
  const latestYmlPath = path.join(distPath, latestYml);

  // 1. 上传最新版本到 updates/ 根目录（electron-updater 读取）
  console.log(`[Publish] 上传安装包到 updates/: ${installer}`);
  await uploadFile(cos, `updates/${installer}`, installerPath);

  if (blockmapPath) {
    console.log(`[Publish] 上传 blockmap 到 updates/: ${blockmap}`);
    await uploadFile(cos, `updates/${blockmap}`, blockmapPath);
  }

  console.log('[Publish] 上传 latest.yml 到 updates/latest.yml');
  await uploadFile(cos, 'updates/latest.yml', latestYmlPath);

  // 2. 归档到 updates/{version}/（保留历史版本）
  console.log(`[Publish] 归档到 updates/${version}/`);
  await uploadFile(cos, `updates/${version}/${installer}`, installerPath);

  // 3. 生成并上传根目录 update.json（兼容旧客户端）
  const releaseNotes = getReleaseNotes(version) || `DesktopSecretary ${version} 已发布`;
  const updateJson = {
    hasUpdate: true,
    version: version,
    latestVersion: version,
    message: releaseNotes,
    downloadUrl: `${BASE_URL}/updates/${installer}`,
  };
  const updateJsonPath = path.join(distPath, 'update.json');
  fs.writeFileSync(updateJsonPath, JSON.stringify(updateJson, null, 2), 'utf8');
  console.log('[Publish] 上传 update.json');
  await uploadFile(cos, 'update.json', updateJsonPath);

  // 4. 清理 COS 上我之前错误创建的文件
  console.log('[Publish] 清理旧体系残留...');
  const trashKeys = ['manifest.json', 'latest/manifest.json'];
  for (const key of trashKeys) {
    try {
      await deleteCosObject(cos, key);
      console.log(`[Publish] ✓ 已删除 ${key}`);
    } catch {
      // 可能已不存在，忽略
    }
  }

  console.log('');
  console.log(`[Publish] 发布完成！版本: ${version}`);
  console.log(`[Publish] 更新检查 (electron-updater): ${BASE_URL}/updates/latest.yml`);
  console.log(`[Publish] 更新检查 (旧客户端兼容): ${BASE_URL}/update.json`);
  console.log(`[Publish] 安装包: ${BASE_URL}/updates/${installer}`);
}

main().catch((err) => {
  console.error(`[Publish] 失败: ${err.message}`);
  process.exit(1);
});
