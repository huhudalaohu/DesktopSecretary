/**
 * screenshot-overlay.js — 截图 overlay 渲染逻辑
 *
 * 纯 Canvas + DOM 实现，无需 React。
 * 功能：
 *   1. 显示全屏截图背景 + 暗色遮罩
 *   2. 自动红框高亮检测到的前台窗口
 *   3. 用户按 Enter 确认 / Esc 取消 / 鼠标拖拽自定义选区
 */

const api = window.desktopAPI;

// ========== 状态 ==========
let mode = 'detected';       // detected | dragging | custom
let windowRect = null;       // 检测到的窗口 rect（虚拟屏幕坐标）
let customRect = null;       // 用户拖拽选区（虚拟屏幕坐标）
let dragStart = null;        // 拖拽起始点（窗口本地坐标）
let virtualBounds = null;    // 虚拟屏幕边界
let primaryDisplay = null;   // 主显示器信息

// ========== 初始化 ==========
api.onScreenshotStart((data) => {
  windowRect = data.windowRect;
  virtualBounds = data.virtualBounds;
  primaryDisplay = data.primaryDisplay;

  // 设置截图背景
  const bg = document.getElementById('screenshot-bg');
  bg.src = data.dataUrl;

  // 延迟一帧等待图片加载后绘制
  requestAnimationFrame(() => {
    drawOverlay();
  });
});

// 异步更新前台窗口高亮框
if (window.desktopAPI && window.desktopAPI.onScreenshotUpdateWindowRect) {
  window.desktopAPI.onScreenshotUpdateWindowRect((rect) => {
    windowRect = rect;
    drawOverlay();
  });
}

// ========== 绘制 ==========
function getActiveRect() {
  if (mode === 'custom' || mode === 'dragging') return customRect;
  return windowRect;
}

function drawOverlay() {
  const canvas = document.getElementById('overlay-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const rect = getActiveRect();

  // 全屏暗色遮罩
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!rect) return;

  // 虚拟屏幕坐标 → 窗口本地坐标
  const localX = rect.left - virtualBounds.x;
  const localY = rect.top - virtualBounds.y;
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;

  if (w < 1 || h < 1) return;

  // 镂空选区（让截图背景完全可见）
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0, 0, 0, 1)';
  ctx.fillRect(localX, localY, w, h);

  // 恢复绘制模式
  ctx.globalCompositeOperation = 'source-over';

  // 红色边框
  ctx.strokeStyle = '#ff3b30';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(localX + 0.5, localY + 0.5, w - 1, h - 1);

  // 四角 handle 指示可拖拽
  const handleSize = 6;
  ctx.fillStyle = '#ff3b30';
  const corners = [
    [localX, localY],
    [localX + w - handleSize, localY],
    [localX, localY + h - handleSize],
    [localX + w - handleSize, localY + h - handleSize],
  ];
  for (const [cx, cy] of corners) {
    ctx.fillRect(cx, cy, handleSize, handleSize);
  }

  // 尺寸标签
  const label = `${w} x ${h}`;
  ctx.font = '12px "Microsoft YaHei", system-ui, sans-serif';
  const tm = ctx.measureText(label);
  const labelW = tm.width + 14;
  const labelH = 22;
  let labelX = localX;
  let labelY = localY - labelH - 4;
  // 防止标签超出顶部
  if (labelY < 0) labelY = localY + h + 4;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelW, labelH, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(label, labelX + 7, labelY + 15);

  // 窗口标题（如果有的话）
  if (mode === 'detected' && windowRect && windowRect.title) {
    const title = windowRect.title.length > 30
      ? windowRect.title.slice(0, 30) + '...'
      : windowRect.title;
    ctx.font = '11px "Microsoft YaHei", system-ui, sans-serif';
    const tm2 = ctx.measureText(title);
    const titleW = tm2.width + 14;
    const titleH = 20;
    const titleX = localX + w - titleW;
    const titleY = localY - titleH - 4;
    if (titleY >= 0 && titleX >= 0) {
      ctx.fillStyle = 'rgba(255, 59, 48, 0.8)';
      ctx.beginPath();
      ctx.roundRect(titleX, titleY, titleW, titleH, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(title, titleX + 7, titleY + 14);
    }
  }
}

// ========== 鼠标事件 ==========
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // 仅左键
  mode = 'dragging';
  dragStart = { x: e.clientX, y: e.clientY };
  customRect = null;
  drawOverlay();
});

document.addEventListener('mousemove', (e) => {
  if (mode !== 'dragging' || !dragStart) return;

  const x1 = Math.min(dragStart.x, e.clientX) + virtualBounds.x;
  const y1 = Math.min(dragStart.y, e.clientY) + virtualBounds.y;
  const x2 = Math.max(dragStart.x, e.clientX) + virtualBounds.x;
  const y2 = Math.max(dragStart.y, e.clientY) + virtualBounds.y;

  customRect = { left: x1, top: y1, right: x2, bottom: y2 };
  drawOverlay();
});

document.addEventListener('mouseup', () => {
  if (mode === 'dragging') {
    dragStart = null;
    // 拖拽太小则回退到检测窗口
    if (customRect) {
      const w = customRect.right - customRect.left;
      const h = customRect.bottom - customRect.top;
      if (w < 10 || h < 10) {
        customRect = null;
        mode = 'detected';
      } else {
        mode = 'custom';
      }
    } else {
      mode = 'detected';
    }
    drawOverlay();
  }
});

// ========== 键盘事件 ==========
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    api.screenshotCancel();
  } else if (e.key === 'Enter') {
    const rect = getActiveRect();
    if (!rect) return;
    api.screenshotCrop({
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    });
  }
});
