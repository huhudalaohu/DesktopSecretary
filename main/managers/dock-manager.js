/**
 * DockManager — QQ 式 Dock 自动隐藏管理
 */

const DOCK_EDGE_WIDTH = 3;
const DOCK_EXPANDED_WIDTH = 350;
const DOCK_HEIGHT_RATIO = 0.85;
const DOCK_HOT_ZONE_WIDTH = 8;
const DOCK_EXPAND_DELAY = 800;
const DOCK_GRACE_PERIOD = 3000;
const DOCK_SNAP_THRESHOLD = 20;
const DOCK_MOVE_THROTTLE = 30;
const DOCK_MIN_WIDTH = 280;
const DOCK_MAX_WIDTH = 520;
const DOCK_MIN_HEIGHT = 400;
const DOCK_RATIO_MIN = 1.2;
const DOCK_RATIO_MAX = 4.0;

class DockManager {
  constructor({ screen, getMainWindow, stateManager }) {
    this.screen = screen;
    this.getMainWindow = getMainWindow;
    this.state = stateManager;

    // 运行时状态
    this.dockExpanded = false;
    this.dockPinned = false;
    this.dockedEdge = 'right';
    this.dockBounds = null;
    this.dockEdgeOffset = null;
    this.dockExpandedWidth = DOCK_EXPANDED_WIDTH;

    // 定时器
    this.dockHideTimer = null;
    this.dockGraceTimer = null;
    this.dockMouseTimer = null;
    this.dockExpandTimer = null;
    this.dockMoveThrottleTimer = null;
    this.dockResizeThrottleTimer = null;
    this.moveEndDebounceTimer = null;

    // 辅助状态
    this.dockInteracting = false;
    this.lastSnapHintEdge = undefined;
    this.suppressMoveHint = false;
    this.suppressMoveHintTimer = null;
    this.lastHandleWindowMovedTime = 0;

    // 停靠触发条(收起时的 3px 悬停条)与停靠所在显示器
    this.stripWindow = null;
    this.dockedDisplayId = null;
  }

