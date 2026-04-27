# DesktopSecretary 多端数据同步架构方案

> 目标：搭建用户注册/登录体系，实现跨设备应用数据云端同步。

---

## 1. 需求概述

### 现状
- 单用户桌面应用，数据存储在本地 `electron-store`（SQLite）
- 已集成腾讯云 CloudBase（仅用于自动更新检查）
- 无用户体系，无云端数据存储

### 目标
1. **用户体系**：支持注册账号、登录、登出
2. **云端同步**：用户所有核心数据自动同步到 CloudBase
3. **多端一致**：换设备登录后可恢复全部数据
4. **离线可用**：无网络时本地正常使用，联网后自动同步
5. **数据安全**：云端数据加密存储，厂商/管理员无法读取明文

---

## 2. 架构总览

采用 **「主进程代理」** 模式，所有云端操作由 Electron 主进程统一处理，渲染进程通过 IPC 调用。

```
┌─────────────────┐     IPC      ┌─────────────────┐     Node SDK      ┌─────────────────┐
│   渲染进程       │◄────────────►│    主进程        │◄────────────────►│  腾讯云 CloudBase│
│   (React)       │ store:get    │   (Node.js)      │   SecretId/Key   │  ├─ 数据库        │
│                 │ store:set    │                 │   Admin 权限      │  ├─ 云函数        │
│                 │ sync:login   │                 │                  │  └─ 云存储        │
│                 │ sync:push    │                 │                  │                 │
│                 │ sync:pull    │                 │                  │                 │
└─────────────────┘              └─────────────────┘                  └─────────────────┘
```

### 为什么选「主进程代理」？
| 维度 | 主进程代理 | 前端直连 (js-sdk) |
|------|-----------|------------------|
| 密钥安全 | ✅ SecretKey 不暴露 | ❌ 需暴露或走 Ticket |
| 逻辑统一 | ✅ 同步逻辑一处维护 | ❌ 主/渲染各有一套 |
| 数据加密 | ✅ 可在主进程做加解密 | ⚠️ 密钥管理更复杂 |
| 与现有架构 | ✅ 复用现有 IPC 模式 | ❌ 需引入 js-sdk |

---

## 3. 数据库设计 (CloudBase)

创建两个集合：

### 3.1 `users` — 用户认证表

```js
{
  _id: "uid_xxxxxxxx",           // CloudBase 自动生成或自定义
  username: "alice",             // 唯一索引
  passwordHash: "$2b$10$...",    // bcrypt 哈希
  salt: "random_salt_xxx",       // 额外盐值（派生加密密钥用）
  createdAt: Date,
  lastLoginAt: Date,
  // 不存储任何应用数据，只做身份验证
}
```

**安全规则**：拒绝所有客户端直接访问，仅主进程 Admin 权限可操作。

### 3.2 `userData` — 用户数据表

```js
{
  _id: "uid_xxxxxxxx",           // 与 users._id 一致，每个用户一条文档
  cipherBlob: "base64...",       // AES-256-GCM 加密后的完整数据包
  dataHash: "sha256:abc...",     // 明文哈希（用于快速比对是否有变化）
  updatedAt: Date,               // 云端最后更新时间
  updatedByDevice: "device-id",  // 最后更新设备标识
  schemaVersion: 1,              // 数据格式版本，便于未来迁移
}
```

**安全规则**：同样拒绝客户端直接访问。

---

## 4. 用户认证体系

### 4.1 注册流程

```
1. 用户在渲染进程填写：用户名 + 密码 + 确认密码
2. IPC → 主进程 `sync:register`
3. 主进程：
   a. 校验格式（长度、特殊字符）
   b. 查询 CloudBase users 集合，确认用户名唯一
   c. bcrypt 哈希密码
   d. 生成随机 salt（用于数据加密）
   e. 写入 users 文档
   f. 返回 { success: true, uid }
4. 渲染进程：提示注册成功，自动登录
```

### 4.2 登录流程

