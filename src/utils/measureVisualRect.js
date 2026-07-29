/**
 * measureVisualRect.js — 测量元素的可视坐标(相对视口)
 *
 * 为什么要这个函数:App 内容包在 style.zoom=fontScale 的容器里(App.jsx),
 * 而 Electron 的 Chromium 对 zoom 容器【内部】元素的 getBoundingClientRect
 * 返回「未缩放」坐标(老 Chromium 的 zoom bug,新版已修复)。
 * 直接用 rect 做 fixed 定位,在 fontScale≠1 时会整体偏移,且随窗口拉伸越来越歪。
 *
 * 实测结论(2026-07,Electron Chromium 带 bug 版本):
 *   bug 下 rect 就是可视坐标 / zoom 的均匀缩放(原点都是视口左上角),
 *   包括滚动的影响也在同一个缩放坐标系里。
 *   所以修复只需要:visual = raw × zoom。offset 链换算是多余的,
 *   而且 offsetParent 跳级不可控(会跳过 zoom 容器直达 BODY),不可靠。
 *
 * 探测:rect.width ≈ offsetWidth × zoom 说明内核已修复,直接用 raw rect。
 *
 * 使用方:OnboardingTutorial(聚光灯高亮)、FolderCascadeMenu(级联弹窗定位)。
 * 注意:用本坐标做 fixed 定位的元素必须渲染在 zoom 容器【之外】
 * (如 portal 到 document.body),否则坐标会再被 zoom 缩放一次。
 */
export function measureVisualRect(el) {
  const r = el.getBoundingClientRect();
  const fallback = { left: r.left, top: r.top, width: r.width, height: r.height };

  let zoom = 1;
  for (let n = el.parentElement; n; n = n.parentElement) {
    const zv = parseFloat(n.style && n.style.zoom);
    if (zv && zv !== 1) { zoom = zv; break; }
  }
  if (zoom === 1) return fallback;

  // 内核已修复(rect 已缩放)→ 直接用
  if (Math.abs(r.width - el.offsetWidth * zoom) < 2) return fallback;

  // 未缩放 bug:可视坐标 = raw × zoom(实测均匀缩放,见文件头注释)
  return {
    left: r.left * zoom,
    top: r.top * zoom,
    width: r.width * zoom,
    height: r.height * zoom,
  };
}
