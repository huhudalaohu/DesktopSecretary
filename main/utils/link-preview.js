/**
 * 链接预览工具
 * 抓取网页 OG 元数据、解析标题、处理 CSR 站点
 */

const { BrowserWindow } = require('electron');
const https = require('https');
const http = require('http');
const { sleep } = require('./common');

// fetchRenderedTitle 并发锁
let renderedTitleLock = false;

/** 清理过期的 linkCache（网页元数据缓存，24h 过期） */
function cleanupLinkCache(store) {
  try {
    const now = Date.now();
    const allCache = store.get('linkCache', {});
    let removed = 0;
    for (const [key, entry] of Object.entries(allCache)) {
      if (now - entry.timestamp > 24 * 60 * 60 * 1000) {
        delete allCache[key];
        removed++;
      }
    }
    if (removed > 0) {
      store.set('linkCache', allCache);
      console.log(`[Cleanup] linkCache 清理完成，移除 ${removed} 条过期缓存`);
    }
  } catch (err) {
    console.error('[Cleanup] linkCache 清理失败:', err);
  }
}

/**
 * 抓取网页并解析 OG 元数据
 * 返回 { title, favicon, description, source, error? }
 */
function fetchPage(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    let req = null;
    const timeout = setTimeout(() => {
      if (req) req.destroy();
      resolve({ title: null, favicon: null, description: null, source: 'timeout', error: 'TIMEOUT' });
    }, 3000);

    req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 2000,
    }, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        res.destroy();
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchPage(redirectUrl).then(resolve);
        return;
      }

      // 错误状态处理
      if (res.statusCode === 401 || res.statusCode === 403) {
        clearTimeout(timeout);
        res.destroy();
        resolve({ title: null, favicon: null, description: null, source: 'error', error: 'need_login' });
        return;
      }
      if (res.statusCode === 404) {
        clearTimeout(timeout);
        res.destroy();
        resolve({ title: null, favicon: null, description: null, source: 'error', error: 'not_found' });
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        res.destroy();
        resolve({ title: null, favicon: null, description: null, source: 'error', error: `http_${res.statusCode}` });
        return;
      }

      let data = '';
      let received = 0;
      let responseSettled = false;
      function safeResolve(value) {
        if (!responseSettled) {
          responseSettled = true;
          clearTimeout(timeout);
          resolve(value);
        }
      }
      res.on('data', (chunk) => {
        received += chunk.length;
        data += chunk.toString();
        // 只读前 10KB，拿到 <head> 就够了
        if (received > 10240) {
          // 先解析并 resolve，再 destroy；否则 end 事件不会触发导致 Promise 挂起
          safeResolve(parseMeta(data, url));
          res.destroy();
        }
      });
      res.on('end', () => {
        // 反爬检测：HTML 太短且含验证码关键词
        if (data.length < 500 && /验证|captcha|verify/i.test(data)) {
          safeResolve({ title: null, favicon: null, description: null, source: 'error', error: 'captcha' });
          return;
        }
        safeResolve(parseMeta(data, url));
      });
      res.on('error', () => {
        safeResolve({ title: null, favicon: null, description: null, source: 'error' });
      });
      res.on('close', () => {
        // 兜底：如果 data 事件里已 resolve，这里不会重复执行
        safeResolve(parseMeta(data, url));
      });
    });
    req.on('error', () => {
      clearTimeout(timeout);
      resolve({ title: null, favicon: null, description: null, source: 'error' });
    });
    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      resolve({ title: null, favicon: null, description: null, source: 'error' });
    });
  });
}

