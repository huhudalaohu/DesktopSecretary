export function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

export function hashDataUrl(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return base64.slice(0, 200);
}
