/**
 * 网页链接预览 IPC Handlers
 */

const { ipcMain } = require('electron');
const crypto = require('crypto');
const { cleanupLinkCache, fetchPage, fetchRenderedTitle } = require('../utils/link-preview');

function registerLinkPreviewIpcHandlers({ storeManager }) {
  ipcMain.handle('fetch-link-preview', async (_event, url) => {
    const cacheKey = crypto.createHash('md5').update(url).digest('hex');
    const cached = storeManager.get(`linkCache.${cacheKey}`, null);
    if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
      return { ...cached, cached: true };
    }
    const timeoutResult = { title: null, favicon: null, description: null, source: 'timeout', error: 'TIMEOUT' };
    try {
      const result = await Promise.race([
        fetchPage(url),
        new Promise(resolve => setTimeout(() => resolve(timeoutResult), 3000)),
      ]);
      if (result.title && !result.error) {
        storeManager.set(`linkCache.${cacheKey}`, { ...result, timestamp: Date.now() });
      }
      if (Math.random() < 0.1) cleanupLinkCache(storeManager);
      return result;
    } catch {
      return timeoutResult;
    }
  });

  ipcMain.handle('fetch-rendered-title', async (_event, url) => {
    const cacheKey = crypto.createHash('md5').update(`render:${url}`).digest('hex');
    const cached = storeManager.get(`linkCache.${cacheKey}`, null);
    if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
      return { ...cached, cached: true };
    }
    const result = await fetchRenderedTitle(url);
    if (result.title) {
      storeManager.set(`linkCache.${cacheKey}`, { ...result, timestamp: Date.now() });
    }
    return result;
  });
}

module.exports = { registerLinkPreviewIpcHandlers };