```
1. 用户填写：用户名 + 密码
2. IPC → 主进程 `sync:login`
3. 主进程：
   a. 查询 users 文档
   b. bcrypt compare 验证密码
   c. 生成设备级 session（本地存储 uid + 登录态）
   d. 返回 { success: true, uid, username }
4. 渲染进程：进入已登录状态，触发首次数据拉取
```

### 4.3 登出流程

```
1. 用户点击「退出登录」
2. IPC → 主进程 `sync:logout`
3. 主进程：
   a. 清空本地 session
   b. 可选择：保留本地数据 / 清除本地数据（询问用户）
4. 回到未登录态
```

### 4.4 同步密码（数据加密密钥）

**设计**：登录密码 ≠ 数据加密密钥（虽然可以相同，但分开更灵活）。

- 用户首次开启同步时，要求设置「同步密码」（或复用登录密码）
- 使用 `PBKDF2(同步密码 + user.salt)` 派生 256-bit AES 密钥
- 密钥 **只存在于内存**，不持久化到磁盘
- 应用重启后需要重新输入同步密码才能同步（或安全存储到系统钥匙串）

---

## 5. 数据同步策略

### 5.1 同步范围

**全局同步**（跟随账号）：
| Store Key | 说明 |
|-----------|------|
| `workspaces` | 工作区列表 |
| `todosGlobal` | 全局待办 |
| `quickLinks:*` | 各工作区快速链接 |
| `fileShortcuts:*` | 各工作区文件快捷方式 |
| `pinnedFolders` | 置顶文件夹 |
| `recentFolders` | 最近访问 |
| `linkCache` | 链接预览缓存 |
| `aiSettings` | AI 配置（含 API Key，**必须加密**） |
| `reminderLevels` | 提醒层级 |
| `trashedWorkspaces` | 回收站工作区 |
| `trashedTodos` | 回收站待办 |
| `tokenStats` | Token 用量统计 |

**设备本地**（不同步）：
| Store Key | 说明 |
|-----------|------|
| `windowWidthPercent` | 窗口宽度 |
| `dockedEdge` | 吸附边缘 |
| `dockBounds` | 浮空位置 |
| `dockEdgeOffset` | 边缘偏移 |
| `fontScale` | 字号（可选同步，看需求） |
| `pinShortcutKey` | 快捷键（通常设备相关） |
| `autoLaunch` | 开机自启（OS 级） |

### 5.2 同步时机

| 触发条件 | 行为 | 防抖 |
|---------|------|------|
| 应用启动 | 自动拉取云端数据，与本地合并 | — |
| 任意 `store:set` 发生在同步范围内 | 3 秒后自动 push | 3s debounce |
| 用户点击「立即同步」 | 立即 push + pull | — |
| 网络从断开到恢复 | 自动 push + pull | 5s debounce |
| 应用退出 | 如有未同步变更，静默 push | — |

### 5.3 冲突解决策略

采用 **「最后写入者胜出 (Last-Write-Wins)」** + **用户确认兜底**：

```
本地 updatedAt  vs  云端 updatedAt

1. 本地 === 云端：无变更，无需同步
2. 本地 > 云端：本地更新，执行 push
3. 本地 < 云端：云端更新，执行 pull
4. 双向都有更新（罕见）：
   - 优先以时间戳较新的为准
   - 若时间差 < 5 分钟，视为冲突
   - 冲突时：弹出提示让用户选择「保留本地」或「使用云端」
```

**数据包结构设计**（解决字段级合并过于复杂的问题）：
- 每次同步打包完整的同步范围数据为一个 JSON blob
- 加密后上传/下载
- 避免字段级合并的复杂性和 bug 风险

### 5.4 离线优先

```
所有 store:set 操作：
  1. 立即写入本地 electron-store（现有逻辑不变）
  2. 标记 dirty flag
  3. 若已登录且联网，加入同步队列
  4. 同步失败 → 保留 dirty flag，定时重试
```

---

## 6. 数据加密 & 安全

### 6.1 加密方案

