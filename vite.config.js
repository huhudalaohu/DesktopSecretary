import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  // 开发模式下渲染进程构建配置
  root: '.',                // 项目根目录
  base: './',               // 使用相对路径，适配 file:// 协议加载
  build: {
    outDir: 'dist',         // 构建输出目录
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),  // @ 别名指向 src
    },
  },
  server: {
    port: 5173,
  },
});
