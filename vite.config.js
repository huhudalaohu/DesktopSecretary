import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

export default defineConfig(({ mode }) => {
  // 显式加载 .env(vite 默认只把 VITE_ 前缀注入 import.meta.env,不会写到 process.env);
  // 第三参数 '' 表示加载所有前缀的变量,不过滤
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
      // CloudBase 环境与积分系统云函数 URL(.env 配置)
      __TCB_ENV_ID__: JSON.stringify(env.TCB_ENV_ID || 'ds-dev-d9g28xlrgd2600837'),
      __TCB_REGION__: JSON.stringify(env.TCB_REGION || 'ap-shanghai'),
      __AI_PROXY_URL__: JSON.stringify(env.AI_PROXY_URL || ''),
      __GET_BALANCE_URL__: JSON.stringify(env.GET_BALANCE_URL || ''),
      __APP_CONFIG_URL__: JSON.stringify(env.APP_CONFIG_URL || ''),
      __CREATE_RECHARGE_URL__: JSON.stringify(env.CREATE_RECHARGE_URL || ''),
      __QUERY_ORDER_URL__: JSON.stringify(env.QUERY_ORDER_URL || ''),
      __MOCK_PAY_URL__: JSON.stringify(env.MOCK_PAY_URL || ''),
    },
    // 开发模式下渲染进程构建配置
    root: '.',                // 项目根目录
    base: './',               // 使用相对路径，适配 file:// 协议加载
    build: {
      outDir: 'dist',         // 构建输出目录
      emptyOutDir: true,
      target: 'es2022',       // 支持顶层 await（ai-config.js 动态导入预设）
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),  // @ 别名指向 src
      },
    },
    server: {
      port: 5173,
    },
  };
});