/** 解析 HTML 中的 OG 元标签（增强版：支持微信、知乎、掘金等特殊结构） */
function parseMeta(html, baseUrl) {
  // 优先级：og:title > twitter:title > 特殊站点规则 > <title>
  let title = null;
  let source = 'og-meta';

  const ogTitle = html.match(/<meta[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i);
  if (ogTitle) {
    title = decodeHtml(ogTitle[1]);
  }

  if (!title) {
    const twitterTitle = html.match(/<meta[^>]*name\s*=\s*["']twitter:title["'][^>]*content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']twitter:title["']/i);
    if (twitterTitle) {
      title = decodeHtml(twitterTitle[1]);
    }
  }

  // 特殊站点规则（微信、知乎、掘金、CSDN 等）
  if (!title) {
    // 微信文章：rich_media_title / activity_name
    const wxTitle = html.match(/<h2[^>]*class\s*=\s*["'][^"]*rich_media_title["'][^>]*>([\s\S]*?)<\/h2>/i)
      || html.match(/<div[^>]*id\s*=\s*["']activity_name["'][^>]*>([\s\S]*?)<\/div>/i);
    if (wxTitle) {
      title = decodeHtml(wxTitle[1].replace(/<[^>]+>/g, '').trim());
      source = 'og-meta';
    }
    // 知乎：Post-Title / h1.Title
    if (!title) {
      const zhTitle = html.match(/<h1[^>]*class\s*=\s*["'][^"]*Post-Title["'][^>]*>([\s\S]*?)<\/h1>/i)
        || html.match(/<h1[^>]*class\s*=\s*["'][^"]*Title["'][^>]*>([\s\S]*?)<\/h1>/i);
      if (zhTitle) {
        title = decodeHtml(zhTitle[1].replace(/<[^>]+>/g, '').trim());
        source = 'og-meta';
      }
    }
    // 掘金：article-title
    if (!title) {
      const jjTitle = html.match(/<h1[^>]*class\s*=\s*["'][^"]*article-title["'][^>]*>([\s\S]*?)<\/h1>/i);
      if (jjTitle) {
        title = decodeHtml(jjTitle[1].replace(/<[^>]+>/g, '').trim());
        source = 'og-meta';
      }
    }
    // CSDN：title / article-title
    if (!title) {
      const csdnTitle = html.match(/<h1[^>]*class\s*=\s*["'][^"]*title-article["'][^>]*>([\s\S]*?)<\/h1>/i)
        || html.match(/<span[^>]*class\s*=\s*["'][^"]*article-title["'][^>]*>([\s\S]*?)<\/span>/i);
      if (csdnTitle) {
        title = decodeHtml(csdnTitle[1].replace(/<[^>]+>/g, '').trim());
        source = 'og-meta';
      }
    }
  }

  if (!title) {
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag && titleTag[1].trim()) {
      title = decodeHtml(titleTag[1].trim());
    }
  }

  // og:image
  let favicon = null;
  const ogImage = html.match(/<meta[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i);
  if (ogImage) {
    favicon = ogImage[1];
  }

  // <link rel="icon">
  if (!favicon) {
    const linkIcon = html.match(/<link[^>]*rel\s*=\s*["'](?:shortcut )?icon["'][^>]*href\s*=\s*["']([^"']+)["']/i);
    if (linkIcon) {
      favicon = new URL(linkIcon[1], baseUrl).href;
    }
  }

  // og:description
  let description = null;
  const ogDesc = html.match(/<meta[^>]*property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:description["']/i);
  if (ogDesc) {
    description = decodeHtml(ogDesc[1]);
  }

  if (!title) source = 'error';
  return { title, favicon, description, source };
}

/** 解码 HTML 实体 */
function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 用 Electron 隐藏窗口渲染页面后提取标题（对付 CSR / 反爬站点）
 * 流程：创建 offscreen BrowserWindow → loadURL → 等待 JS 执行 → executeJavaScript 提取标题
 */
async function fetchRenderedTitle(targetUrl) {
  // 并发锁：如果已有实例在执行，等待后重试（利用缓存降低重试频率）
  if (renderedTitleLock) {
    await sleep(500);
    return fetchRenderedTitle(targetUrl);
  }
  renderedTitleLock = true;
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
        javascript: true,
      },
    });

    const cleanup = (result) => {
      clearTimeout(timeout);
      try { win.destroy(); } catch {}
      renderedTitleLock = false;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      cleanup({ title: null, favicon: null, source: 'error' });
    }, 8000);

    win.webContents.on('did-finish-load', async () => {
      // 再等 1.5s 让 SPA 完成 JS 渲染
      await sleep(1500);
      try {
        const result = await win.webContents.executeJavaScript(`
          (() => {
            const og = document.querySelector('meta[property="og:title"]');
            if (og && og.content) return { title: og.content.trim(), favicon: null };
            const tw = document.querySelector('meta[name="twitter:title"]');
            if (tw && tw.content) return { title: tw.content.trim(), favicon: null };
            // 微信文章
            const wx = document.querySelector('#activity_name, .rich_media_title');
            if (wx) return { title: wx.textContent.trim(), favicon: null };
            // 知乎
            const zh = document.querySelector('.Post-Title, h1.Title');
            if (zh) return { title: zh.textContent.trim(), favicon: null };
            // 掘金
            const jj = document.querySelector('h1.article-title');
            if (jj) return { title: jj.textContent.trim(), favicon: null };
            return { title: document.title.trim(), favicon: null };
          })()
        `);
        if (result && result.title && result.title.length > 0 && result.title !== 'about:blank') {
          cleanup({ title: result.title, favicon: result.favicon, source: 'render' });
        } else {
          cleanup({ title: null, favicon: null, source: 'error' });
        }
      } catch {
        cleanup({ title: null, favicon: null, source: 'error' });
      }
    });

    win.webContents.on('did-fail-load', () => {
      cleanup({ title: null, favicon: null, source: 'error' });
    });

    win.loadURL(targetUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
  });
}

module.exports = {
  cleanupLinkCache,
  fetchPage,
  parseMeta,
  decodeHtml,
  fetchRenderedTitle,
};
