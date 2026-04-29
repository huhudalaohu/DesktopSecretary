/**
 * 渲染进程入口文件
 * 将 React App 挂载到 #root 节点
 */
// 仅在 Vite 开发模式（浏览器预览）下加载 mock，生产构建中会被 tree-shaking 移除
if (import.meta.env.DEV) {
  import('./config/browser-mock');
}
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
