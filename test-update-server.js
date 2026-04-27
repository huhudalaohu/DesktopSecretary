/**
 * 本地更新接口 Mock 服务器
 * 用于测试 DesktopSecretary 的自动更新流程，无需真实腾讯云 HTTP 触发器
 *
 * 使用方法：
 *   1. node test-update-server.js
 *   2. .env 中设置 UPDATE_API_URL=http://localhost:3456/checkUpdate
 *   3. npm run dev 启动应用，在设置页点击"检查更新"
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 3456;

// 模拟：当前服务端最新版本
const LATEST_VERSION = '1.0.4';

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  console.log(`[MockServer] ${req.method} ${parsed.pathname}`);

  // CORS 放行，允许 Electron 本地页面调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 更新检查接口
  if (parsed.pathname === '/checkUpdate') {
    const currentVersion = parsed.query.version || '1.0.3';
    const hasUpdate = currentVersion !== LATEST_VERSION;

    const result = {
      hasUpdate,
      version: LATEST_VERSION,
      latestVersion: LATEST_VERSION,
      message: hasUpdate
        ? `🎉 新版本 ${LATEST_VERSION} 已发布！\n\n- 修复了截图裁剪坐标偏移问题\n- 优化了 Dock 贴边吸附体验\n- 支持跨磁盘文件移动`
        : '当前已是最新版本',
      downloadUrl: hasUpdate
        ? `http://localhost:${PORT}/download/DesktopSecretary-Setup-${LATEST_VERSION}.exe`
        : null,
    };

    console.log(`[MockServer] 版本检查: client=${currentVersion}, latest=${LATEST_VERSION}, hasUpdate=${hasUpdate}`);
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  // 模拟下载接口（返回一个 1MB 的随机文件）
  if (parsed.pathname.startsWith('/download/')) {
    const fileName = path.basename(parsed.pathname);
    console.log(`[MockServer] 模拟下载: ${fileName}`);

    const fileSize = 1024 * 1024; // 1MB
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', fileSize);
    res.writeHead(200);

    // 分块发送随机数据，模拟真实下载进度
    let sent = 0;
    const chunkSize = 64 * 1024;
    const interval = setInterval(() => {
      const remaining = fileSize - sent;
      if (remaining <= 0) {
        clearInterval(interval);
        res.end();
        console.log(`[MockServer] 下载完成: ${fileName}`);
        return;
      }
      const size = Math.min(chunkSize, remaining);
      res.write(Buffer.alloc(size, 0xAB));
      sent += size;
    }, 50);
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`\n🚀 更新接口 Mock 服务器已启动: http://localhost:${PORT}`);
  console.log(`\n测试步骤:`);
  console.log(`  1. .env 中设置 UPDATE_API_URL=http://localhost:${PORT}/checkUpdate`);
  console.log(`  2. 另开终端运行: npm run dev`);
  console.log(`  3. 在应用设置页点击"检查更新"`);
  console.log(`  4. 如果应用版本 < ${LATEST_VERSION}，会提示发现新版本`);
  console.log(`  5. 点击"下载更新"会下载一个 1MB 的模拟安装包`);
  console.log(`\n按 Ctrl+C 停止服务器\n`);
});
