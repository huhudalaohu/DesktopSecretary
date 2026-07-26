/**
 * WindowManager — 主窗口创建 + 生命周期管理
 */

const path = require('path');

class WindowManager {
  constructor({ screen, getEnv, getDockManager, platform }) {
    this.screen = screen;
    this.getEnv = getEnv;
    this.getDockManager = getDockManager;
    this.platform = platform;

    this.mainWindow = null;
    this.isQuitting = false;

    this._moveThrottleTimer = null;
    this._resizeThrottleTimer = null;
    this._moveEndDebounceTimer = null;
  }

  async createWindow() {
    const dock = this.getDockManager();
    const initialBounds = dock.getInitialBounds();

    const isDev = this.getEnv() === 'development';
    const { BrowserWindow, app, session } = require('electron');

    // CloudBase 域名直连,不经过系统代理(避免 Clash 代理超时)
    // 注意:身份认证 API 域名是 *.tcb-api.tencentcloudapi.com,更新源是 *.cos.*.myqcloud.com,
    // 都不属于 tcloudbase.com,必须一并直连,否则登录失败、自动更新检查不到新版本
    const proxyUrl = process.env.PROXY_URL || 'http://127.0.0.1:7897';
    const proxyHost = proxyUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (proxyHost) {
      const pacScript = `function FindProxyForURL(u,h){if(h.includes('tcloudbase.com'))return'DIRECT';if(h.includes('tencentcloudapi.com'))return'DIRECT';if(h.includes('myqcloud.com'))return'DIRECT';if(h==='localhost'||h==='127.0.0.1')return'DIRECT';return'PROXY ${proxyHost}';}`;
      const pacDataUrl = 'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(pacScript).toString('base64');
      session.defaultSession.setProxy({ mode: 'pac_script', pacScript: pacDataUrl });
      console.log('[Window] PAC proxy: tcloudbase/tencentcloudapi/myqcloud → DIRECT, 其它 →', proxyHost);
    }

    this.mainWindow = new BrowserWindow(this.platform.windowOptions.mainWindowOptions({
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      resizable: dock.dockedEdge === null,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    }));

    this.platform.windowOptions.applyMainWindowPlatformSetup(this.mainWindow);
    if (!app.isPackaged) {
      console.log('[Window] created, initialBounds=', initialBounds, 'dockedEdge=', dock.dockedEdge);
    }

    const indexFile = path.join(__dirname, '..', '..', 'dist', 'index.html');
    const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173';

    if (!app.isPackaged) {
      const devUrl = `${DEV_SERVER_URL}/`;
      // 简单等待 dev server 就绪
      this._waitForDevServer(devUrl, 15000).then((ready) => {
        if (ready) {
          console.log(`[Renderer] Loading dev server: ${devUrl}`);
          this.mainWindow.loadURL(devUrl).catch(err => console.error('Failed to load dev server:', err));
        } else {
          console.warn('[Renderer] Dev server not ready, fallback to file.');
          this.mainWindow.loadFile(indexFile).catch(err => console.error('Failed to load:', err));
        }
      });
    } else {
      this.mainWindow.loadFile(indexFile).catch(err => console.error('Failed to load:', err));
    }

    this._bindEvents();
    return new Promise((resolve) => {
      this.mainWindow.webContents.once('did-finish-load', () => resolve(this.mainWindow));
      this.mainWindow.webContents.once('did-fail-load', () => resolve(this.mainWindow));
      // 兜底：最多等 10 秒
      setTimeout(() => resolve(this.mainWindow), 10000);
    });
  }

  _bindEvents() {
    const win = this.mainWindow;
    const dock = this.getDockManager();

    win.webContents.setWindowOpenHandler(({ url }) => {
      const { shell } = require('electron');
      shell.openExternal(url);
      return { action: 'deny' };
    });

    win.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        win.hide();
      }
    });

    win.on('minimize', (event) => {
      event.preventDefault();
      win.hide();
    });

    // 拖动过程：节流 move，推送 snap-hint
    win.on('move', () => {
      if (this._moveThrottleTimer) return;
      this._moveThrottleTimer = setTimeout(() => {
        this._moveThrottleTimer = null;
        dock.handleWindowMove();

        // macOS 上 frame:false + -webkit-app-region:drag 不会触发 moved 事件
        if (process.platform === 'darwin') {
          clearTimeout(this._moveEndDebounceTimer);
          this._moveEndDebounceTimer = setTimeout(() => {
            if (Date.now() - dock.lastHandleWindowMovedTime < 300) return;
            dock.handleWindowMoved();
          }, 150);
        }
      }, 30);
    });

    // 拖动结束：边缘吸附判定
    win.on('moved', () => {
      if (process.platform === 'darwin') return;
      if (Date.now() - dock.lastHandleWindowMovedTime < 300) return;
      dock.handleWindowMoved();
    });

    // Resize：仅浮空态允许
    win.on('will-resize', (event, newBounds) => {
      if (dock.dockedEdge !== null) {
        event.preventDefault();
        return;
      }
      const clamped = dock.clampFloatingBounds(newBounds);
      if (clamped.width !== newBounds.width || clamped.height !== newBounds.height) {
        event.preventDefault();
        win.setBounds(clamped);
      }
    });

    win.on('resize', () => {
      if (dock.dockedEdge !== null) return;
      if (this._resizeThrottleTimer) return;
      this._resizeThrottleTimer = setTimeout(() => {
        this._resizeThrottleTimer = null;
        if (!win || win.isDestroyed()) return;
        const b = win.getBounds();
        dock.dockBounds = b;
        dock.state.set('dockBounds', b);
      }, 200);
    });

    win.on('closed', () => {
      dock.stopMouseTracking();
      console.log('Window closed');
      this.mainWindow = null;
    });

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
        event.preventDefault();
      }
    });

    dock.startMouseTracking();
  }

  getMainWindow() {
    return this.mainWindow;
  }

  async _waitForDevServer(targetUrl, timeoutMs = 15000) {
    const https = require('https');
    const http = require('http');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const client = targetUrl.startsWith('https:') ? https : http;
        const reachable = await new Promise((resolve) => {
          let settled = false;
          const req = client.get(targetUrl, (res) => {
            res.resume();
            if (!settled) { settled = true; resolve((res.statusCode || 0) < 500); }
          });
          req.on('error', () => { if (!settled) { settled = true; resolve(false); } });
          req.setTimeout(2000, () => { req.destroy(); if (!settled) { settled = true; resolve(false); } });
        });
        if (reachable) return true;
      } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  setQuitting(v) {
    this.isQuitting = v;
  }

  destroy() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.destroy();
    }
    this.mainWindow = null;
  }
}

module.exports = { WindowManager };