```
用户同步密码
    │
    ▼
PBKDF2(password, user.salt, 100000 iterations)
    │
    ▼
AES-256-GCM 密钥 (32 bytes)
    │
    ▼
加密 JSON.stringify(syncData)
    │
    ▼
base64(cipherText + authTag + iv) → 存入 CloudBase
```

- **算法**：AES-256-GCM（认证加密，防篡改）
- **派生**：PBKDF2，10万轮，用户唯一 salt
- **实现**：Node.js 内置 `crypto` 模块

### 6.2 为什么必须加密？

- CloudBase 管理员、腾讯云运维可以看到数据库内容
- 用户的 `aiSettings.apiKey` 是敏感凭证
- 用户的工作区、待办属于隐私数据
- **端到端加密**确保只有用户本人能解密

### 6.3 密钥存储

| 方案 | 安全性 | 便利性 |
|------|--------|--------|
| 每次启动输入同步密码 | ⭐⭐⭐ | ⭐ |
| 用 `safeStorage` 存到系统钥匙串 | ⭐⭐⭐ | ⭐⭐⭐ |
| 明文存本地 config | ⭐ | ⭐⭐⭐ |

**推荐**：首次同步时输入密码，勾选「记住密码」则用 `electron.safeStorage` 加密存储到本地 store。safeStorage 使用系统级保护（Windows DPAPI / macOS Keychain / Linux Secret Service）。

---

## 7. 实施计划（分 4 个阶段）

### Phase 1: 基础设施（预计 2-3 天）

**目标**：搭建认证和加密的底层能力。

- [ ] 安装依赖：`bcrypt`（或 `bcryptjs`）、验证 `crypto` 模块
- [ ] 创建 `main/sync/` 模块目录：
  - `auth.js` — 注册/登录/密码验证
  - `crypto.js` — 加密/解密/密钥派生
  - `cloud.js` — CloudBase 数据库读写封装
  - `engine.js` — 同步引擎（push/pull/合并）
  - `index.js` — 统一导出
- [ ] CloudBase 控制台创建 `users` 和 `userData` 集合
- [ ] 配置集合安全规则（拒绝客户端访问）
- [ ] 实现注册/登录 IPC 通道：
  - `sync:register`
  - `sync:login`
  - `sync:logout`
  - `sync:getStatus`

**验收标准**：
- 可以成功注册账号
- 可以成功登录并拿到 uid
- 登录态在应用重启后保持（本地 session）

### Phase 2: 同步引擎（预计 3-4 天）

**目标**：实现数据上云和下载。

- [ ] 实现数据打包器：扫描所有同步范围内的 store key，打包为 JSON
- [ ] 实现加密上传 `sync:push`：打包 → 加密 → 写入 CloudBase `userData`
- [ ] 实现解密下载 `sync:pull`：读取 `userData` → 解密 → 写回 store
- [ ] 实现 `sync:syncNow`（先 push 再 pull，或双向合并）
- [ ] 实现启动时自动 sync（登录状态下）
- [ ] 实现 store 变更监听 + 防抖自动 push
- [ ] 处理网络异常重试（指数退避，最多 3 次）

**验收标准**：
- 登录状态下修改数据，3 秒后自动同步到云端
- 关闭应用、重新打开，数据从云端恢复
- 断网时本地正常使用，恢复网络后自动同步

### Phase 3: UI 集成（预计 2-3 天）

**目标**：给用户可见的同步控制和反馈。

- [ ] 设计「账号与同步」设置面板（或独立弹窗）
- [ ] 未登录态：显示登录/注册表单
- [ ] 已登录态：显示用户名、同步状态、上次同步时间
- [ ] 添加「立即同步」按钮
- [ ] 添加「退出登录」按钮（确认是否保留本地数据）
- [ ] 同步状态指示器（标题栏或设置面板）：
  - 🟢 已同步
  - 🟡 同步中...
  - 🔴 同步失败（点击重试）
- [ ] 冲突提示弹窗（当检测到双向更新时）
- [ ] 首次开启同步引导：设置同步密码 + 说明加密

**验收标准**：
- UI 上能完成完整的注册→登录→同步→登出流程
- 同步状态实时可见