  /** 从 store 恢复状态 */
  initFromStore() {
    const savedEdge = this.state.get('dockedEdge', undefined);
    if (savedEdge === undefined) {
      const legacy = this.state.get('dockPosition', null);
      if (legacy === 'right' || legacy === 'top-right') this.dockedEdge = 'right';
      else if (legacy === 'left' || legacy === 'top-left') this.dockedEdge = 'left';
      else this.dockedEdge = 'right';
      this.state.set('dockedEdge', this.dockedEdge);
      try { this.state.delete('dockPosition'); } catch {}
    } else {
      const valid = ['left', 'right', 'top'];
      this.dockedEdge = savedEdge === null ? null : (valid.includes(savedEdge) ? savedEdge : 'right');
    }

    const savedPct = this.state.get('windowWidthPercent', 20);
    const screenW = this.screen.getPrimaryDisplay().size.width;
    this.dockExpandedWidth = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, Math.round(screenW * savedPct / 100)));

    this.dockBounds = this.state.get('dockBounds', null);
    this.dockEdgeOffset = this.state.get('dockEdgeOffset', null);
    this.dockPinned = this.state.get('dockPinned', true);
    this.dockedDisplayId = this.state.get('dockDisplayId', null);
  }

  /** 停靠发生时所在的显示器(多屏时不跳屏);找不到回退主屏 */
  _getDockedDisplay() {
    const all = this.screen.getAllDisplays();
    return all.find((d) => d.id === this.dockedDisplayId) || this.screen.getPrimaryDisplay();
  }

  /**
   * 停靠触发条:Windows 强制窗口最小约 47x38,主窗口无法缩成 3px 细条
   * (transparent 窗口例外,可缩到 ~4px)。收起时主窗口移到屏幕外,
   * 用这个透明小窗当悬停触发条。
   */
  _ensureStrip() {
    if (this.stripWindow && !this.stripWindow.isDestroyed()) return this.stripWindow;
    const { BrowserWindow } = require('electron');
    const strip = new BrowserWindow({
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      width: 8,
      height: 8,
      webPreferences: { sandbox: true },
    });
    strip.setAlwaysOnTop(true, 'screen-saver');
    strip.setIgnoreMouseEvents(true); // 纯展示,悬停由轮询判定,不吃鼠标事件
    strip.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<html><body style="margin:0;height:100vh;background:rgba(0,120,212,0.45);border-radius:2px;"></body></html>'
    ));
    strip.on('closed', () => { if (this.stripWindow === strip) this.stripWindow = null; });
    this.stripWindow = strip;
    return strip;
  }

  destroyStrip() {
    if (this.stripWindow && !this.stripWindow.isDestroyed()) this.stripWindow.destroy();
    this.stripWindow = null;
  }

  /** 将窗口定位到 Dock 位置 */
  positionWindow(expanded) {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;

    this._suppressHint(200);

    if (this.dockedEdge === null) {
      this.destroyStrip();
      if (this.dockBounds) win.setBounds(this.dockBounds, false);
      return;
    }

    const display = this._getDockedDisplay();
    const { width: sw, height: sh } = display.size;
    const { x: bx, y: by } = display.bounds;
    const defaultH = Math.round(sh * DOCK_HEIGHT_RATIO);

    let x, y, w, h;

    if (this.dockedEdge === 'right' || this.dockedEdge === 'left') {
      w = this.dockExpandedWidth;
      h = this.dockEdgeOffset?.height ?? defaultH;
      h = Math.max(DOCK_MIN_HEIGHT, Math.min(sh, h));
      const defaultY = by + Math.round((sh - h) / 2);
      y = this.dockEdgeOffset?.y ?? defaultY;
      y = Math.max(by, Math.min(by + sh - h, y));
      x = this.dockedEdge === 'right' ? (bx + sw - w) : bx;
    } else if (this.dockedEdge === 'top') {
      const storedW = this.dockEdgeOffset?.width ?? this.dockExpandedWidth;
      w = Math.max(DOCK_MIN_WIDTH, Math.min(sw, storedW));
      h = Math.max(DOCK_MIN_HEIGHT, Math.min(sh, this.dockEdgeOffset?.height ?? defaultH));
      const defaultX = bx + Math.round((sw - w) / 2);
      x = this.dockEdgeOffset?.x ?? defaultX;
      x = Math.max(bx, Math.min(bx + sw - w, x));
      y = by;
    }

    if (expanded) {
      this.destroyStrip();
      win.setBounds({ x, y, width: w, height: h }, true);
      return;
    }

    // 收起:显示 3px 触发条,主窗口直接 hide()。
    // 不把主窗口缩成细条(Windows 强制最小 ~47x38),也不移到屏幕外——
    // 移出屏幕会落到别的显示器上,且窗口 DPI 跟着那块屏走,
    // 再 setBounds 回来尺寸会被另一个缩放比解释,展开后窗口变大。
    let stripRect;
    if (this.dockedEdge === 'right') stripRect = { x: bx + sw - DOCK_EDGE_WIDTH, y, width: DOCK_EDGE_WIDTH, height: h };
    else if (this.dockedEdge === 'left') stripRect = { x: bx, y, width: DOCK_EDGE_WIDTH, height: h };
    else stripRect = { x, y: by, width: w, height: DOCK_EDGE_WIDTH };

    const strip = this._ensureStrip();
    strip.setBounds(stripRect);
    strip.showInactive();
    win.hide();
  }

  expand(reason) {
    if (this.dockExpandTimer) { clearTimeout(this.dockExpandTimer); this.dockExpandTimer = null; }
    if (this.dockExpanded) return;
    console.log(`[Dock] 展开 (${reason})`);
    this.dockExpanded = true;
    clearTimeout(this.dockHideTimer); this.dockHideTimer = null;
    clearTimeout(this.dockGraceTimer);

    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(false);
      this.positionWindow(true);
      win.show();
      win.focus();
      win.webContents.send('dock:state-changed', { expanded: true, pinned: this.dockPinned });
    }

    this.dockGraceTimer = setTimeout(() => { this.dockGraceTimer = null; }, DOCK_GRACE_PERIOD);
  }

  collapse(reason) {
    if (this.dockExpandTimer) { clearTimeout(this.dockExpandTimer); this.dockExpandTimer = null; }
    if (!this.dockExpanded) return;
    if (this.dockPinned) return;
    if (this.dockedEdge === null) return;
    console.log(`[Dock] 收起 (${reason})`);
    this.dockExpanded = false;
    clearTimeout(this.dockHideTimer); this.dockHideTimer = null;

    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('dock:state-changed', { expanded: false, pinned: this.dockPinned });
    }

    setTimeout(() => {
      if (!this.dockExpanded) this.positionWindow(false);
    }, 250);
  }

  scheduleExpand(reason) {
    if (this.dockExpandTimer) return;
    if (this.dockExpanded) return;
    if (this.dockedEdge === null || this.dockPinned) return;
    this.dockExpandTimer = setTimeout(() => {
      this.dockExpandTimer = null;
      this.expand(reason);
    }, DOCK_EXPAND_DELAY);
  }

  startMouseTracking() {
    if (this.dockMouseTimer) return;
    this.dockMouseTimer = setInterval(() => {
      const win = this.getMainWindow();
      if (!win || win.isDestroyed()) return;
      if (this.dockedEdge === null || this.dockPinned) {
        if (this.dockExpandTimer) { clearTimeout(this.dockExpandTimer); this.dockExpandTimer = null; }
        return;
      }

      const cursor = this.screen.getCursorScreenPoint();
      // 收起时悬停目标是触发条(主窗口在屏幕外),展开时是主窗口
      const tracked = (!this.dockExpanded && this.stripWindow && !this.stripWindow.isDestroyed())
        ? this.stripWindow
        : win;
      const bounds = tracked.getBounds();

      const inHotZone = !this.dockExpanded && (
        cursor.x >= bounds.x - DOCK_HOT_ZONE_WIDTH &&
        cursor.x <= bounds.x + bounds.width + DOCK_HOT_ZONE_WIDTH &&
        cursor.y >= bounds.y - DOCK_HOT_ZONE_WIDTH &&
        cursor.y <= bounds.y + bounds.height + DOCK_HOT_ZONE_WIDTH
      );

      const inExpandedWindow = this.dockExpanded && (
        cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width &&
        cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
      );

      const inZone = inHotZone || inExpandedWindow;

      if (inZone) {
        if (this.dockExpanded) {
          if (this.dockExpandTimer) { clearTimeout(this.dockExpandTimer); this.dockExpandTimer = null; }
        } else {
          this.scheduleExpand('贴边 0.8s');
        }
      } else {
        if (this.dockExpandTimer) { clearTimeout(this.dockExpandTimer); this.dockExpandTimer = null; }
        if (this.dockExpanded && !this.dockGraceTimer) {
          this.collapse('鼠标离开');
        }
      }
    }, 120);
  }

  stopMouseTracking() {
    clearInterval(this.dockMouseTimer);
    this.dockMouseTimer = null;
  }

  /** 拖动中：计算 snap-hint */
  handleWindowMove() {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    if (this.suppressMoveHint || this.dockedEdge !== null) {
      if (this.lastSnapHintEdge !== undefined && this.lastSnapHintEdge !== null) {
        this.lastSnapHintEdge = null;
        win.webContents.send('dock:snap-hint', { edge: null });
      }
      return;
    }

    const b = win.getBounds();
    const d = this.getEdgeDistances(b);
    const hintEdge = this.pickSnapEdge(d);

    if (hintEdge !== this.lastSnapHintEdge) {
      this.lastSnapHintEdge = hintEdge;
      win.webContents.send('dock:snap-hint', { edge: hintEdge });
    }
  }

  /** 拖动结束：边缘吸附判定 */
  handleWindowMoved() {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const d = this.getEdgeDistances(b);
    const targetEdge = this.pickSnapEdge(d);

    this.lastSnapHintEdge = undefined;
    win.webContents.send('dock:snap-hint', { edge: null });

    if (targetEdge !== null) {
      this.dockedEdge = targetEdge;
      // 记录吸附发生时的显示器,positionWindow 用它定位(不再固定主屏)
      const display = this.screen.getDisplayMatching(b);
      this.dockedDisplayId = display.id;
      this.state.set('dockDisplayId', display.id);
      if (targetEdge === 'right' || targetEdge === 'left') {
        this.dockEdgeOffset = { y: b.y, height: b.height };
        this.dockExpandedWidth = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, b.width));
        this.state.set('windowWidthPercent', Math.round((this.dockExpandedWidth / this.screen.getPrimaryDisplay().size.width) * 100));
      } else {
        this.dockEdgeOffset = { x: b.x, width: b.width, height: b.height };
      }
      this.state.set('dockedEdge', targetEdge);
      this.state.set('dockEdgeOffset', this.dockEdgeOffset);
      win.setResizable(false);
      this.dockExpanded = true;
      this.positionWindow(true);
      win.webContents.send('dock:edge-changed', { dockedEdge: targetEdge, dockBounds: null });
      win.webContents.send('dock:state-changed', { expanded: true, pinned: this.dockPinned });
    } else {
      this.dockedEdge = null;
      this.dockBounds = b;
      this.state.set('dockedEdge', null);
      this.state.set('dockBounds', b);
      win.setResizable(true);
      this.dockExpanded = true;
      if (this.dockExpandTimer) { clearTimeout(this.dockExpandTimer); this.dockExpandTimer = null; }
      win.webContents.send('dock:edge-changed', { dockedEdge: null, dockBounds: b });
      win.webContents.send('dock:state-changed', { expanded: true, pinned: this.dockPinned });
    }
    this.lastHandleWindowMovedTime = Date.now();
  }

  getEdgeDistances(bounds) {
    const display = this.screen.getDisplayMatching(bounds);
    const sb = display.bounds;
    return {
      dLeft: bounds.x - sb.x,
      dRight: (sb.x + sb.width) - (bounds.x + bounds.width),
      dTop: bounds.y - sb.y,
    };
  }

  pickSnapEdge({ dLeft, dRight, dTop }) {
    const minD = Math.min(dLeft, dRight, dTop);
    if (minD > DOCK_SNAP_THRESHOLD) return null;
    if (minD === dLeft) return 'left';
    if (minD === dRight) return 'right';
    return 'top';
  }

  clampFloatingBounds(b) {
    let { x, y, width, height } = b;
    const screenH = this.screen.getPrimaryDisplay().workAreaSize.height;
    width = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, width));
    height = Math.max(DOCK_MIN_HEIGHT, Math.min(screenH, height));
    const ratio = height / width;
    if (ratio < DOCK_RATIO_MIN) height = Math.round(width * DOCK_RATIO_MIN);
    if (ratio > DOCK_RATIO_MAX) height = Math.round(width * DOCK_RATIO_MAX);
    return { x, y, width, height };
  }

  /** 获取窗口初始 bounds */
  getInitialBounds() {
    const display = this._getDockedDisplay();
    const { width: sw, height: sh } = display.size;
    const { x: bx, y: by } = display.bounds;
    const defaultH = Math.round(sh * DOCK_HEIGHT_RATIO);

    let x, y, w, h;
    if (this.dockedEdge === null && this.dockBounds) {
      ({ x, y, width: w, height: h } = this.dockBounds);
    } else if (this.dockedEdge === 'left' || this.dockedEdge === 'right') {
      w = this.dockExpandedWidth;
      h = this.dockEdgeOffset?.height ?? defaultH;
      h = Math.max(DOCK_MIN_HEIGHT, Math.min(sh, h));
      const centerY = by + Math.round((sh - h) / 2);
      y = this.dockEdgeOffset?.y ?? centerY;
      y = Math.max(by, Math.min(by + sh - h, y));
      x = this.dockedEdge === 'left' ? bx : (bx + sw - w);
    } else if (this.dockedEdge === 'top') {
      const storedW = this.dockEdgeOffset?.width ?? this.dockExpandedWidth;
      w = Math.max(DOCK_MIN_WIDTH, Math.min(sw, storedW));
      h = defaultH;
      const centerX = bx + Math.round((sw - w) / 2);
      x = this.dockEdgeOffset?.x ?? centerX;
      x = Math.max(bx, Math.min(bx + sw - w, x));
      y = by;
    } else {
      this.dockedEdge = 'right';
      w = this.dockExpandedWidth;
      h = defaultH;
      x = bx + sw - w;
      y = by + Math.round((sh - h) / 2);
    }
    return { x, y, width: w, height: h };
  }

  _suppressHint(ms) {
    this.suppressMoveHint = true;
    if (this.suppressMoveHintTimer) clearTimeout(this.suppressMoveHintTimer);
    this.suppressMoveHintTimer = setTimeout(() => { this.suppressMoveHint = false; }, ms);
  }

  getState() {
    return {
      expanded: this.dockExpanded,
      pinned: this.dockPinned,
      dockedEdge: this.dockedEdge,
      dockBounds: this.dockBounds,
    };
  }
}

module.exports = { DockManager };
