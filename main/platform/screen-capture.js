/**
 * 屏幕捕获抽象
 *
 * 主实现: node-screenshots (napi-rs + Rust xcap)
 *   - 对 3840x2160 主屏: captureImageSync ~110ms, toPngSync ~35ms（远快于 desktopCapturer + toDataURL）
 *   - Image 提供 .width/.height 属性、.cropSync(x,y,w,h)、.toPngSync(true)/.toJpegSync(true)
 *   - Electron 必须传 copyOutputData=true，否则可能崩
 *   - macOS 需要屏幕录制权限（由上层 permissions 层确保）
 *
 * 降级: Electron desktopCapturer（生成 NativeImage）
 *   - 适用于 node-screenshots 二进制加载失败或权限问题
 *
 * 对外返回的 CaptureSource 形状:
 *   {
 *     displayId: string,
 *     bounds: { x, y, width, height },     // 虚拟屏幕坐标(DIP)
 *     scaleFactor: number,
 *     toDataUrl(): string,                 // PNG dataUrl（overlay 显示用）
 *     toBuffer(format?: 'png'|'jpeg'): Buffer,  // 用于后续 Blob URL / IPC
 *     crop(rect): CroppedImage,            // 像素坐标裁剪，返回同样带 toDataUrl/toBuffer 的对象
 *     engine: 'node-screenshots' | 'desktop-capturer',
 *   }
 */

const { desktopCapturer, screen } = require('electron');
const isMac = process.platform === 'darwin';

let nsModule = null;
let nsLoadAttempted = false;

function tryLoadNodeScreenshots() {
  if (nsLoadAttempted) return nsModule;
  nsLoadAttempted = true;
  try {
    nsModule = require('node-screenshots');
  } catch (err) {
    console.warn('[ScreenCapture] node-screenshots 加载失败，将使用 desktopCapturer:', err.message);
    nsModule = null;
  }
  return nsModule;
}

// 启动即预加载（napi 绑定 + 符号解析）
tryLoadNodeScreenshots();

// ========== node-screenshots 包装 ==========

/**
 * 把 node-screenshots 的 Image 包成统一对外接口
 */
function wrapNsImage(img) {
  if (!img) return null;
  return {
    engine: 'node-screenshots',
    width: img.width,
    height: img.height,
    _raw: img,
    toDataUrl() {
      const buf = img.toPngSync(true);
      return `data:image/png;base64,${buf.toString('base64')}`;
    },
    toBuffer(format = 'png') {
      if (format === 'jpeg' || format === 'jpg') return img.toJpegSync(true);
      return img.toPngSync(true);
    },
    crop(rect) {
      const { x, y, width, height } = rect;
      const sub = img.cropSync(
        Math.max(0, Math.round(x)),
        Math.max(0, Math.round(y)),
        Math.max(1, Math.round(width)),
        Math.max(1, Math.round(height)),
      );
      return wrapNsImage(sub);
    },
  };
}

/**
 * 把 node-screenshots 的 Monitor 包成 CaptureSource
 */
function wrapNsMonitor(monitor) {
  const mX = monitor.x();
  const mY = monitor.y();
  const mW = monitor.width();
  const mH = monitor.height();
  const mScale = monitor.scaleFactor();
  const mId = monitor.id();

  // 匹配到 Electron Display —— 优先按 id，再按 bounds（Electron 的 Display.id 是 uint32，xcap 也是数值）
  const electronDisplay = matchElectronDisplay({ id: mId, x: mX, y: mY, width: mW, height: mH });
  // DIP bounds（node-screenshots 在 Win/Mac 返回的是 DIP，width/height 是逻辑尺寸）
  // 在 Windows 下经验验证: Monitor.width() 返回 DIP（例如 2560 @ 1.5x 实际像素 3840）
  // 不过 Rust xcap 行为因平台而异，保险起见直接用 Electron display 的 bounds 覆盖
  const bounds = electronDisplay
    ? { x: electronDisplay.bounds.x, y: electronDisplay.bounds.y, width: electronDisplay.bounds.width, height: electronDisplay.bounds.height }
    : { x: mX, y: mY, width: mW, height: mH };
  const scaleFactor = electronDisplay ? electronDisplay.scaleFactor : mScale;
  const displayId = electronDisplay ? String(electronDisplay.id) : String(mId);

  // 截图（同步，主进程可接受 ~110ms）
  const img = monitor.captureImageSync();
  const wrapped = wrapNsImage(img);

  return {
    displayId,
    bounds,
    scaleFactor,
    engine: 'node-screenshots',
    isPrimary: electronDisplay ? electronDisplay.id === screen.getPrimaryDisplay().id : monitor.isPrimary(),
    toDataUrl: () => wrapped.toDataUrl(),
    toBuffer: (format) => wrapped.toBuffer(format),
    crop: (rect) => wrapped.crop(rect),
    // 内部数据，外部一般不用
    _image: wrapped,
    _rawMonitor: monitor,
  };
}

