/**
 * 图片压缩工具(多模态 AI 请求用)。
 *
 * CloudBase HTTP 触发器有请求体上限(EXCEED_MAX_PAYLOAD_SIZE,约 6MB),
 * 整张截图的 PNG base64 很容易超限(4.5MB PNG → 6MB+ base64)。
 * 这里在发送前把图片缩到多模态模型够用的尺寸并转 JPEG:
 *   - 视觉模型内部本身就会把图片降采样到 ~1568px 级别,再大没有收益
 *   - JPEG 对屏幕截图(文字为主)在 0.8 质量下依然清晰可读
 */

// 逐级降档的压缩档位: [最长边, JPEG 质量]
const COMPRESS_STEPS = [
  [1568, 0.85],
  [1568, 0.6],
  [1120, 0.6],
  [800, 0.5],
];

// base64 目标上限(留足 JSON 包装和触发器余量)
const MAX_BASE64_LEN = 3 * 1024 * 1024;

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

function drawToJpeg(img, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // JPEG 无透明通道,先铺白底避免透明区域变黑
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * 把 dataURL 图片压缩到可安全通过 CloudBase 触发器的大小。
 * 输入输出都是 dataURL;已是小图也会统一转成 JPEG(体积更小)。
 *
 * @param {string} dataUrl 原始图片 dataURL(通常是 PNG)
 * @returns {Promise<string>} 压缩后的 JPEG dataURL
 */
export async function compressImageDataUrl(dataUrl) {
  const img = await loadImage(dataUrl);
  let out = '';
  for (const [maxDim, quality] of COMPRESS_STEPS) {
    out = drawToJpeg(img, maxDim, quality);
    // dataURL 前缀开销很小,直接比较总长度即可
    if (out.length <= MAX_BASE64_LEN) return out;
  }
  return out;
}