### Phase 4: 稳定与优化（预计 2-3 天）

**目标**：生产级可用。

- [ ] 数据迁移：首次同步时把现有本地数据上传到云端
- [ ] 多设备测试（至少两台电脑）
- [ ] 大数据包测试（数据量 > 1MB 时的性能）
- [ ] 错误处理：网络超时、CloudBase 额度超限、解密失败
- [ ] 添加数据版本迁移逻辑（`schemaVersion`）
- [ ] 可选：同步历史/回滚（保留最近 3 个版本）
- [ ] 清理测试数据，准备上线

---

## 8. 关键代码结构预览

### 8.1 新增模块目录

```
main/
├── sync/
│   ├── index.js          # 统一初始化、状态管理
│   ├── auth.js           # 注册/登录/登出
│   ├── crypto.js         # 加密/解密/密钥派生
│   ├── cloud.js          # CloudBase 数据库封装
│   ├── engine.js         # push / pull / 合并逻辑
│   └── constants.js      # 同步白名单、配置常量
```

### 8.2 核心 API 预览

```js
// main/sync/index.js — 渲染进程通过 IPC 调用

// 注册
async function register(username, password) { ... }

// 登录
async function login(username, password) { ... }

// 获取当前登录状态
function getStatus() { return { isLoggedIn, username, uid, lastSyncAt }; }

// 手动触发同步
async function syncNow() { ... }

// 登出
async function logout(options = { keepLocalData: true }) { ... }
```

### 8.3 IPC 通道新增清单

```
sync:register      → { username, password }          → { success, uid?, error? }
sync:login         → { username, password }          → { success, uid?, username?, error? }
sync:logout        → { keepLocalData }               → { success }
sync:getStatus     → ()                             → { isLoggedIn, username?, lastSyncAt? }
sync:syncNow       → ()                             → { success, direction?, error? }
sync:onStatusChange(callback)   ← 推送同步状态变化
```

---

## 9. 风险 & 注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 用户忘记同步密码 | 数据永久无法解密 | 明确提示「忘记密码 = 数据丢失」；暂不提供密码找回 |
| CloudBase 免费额度用完 | 同步失败 | 监控调用量；控制台设置告警；做好错误提示 |
| 数据包过大 | 同步慢 / 超时 | 当前数据量预计 < 100KB，如未来增大考虑分片 |
| 多端同时编辑冲突 | 数据覆盖 | LWW 策略 + 冲突提示；未来可做操作日志合并 |
| bcrypt 在 Electron 打包后原生模块问题 | 注册/登录失败 | 优先用 `bcryptjs`（纯 JS），牺牲少量性能换兼容性 |
| SecretKey 泄露 | 数据库被篡改 | 不暴露给渲染进程；数据库安全规则兜底；最小权限原则 |

---

## 10. 后续可扩展方向

1. **Web 端**：用 `@cloudbase/js-sdk` + 相同加密逻辑，实现浏览器版
2. **移动端**：微信小程序或 Flutter，同样基于 CloudBase
3. **团队协作**：从「单用户单文档」扩展为「工作区级共享」
4. **实时同步**：CloudBase 实时推送（watch），实现多设备即时同步
5. **版本历史**：`userData` 集合保留最近 N 个版本，支持时间线回滚
6. **附件同步**：截图、文件通过 CloudBase 云存储同步

---

## 11. 预估工作量

| 阶段 | 时间 | 依赖 |
|------|------|------|
| Phase 1 基础设施 | 2-3 天 | CloudBase 控制台权限 |
| Phase 2 同步引擎 | 3-4 天 | Phase 1 |
| Phase 3 UI 集成 | 2-3 天 | Phase 2 |
| Phase 4 稳定优化 | 2-3 天 | Phase 3 |
| **总计** | **~10 天** | — |

> 注：如使用现有的 Kimi Code CLI 辅助编码，核心逻辑部分可压缩到 3-5 天完成。

---

*文档版本: v1.0*
*编写日期: 2026-04-26*