function matchElectronDisplay({ id, x, y, width, height }) {
  const displays = screen.getAllDisplays();
  // 先按 id 匹配
  const byId = displays.find((d) => String(d.id) === String(id));
  if (byId) return byId;
  // 再按 bounds 匹配（允许 1px 容差）
  const byBounds = displays.find((d) =>
    Math.abs(d.bounds.x - x) <= 2 &&
    Math.abs(d.bounds.y - y) <= 2 &&
    Math.abs(d.bounds.width - width) <= 2 &&
    Math.abs(d.bounds.height - height) <= 2
  );
  if (byBounds) return byBounds;
  // 按 bounds 的起点（左上角）匹配
  const byOrigin = displays.find((d) =>
    Math.abs(d.bounds.x - x) <= 2 && Math.abs(d.bounds.y - y) <= 2
  );
  return byOrigin || null;
}

// ========== desktopCapturer 包装（fallback） ==========

/**
 * 把 NativeImage 包成统一接口
 */
function wrapNativeImage(nativeImage) {
  if (!nativeImage) return null;
  const size = nativeImage.getSize();
  return {
    engine: 'desktop-capturer',
    width: size.width,
    height: size.height,
    _raw: nativeImage,
    toDataUrl() {
      return nativeImage.toDataURL();
    },
    toBuffer(format = 'png') {
      if (format === 'jpeg' || format === 'jpg') return nativeImage.toJPEG(85);
      return nativeImage.toPNG();
    },
    crop(rect) {
      const sub = nativeImage.crop({
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
      return wrapNativeImage(sub);
    },
  };
}

async function captureAllScreensDC() {
  const displays = screen.getAllDisplays();
  let maxW = 0, maxH = 0;
  for (const d of displays) {
    const w = d.size.width * d.scaleFactor;
    const h = d.size.height * d.scaleFactor;
    if (w > maxW) maxW = w;
    if (h > maxH) maxH = h;
  }
  const thumbnailSize = { width: Math.max(maxW, 1920), height: Math.max(maxH, 1080) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });

  return sources.map((s) => {
    const d = displays.find((x) => String(x.id) === String(s.display_id)) || displays[0];
    const wrapped = wrapNativeImage(s.thumbnail);
    return {
      displayId: String(s.display_id || d.id),
      bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
      scaleFactor: d.scaleFactor,
      engine: 'desktop-capturer',
      isPrimary: d.id === screen.getPrimaryDisplay().id,
      toDataUrl: () => wrapped.toDataUrl(),
      toBuffer: (format) => wrapped.toBuffer(format),
      crop: (rect) => wrapped.crop(rect),
      _image: wrapped,
      _rawNativeImage: s.thumbnail,
    };
  });
}

// ========== 对外接口 ==========

/**
 * 抓取所有屏幕，返回 CaptureSource[]
 */
async function captureAllScreens() {
  const ns = tryLoadNodeScreenshots();
  if (ns && ns.Monitor && typeof ns.Monitor.all === 'function') {
    try {
      const monitors = ns.Monitor.all();
      if (monitors && monitors.length > 0) {
        const results = monitors.map(wrapNsMonitor);
        return results;
      }
      console.warn('[ScreenCapture] node-screenshots Monitor.all() 返回空，降级 desktopCapturer');
    } catch (err) {
      console.warn('[ScreenCapture] node-screenshots 截屏失败，降级 desktopCapturer:', err.message);
    }
  }
  return captureAllScreensDC();
}

/**
 * 抓取主屏，返回 { source, sources, primaryDisplay }
 */
async function capturePrimaryScreen() {
  const sources = await captureAllScreens();
  const primaryDisplay = screen.getPrimaryDisplay();
  let primary = sources.find((s) => s.displayId === String(primaryDisplay.id));
  if (!primary) primary = sources.find((s) => s.isPrimary);
  if (!primary) primary = sources[0];
  return { source: primary, sources, primaryDisplay };
}

module.exports = {
  captureAllScreens,
  capturePrimaryScreen,
  // 内部工具导出方便测试
  _internal: { wrapNsImage, wrapNativeImage, matchElectronDisplay },
};
