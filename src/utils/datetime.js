/**
 * 将 AI 返回的 deadline 字符串解析为时间戳
 * 支持格式：YYYY-MM-DD HH:mm 或 YYYY-MM-DD（默认补 09:00）
 */
export function parseDeadlineToTimestamp(deadlineStr) {
  if (!deadlineStr || deadlineStr === '尽快') return null;
  const trimmed = deadlineStr.trim();
  // 匹配 YYYY-MM-DD HH:mm
  const fullMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (fullMatch) {
    const [, y, m, d, h, min] = fullMatch;
    const ts = new Date(`${y}-${m}-${d}T${h}:${min}:00`).getTime();
    return isNaN(ts) ? null : ts;
  }
  // 匹配 YYYY-MM-DD，默认补 09:00
  const dateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    const ts = new Date(`${y}-${m}-${d}T09:00:00`).getTime();
    return isNaN(ts) ? null : ts;
  }
  return null;
}
