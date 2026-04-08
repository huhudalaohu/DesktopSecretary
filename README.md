# DesktopSecretary

毛玻璃风格的桌面助手应用，固定在屏幕右侧，提供工作区切换、文件导航、待办列表和 AI 助手功能。

## 技术栈

- **Electron 30+** — 主进程窗口管理和 IPC
- **React 18 + Vite** — 渲染进程 UI
- **Tailwind CSS** — 样式系统
- **electron-store** — 本地数据持久化
- **lucide-react** — 图标库

## 运行步骤

```bash
# 1. 安装依赖
npm install

# 2. 构建渲染进程 (Vite → dist/)
npx vite build

# 3. 启动应用
npm start
```

> 如果要开发模式（热更新），可以开两个终端：
> - 终端1: `npx vite` (启动 Vite 开发服务器)
> - 终端2: `npm start` (启动 Electron)
>
> 并修改 `main.js` 中的 `loadFile` 为 `loadURL('http://localhost:5173')`。

## 功能模块

### 1. 工作区切换
顶部胶囊按钮，点击切换工作区。数据存储在 `workspaces` 键。

### 2. 文件导航
- **置顶区域**: 横向小卡片，最多 8 个，支持拖拽排序和右键取消置顶
- **最近访问**: 纵向列表，通过本软件打开的文件夹自动记录

### 3. 待办列表
- 添加/完成/删除待办，支持筛选（全部/进行中/已完成）
- 按工作区分组存储，重启后数据不丢失

### 4. AI 助手
- 屏幕截图功能
- 桌面文件扫描，建议整理
- Kimi API Key 设置

## 数据存储

所有数据通过 `electron-store` 持久化到本地 JSON 文件：

| 键名 | 说明 |
|------|------|
| `workspaces` | 工作区列表 `[{id, name}]` |
| `pinnedFolders` | 置顶文件夹 `[{id, path, alias}]` |
| `recentFolders` | 最近访问 `[{path, timestamp}]` |
| `todos` | 待办事项 `{workspaceId: [{id, text, done}]}` |
| `kimiApiKey` | Kimi API Key |

## 项目结构

```
DesktopSecretary/
├── main.js              # 主进程：窗口管理、IPC处理
├── preload.js           # 预加载：安全暴露IPC API
├── index.html           # HTML入口
├── package.json         # 项目配置
├── vite.config.js       # Vite构建配置
├── tailwind.config.js   # Tailwind配置
├── postcss.config.js    # PostCSS配置
├── README.md            # 本文件
└── src/
    ├── main.jsx         # React入口
    ├── App.jsx          # 主布局组件
    ├── components/
    │   ├── WorkspaceSwitcher.jsx  # 工作区切换
    │   ├── FileNavigator.jsx      # 文件导航
    │   ├── TodoList.jsx           # 待办列表
    │   └── AIAssistant.jsx        # AI助手卡片
    └── styles/
        └── global.css             # 全局样式 + Tailwind
```
