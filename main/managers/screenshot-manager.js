/**
 * ScreenshotManager — 截图 + Overlay + 裁剪管理
 *
 * 使用平台抽象层 platform.screenCapture.captureAllScreens()
 * 支持 node-screenshots (Rust/xcap) 和 desktopCapturer 降级
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const SCREENSHOT_TIMEOUT_MS = 120000;
const OVERLAY_READY_TIMEOUT_MS = 500;

class ScreenshotManager {
  constructor({ screen, ipcMain, getMainWindow, platform, getDockManager }) {
    this.screen = screen;
    this.ipcMain = ipcMain;
    this.getMainWindow = getMainWindow;
    this.platform = platform;
    this.getDockManager = getDockManager;

    this.overlayWindows = new Map();
    this.overlayActive = false;
    this.screenshotReadyHandler = null;
    this.screenshotResolve = null;
    this.screenshotTimeout = null;
    this.capturedScreenshot = null;

    this._tempDir = path.join(os.tmpdir(), 'desktop-secretary-screenshots');
    try { fs.mkdirSync(this._tempDir, { recursive: true }); } catch {}

    this._registerIpcHandlers();
  }

  _registerIpcHandlers() {
    // 启动截图 overlay 流程（主流程，使用平台抽象层）
    this.ipcMain.handle('start-screenshot-overlay', async () => {
      const result = await this.startScreenshotOverlay();
      if (result === null) throw new Error('cancelled');
      return result;
    });

    // 截图裁剪
    this.ipcMain.handle('screenshot:crop', async (_event, { x, y, width, height }) => {
      try {
        if (!this.capturedScreenshot || this.capturedScreenshot.length === 0) {
          throw new Error('No captured screenshot');
        }
        return this._cropScreenshot({ x, y, width, height });
      } catch (err) {
        console.error('[Screenshot] 裁剪失败:', err);
        this.hideOverlay();
        return { success: false, error: err.message };
      }
    });

    // 取消截图
    this.ipcMain.handle('screenshot:cancel', () => {
      this.hideOverlay();
      this._resolve(null);
      return { success: true };
    });

    // 备用：直接截图（返回 dataUrl，用于非 overlay 场景）
    this.ipcMain.handle('capture-screenshot', async () => {
      try {
        const { desktopCapturer } = require('electron');
        const displays = this.screen.getAllDisplays();
        let maxW = 0, maxH = 0;
        for (const d of displays) {
          maxW = Math.max(maxW, d.size.width * d.scaleFactor);
          maxH = Math.max(maxH, d.size.height * d.scaleFactor);
        }
        maxW = Math.max(maxW, 1920);
        maxH = Math.max(maxH, 1080);

        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: maxW, height: maxH },
        });

        return {
          sources: sources.map(s => ({
            id: s.id,
            displayId: s.display_id,
            name: s.name,
            dataUrl: s.thumbnail.toDataURL(),
            thumbnailSize: s.thumbnail.getSize(),
          })),
          totalDisplays: displays.length,
        };
      } catch (err) {
        console.error('[Screenshot] 截图失败:', err);
        return { error: err.message };
      }
    });
  }

  async startScreenshotOverlay() {
    if (this.overlayActive) {
      console.log('[Screenshot] 已有截图流程进行中，忽略重复触发');
      return null;
    }

    return new Promise((resolve) => {
      (async () => {
        this.screenshotResolve = resolve;
        const t0 = Date.now();

        this.capturedScreenshot = null;
        this._clearTimeout();
        this.screenshotTimeout = setTimeout(() => {
          console.log('[Screenshot] overlay 超时，自动取消');
          this.hideOverlay();
          this._resolve(null);
        }, SCREENSHOT_TIMEOUT_MS);

        // 1. 隐藏主窗口
        const mainWindow = this.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          const dock = this.getDockManager();
          if (dock) {
            if (dock.dockExpandTimer) { clearTimeout(dock.dockExpandTimer); dock.dockExpandTimer = null; }
            if (dock.dockHideTimer) { clearTimeout(dock.dockHideTimer); dock.dockHideTimer = null; }
          }
          mainWindow.hide();
          await new Promise(r => setTimeout(r, 100));
        }

        // 2. 确保 overlay 就绪
        try {
          await this.ensureOverlayReady();
        } catch (err) {
          console.error('[Screenshot] overlay 就绪失败:', err);
          this._resolve(null);
          return;
        }

        const displays = this.screen.getAllDisplays();

        // 3. 截屏
        let sources;
        try {
          sources = await this.platform.screenCapture.captureAllScreens();
          this.capturedScreenshot = sources;
          console.log(`[Screenshot] 截屏成功, 源数量=${sources.length}`);
        } catch (err) {
          console.error('[Screenshot] 截屏失败:', err);
          this.hideOverlay();
          this._resolve(null);
          return;
        }

        const t1 = Date.now();
        console.log(`[Screenshot] 截屏+窗口准备完成: ${t1 - t0}ms`);

        // 4. 清理上一次 ready 监听器
        if (this.screenshotReadyHandler) {
          this.ipcMain.removeListener('screenshot:ready', this.screenshotReadyHandler);
          this.screenshotReadyHandler = null;
        }

        // 5. 推送截图数据到各 overlay
        const pendingOverlays = [];
        for (const display of displays) {
          const displayId = String(display.id);
          const win = this.overlayWindows.get(displayId);
          if (!win || win.isDestroyed()) {
            console.warn(`[Screenshot] display ${displayId} 缺少 overlay，跳过`);
            continue;
          }

          let source = sources.find(s => s.displayId === displayId);
          if (!source) {
            source = sources.find(s =>
              Math.abs(s.bounds.x - display.bounds.x) <= 2 &&
              Math.abs(s.bounds.y - display.bounds.y) <= 2
            );
          }
          if (!source) {
            console.warn(`[Screenshot] display ${displayId} 没有匹配到截图源，跳过`);
            continue;
          }

          const tBuf0 = Date.now();
          const buffer = source.toBuffer('png');
          const tBuf1 = Date.now();
          console.log(`[Screenshot] display[${displayId}] PNG ${tBuf1 - tBuf0}ms, ${Math.round(buffer.length / 1024)}KB, engine=${source.engine}`);

          win.webContents.send('screenshot:start', {
            buffer,
            mime: 'image/png',
            windowRect: null,
            virtualBounds: {
              x: display.bounds.x,
              y: display.bounds.y,
              width: display.bounds.width,
              height: display.bounds.height,
            },
            primaryDisplay: {
              bounds: display.bounds,
              scaleFactor: display.scaleFactor,
            },
          });
          pendingOverlays.push(win);
        }

        if (pendingOverlays.length === 0) {
          console.error('[Screenshot] 没有任何 overlay 可用');
          this.hideOverlay();
          this._resolve(null);
          return;
        }

        // 6. 等待所有 overlay ready
        await new Promise((readyResolve) => {
          let remaining = pendingOverlays.length;
          const readyTimeout = setTimeout(() => {
            console.log(`[Screenshot] overlay ready 超时(剩 ${remaining})，强制显示`);
            this._removeReadyHandler();
            readyResolve();
          }, OVERLAY_READY_TIMEOUT_MS);

          this.screenshotReadyHandler = () => {
            remaining--;
            if (remaining <= 0) {
              clearTimeout(readyTimeout);
              this._removeReadyHandler();
              readyResolve();
            }
          };
          this.ipcMain.on('screenshot:ready', this.screenshotReadyHandler);
        });

        // 7. 显示 overlay
        this.overlayActive = true;
        const cursor = this.screen.getCursorScreenPoint();
        const cursorDisplay = this.screen.getDisplayNearestPoint(cursor);
        for (const win of pendingOverlays) {
          try { win.show(); } catch {}
        }
        const focusId = String(cursorDisplay.id);
        const focusWin = this.overlayWindows.get(focusId) || pendingOverlays[0];
        if (focusWin && !focusWin.isDestroyed()) {
          try { focusWin.focus(); } catch {}
        }

        const t2 = Date.now();
        console.log(`[Screenshot] Overlay 显示完成: ${t2 - t0}ms (截屏${t1 - t0}ms + 加载${t2 - t1}ms), overlays=${pendingOverlays.length}`);

        // 8. 异步获取前台窗口
        this.platform.windowInfo.getForegroundWindow().then((winInfo) => {
          if (!winInfo) return;
          if (!winInfo.processName || winInfo.processName.toLowerCase().includes('electron')) return;
          const cx = (winInfo.rect.left + winInfo.rect.right) / 2;
          const cy = (winInfo.rect.top + winInfo.rect.bottom) / 2;
          const targetDisplay = this.screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
          const targetWin = this.overlayWindows.get(String(targetDisplay.id));
          if (targetWin && !targetWin.isDestroyed()) {
            targetWin.webContents.send('screenshot:update-window-rect', winInfo.rect);
            console.log(`[Screenshot] 前台窗口检测 → display ${targetDisplay.id}: ${Date.now() - t0}ms`);
          }
        }).catch((err) => {
          console.log('[Screenshot] 前台窗口检测失败（非关键）:', err.message);
        });
      })();
    });
  }

  _cropScreenshot({ x, y, width, height }) {
    const primaryDisplay = this.screen.getPrimaryDisplay();
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    let source = this.capturedScreenshot.find(s => {
      const b = s.bounds;
      return centerX >= b.x && centerX < b.x + b.width && centerY >= b.y && centerY < b.y + b.height;
    });
    if (!source) {
      source = this.capturedScreenshot.find(s => s.displayId === String(primaryDisplay.id))
            || this.capturedScreenshot[0];
    }

    const sf = source.scaleFactor;
    const cropX = Math.round((x - source.bounds.x) * sf);
    const cropY = Math.round((y - source.bounds.y) * sf);
    const cropW = Math.round(width * sf);
    const cropH = Math.round(height * sf);

    const cropped = source.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
    const dataUrl = cropped.toDataUrl();

    this.hideOverlay();
    this.capturedScreenshot = null;
    this._clearTimeout();
    this._resolve(dataUrl);

    return { success: true, dataUrl };
  }

  hideOverlay() {
    this.overlayActive = false;
    for (const win of this.overlayWindows.values()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send('screenshot:reset'); } catch {}
      try { win.hide(); } catch {}
    }
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[Window] show() from hideOverlay');
      mainWindow.show();
      mainWindow.focus();
    }
  }

  async ensureOverlayReady() {
    const displays = this.screen.getAllDisplays();
    const wanted = new Set(displays.map(d => String(d.id)));

    for (const [id, win] of this.overlayWindows) {
      if (!wanted.has(id)) {
        try { if (!win.isDestroyed()) win.destroy(); } catch {}
        this.overlayWindows.delete(id);
        console.log(`[Screenshot] overlay[${id}] 已移除（显示器拔出）`);
      }
    }

    const creations = [];
    for (const d of displays) {
      const id = String(d.id);
      const existing = this.overlayWindows.get(id);
      if (existing && !existing.isDestroyed()) {
        try { existing.setBounds({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }); } catch {}
        continue;
      }
      if (existing) this.overlayWindows.delete(id);
      creations.push(this._createOverlayForDisplay(d));
    }
    if (creations.length > 0) await Promise.all(creations);
  }

  async _createOverlayForDisplay(display) {
    const { BrowserWindow } = require('electron');
    const { app } = require('electron');

    const win = new BrowserWindow(this.platform.windowOptions.overlayWindowOptions({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [`--display-id=${display.id}`],
      },
    }));
    this.platform.windowOptions.applyOverlayPlatformSetup(win);

    const overlayFile = path.join(__dirname, '..', '..', 'dist', 'screenshot-overlay.html');
    try {
      if (!app.isPackaged) {
        const devUrl = `${process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'}/screenshot-overlay.html`;
        const canReach = await this._canReachUrl(devUrl);
        if (canReach) {
          await win.loadURL(devUrl);
        } else {
          await win.loadFile(overlayFile);
        }
      } else {
        await win.loadFile(overlayFile);
      }
    } catch (err) {
      console.error(`[Screenshot] overlay[${display.id}] 加载失败:`, err);
      throw err;
    }

    await new Promise((resolve) => {
      if (win.isDestroyed()) { resolve(); return; }
      const timer = setTimeout(resolve, 800);
      win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      win.webContents.once('dom-ready', () => { clearTimeout(timer); resolve(); });
      win.webContents.once('did-fail-load', () => { clearTimeout(timer); resolve(); });
    });

    const displayId = String(display.id);
    win.on('closed', () => {
      this.overlayWindows.delete(displayId);
    });
    this.overlayWindows.set(displayId, win);
    console.log(`[Screenshot] overlay[${displayId}] 预创建完成 bounds=${display.bounds.x},${display.bounds.y} ${display.bounds.width}x${display.bounds.height}`);
    return win;
  }

  _canReachUrl(targetUrl) {
    return new Promise((resolve) => {
      const client = targetUrl.startsWith('https:') ? require('https') : require('http');
      let settled = false;
      const req = client.get(targetUrl, (res) => {
        res.resume();
        if (!settled) { settled = true; resolve((res.statusCode || 0) < 500); }
      });
      req.on('error', () => { if (!settled) { settled = true; resolve(false); } });
      req.setTimeout(2000, () => { req.destroy(); if (!settled) { settled = true; resolve(false); } });
    });
  }

  attachDisplayChangeListeners() {
    const rebuild = () => {
      this.ensureOverlayReady().catch(err => console.error('[Screenshot] overlay 池重建失败:', err));
    };
    this.screen.on('display-added', rebuild);
    this.screen.on('display-removed', rebuild);
    this.screen.on('display-metrics-changed', rebuild);
  }

  _resolve(value) {
    if (this.screenshotTimeout) { clearTimeout(this.screenshotTimeout); this.screenshotTimeout = null; }
    if (this.screenshotResolve) {
      this.screenshotResolve(value);
      this.screenshotResolve = null;
    }
  }

  _clearTimeout() {
    if (this.screenshotTimeout) { clearTimeout(this.screenshotTimeout); this.screenshotTimeout = null; }
  }

  _removeReadyHandler() {
    if (this.screenshotReadyHandler) {
      this.ipcMain.removeListener('screenshot:ready', this.screenshotReadyHandler);
      this.screenshotReadyHandler = null;
    }
  }

  destroy() {
    this._removeReadyHandler();
    this._clearTimeout();
    this.hideOverlay();
    for (const win of this.overlayWindows.values()) {
      try { if (!win.isDestroyed()) { win.removeAllListeners('closed'); win.destroy(); } } catch {}
    }
    this.overlayWindows.clear();
  }
}

module.exports = { ScreenshotManager };
