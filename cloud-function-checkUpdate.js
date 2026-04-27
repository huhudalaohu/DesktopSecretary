/**
 * CloudBase 云函数: checkUpdate
 * 
 * 部署方式:
 *   1. 登录腾讯云 CloudBase 控制台 → 云函数 → 新建云函数
 *   2. 函数名填: checkUpdate
 *   3. 运行环境: Node.js 16（推荐）或 Node.js 12（兼容版用这个代码）
 *   4. 把下面代码完整复制进去
 *   5. 保存并部署
 *   6. 触发管理 → 新建触发器 → HTTP → 不鉴权 → 复制生成的 URL
 *   7. 把 URL 填到本地 .env: UPDATE_API_URL=复制的URL
 */

// 当前发布的最新版本号
const LATEST_VERSION = '1.0.4';

// 版本发布说明（支持换行 \n）
const RELEASE_NOTES = 'DesktopSecretary ' + LATEST_VERSION + ' 更新内容：\n\n' +
  '- 修复截图裁剪后 Promise 挂起问题\n' +
  '- 修复跨磁盘文件移动失败\n' +
  '- 修复窗口宽度重启后丢失\n' +
  '- 修复开发模式截图 Overlay 加载失败\n' +
  '- 移除源码中硬编码的腾讯云密钥，改用环境变量';

// COS 上的安装包下载地址
const DOWNLOAD_URL = 'https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/updates/1.0.4/DesktopSecretary%20Setup%201.0.4.exe';

/**
 * 语义版本号比较
 * @returns {number} >0 表示 a>b, <0 表示 a<b, 0 表示相等
 */
function compareVersion(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const na = partsA[i] || 0;
    const nb = partsB[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

exports.main = async (event, context) => {
  // 支持两种调用方式：
  // 1. HTTP 触发器: event.queryStringParameters.version
  // 2. SDK callFunction: event.currentVersion
  var currentVersion = '1.0.3';
  
  if (event.queryStringParameters && event.queryStringParameters.version) {
    currentVersion = event.queryStringParameters.version;
  } else if (event.currentVersion) {
    currentVersion = event.currentVersion;
  }

  console.log('[checkUpdate] 当前版本: ' + currentVersion + ', 最新版本: ' + LATEST_VERSION);

  var hasUpdate = compareVersion(LATEST_VERSION, currentVersion) > 0;

  var result = {
    hasUpdate: hasUpdate,
    version: LATEST_VERSION,
    latestVersion: LATEST_VERSION,
    message: hasUpdate ? RELEASE_NOTES : '当前已是最新版本',
    downloadUrl: hasUpdate ? DOWNLOAD_URL : null,
  };

  console.log('[checkUpdate] 返回:', result);

  // HTTP 触发器需要包装成网关响应格式
  if (event.httpMethod || (event.queryStringParameters !== undefined && event.queryStringParameters !== null)) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(result),
    };
  }

  // SDK callFunction 直接返回对象
  return result;
};
