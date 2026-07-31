/**
 * 渲染进程入口文件
 * 将 React App 挂载到 #root 节点
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import ErrorBoundary from './ErrorBoundary';
import './styles/global.css';

// 仅在 Vite 开发模式(浏览器预览)下加载 mock,生产构建中会被 tree-shaking 移除
// 必须在加载 App 之前完成,否则 App 顶层的 `const api = window.desktopAPI` 会拿到 undefined
if (import.meta.env.DEV) {
  await import('./config/browser-mock');
}

const { default: App } = await import('./App');

// 滚动条自动隐藏:滚动时给滚动容器加 scroll-active 类,停止滚动 700ms 后移除
const scrollIdleTimers = new WeakMap();
window.addEventListener('scroll', (e) => {
  const el = e.target === document ? document.documentElement : e.target;
  if (!(el instanceof Element)) return;
  el.classList.add('scroll-active');
  clearTimeout(scrollIdleTimers.get(el));
  scrollIdleTimers.set(el, setTimeout(() => el.classList.remove('scroll-active'), 700));
}, true);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
