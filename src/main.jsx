/**
 * 渲染进程入口文件
 * 将 React App 挂载到 #root 节点
 */
import './browser-mock';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
