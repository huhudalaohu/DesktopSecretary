# DesktopSecretary 积分/会员系统 (v2)

> **修改积分相关代码前必读。** 服务端是积分余额的唯一真值,客户端任何"偷懒优化"都可能导致用户白嫖或重复扣分。
>
> **v2 关键变化**:身份认证、邮件验证码、AccessToken 续期全部由 CloudBase 平台接管,我们不再自写 JWT/bcrypt/SMTP。原 `users` / `verifyCodes` 集合已废弃,`auth-register` / `auth-login` / `sendVerifyCode` 三个云函数已删除。

---

## 1. 整体链路

```
┌────────────────────────────────────────────────────────────────┐
│  客户端 Electron App                                            │
│                                                                  │
│  渲染进程 (React)                                                │
│  ├─ @cloudbase/js-sdk                                           │
│  │   ├─ auth.signUpWithEmailAndPassword                         │
│  │   ├─ auth.getVerification → verify → signIn (邮件验证码登录) │
│  │   ├─ auth.getAccessToken()  ← SDK 自动续期 (2h/30d)         │
│  │   └─ persistence: 'local' (localStorage,30 天免重登)         │
│  ├─ src/services/cloudbase.js  ← SDK 单例 + 登录态导出           │
│  ├─ src/services/ai-proxy.js   ← callAI/fetchBalance/fetchAppConfig│
│  └─ 通过 IPC 把 uid 同步给主进程(供同步引擎用)                  │
│                                                                  │
│  主进程 (Node.js)                                                │
│  ├─ 监听 'auth:setUid' IPC 更新 syncSession                      │
│  ├─ 同步引擎继续用 admin SDK 操作 userData                        │
│  └─ 不再 require bcryptjs / nodemailer / 自写 JWT                │
└──────────────────────────────────┬──────────────────────────────┘
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        ▼ ① 登录/注册 (SDK 直连,平台发邮件)                  │
        │                                                      ▼
        │                                  ② 调云函数 (Authorization: Bearer <AccessToken>)
        │                                                      │
        │       ┌──────────────────────────────────────────────┴──────────┐
        │       │ CloudBase 平台 (上海, ds-dev-d9g28xlrgd2600837)         │
        ├──────►│ ┌─ 身份认证 v2  (邮箱密码 / 邮箱码)                      │
        │       │ ├─ 内置邮件服务 (验证码发送)                              │
        │       │ └─ 网关自动验签 AccessToken → 写 event.userInfo.uid     │
        │       └─────────────────────┬───────────────────────────────────┘
        │                             ▼
        │       ┌─────────────────────────────────────────────────────────┐
        │       │ 4 个云函数 (M.A 仅 3 个,M.B 追加 3 个支付函数)           │
        │       │  ┌──────────────────────────────────────────────────┐  │
        │       │  │ ai-proxy  (核心)                                  │  │
        │       │  │   1. uid = event.userInfo.uid (网关已验)         │  │
        │       │  │   2. 懒建 user_credits → 首次 +500 积分          │  │
        │       │  │   3. 余额≤0 → 402 INSUFFICIENT_CREDITS           │  │
        │       │  │   4. 转发上游 (apiKey 在 app_config 内)          │  │
        │       │  │   5. 读 usage.total_tokens                       │  │
        │       │  │   6. credits = ceil(tokens / tokensPerCredit)    │  │
        │       │  │   7. 原子 inc(-credits) + 写流水                 │  │
        │       │  │   8. 返回 {…上游响应, _credits}                  │  │
        │       │  └──────────────────────────────────────────────────┘  │
        │       │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐    │
        │       │  │ get-balance │  │ app-config  │  │ checkUpdate  │    │
        │       │  └─────────────┘  └─────────────┘  └──────────────┘    │
        │       └─────────────────────────────┬───────────────────────────┘
        │                                     ▼
        │       ┌─────────────────────────────────────────────────────────┐
        │       │ CloudBase DB (4 个集合)                                  │
        │       │ ├─ tcb-cms-* (CloudBase Auth 内部表,不要直接读写)       │
        │       │ ├─ user_credits        (uid → balance/totalRecharged…)  │
        │       │ ├─ credit_transactions (审计流水,只增不删)               │
        │       │ ├─ app_config          (单文档,后台直填 apiKey)          │
        │       │ └─ recharge_orders     (M.B)                            │
        │       │                                                          │
        │       │ ✗ 已废弃: users / verifyCodes (CloudBase Auth 接管)      │
        │       └─────────────────────────────────────────────────────────┘
        ▼
   上游 AI (Kimi / 通义,服务端持有 apiKey)
```

**核心约束(违反任何一条都会破坏反作弊)**:

1. **AI 厂商 API Key 永远不进客户端打包产物** — 只存 `app_config.aiModes.*.apiKey`,客户端通过 `app-config` 云函数拿到的版本由 `sanitizeForClient()` 剥掉
2. **积分余额服务端是唯一真值** — 客户端 React state 仅供 UI 展示,每次 `ai-proxy` 响应都返回 `_credits.balanceAfter`,以服务端为准
3. **token 数从上游 `usage.total_tokens` 读取** — 客户端无法伪造,云函数也不能信客户端传来的 token 数
4. **AccessToken 由 CloudBase 网关签发与验签** — 我们的代码只读 `event.userInfo.uid`,不掺和签名密钥

---

## 2. 数据库集合

### 2.1 `user_credits` (1 用户 1 文档,doc id = CloudBase uid)

```
{
  _id: uid,               // = event.userInfo.uid
  balance: 500,           // 当前积分
  totalRecharged: 500,    // 累计充值/赠送
  totalConsumed: 0,       // 累计消耗
  welcomedAt: Date,       // 是否已发欢迎积分(防重领)
  updatedAt: Date,
}
```

**写入规则**:
- 由 `ai-proxy` **懒初始化** — 首次调用时若文档不存在,原子写入 `{balance: 500, totalRecharged: 500, welcomedAt: now}`,并写一条 `recharge_gift:welcome` 流水
- 余额变化**只能用 `db.command.inc(±n)`**,绝不能 `update({balance: x})` — 否则并发请求会丢失中间扣减

### 2.2 `credit_transactions` (审计流水,只增不删)

```
{
  uid,
  type: 'consume' | 'recharge_paid' | 'recharge_gift' | 'admin_adjust',
  amount,            // 正数=进账,负数=消耗
  balanceAfter,      // 操作后余额(对账用)
  meta: { ... },     // 见下
  createdAt: Date,
}
```

不同 `type` 的 `meta`:
- `consume`: `{ mode: 'fast'|'precise', provider, model, totalTokens, promptTokens, completionTokens }`
- `recharge_paid` (M.B): `{ orderId, payAmount, channel: 'wechat'|'alipay' }`
- `recharge_gift`: `{ reason: 'welcome' | 'promo:CODE' }`
- `admin_adjust`: `{ operator, reason }`

### 2.3 `app_config` (单文档,doc id = `'global'`)

```
{
  _id: 'global',
  tokensPerCredit: 1000,    // 1000 token = 1 积分,后台可改
  welcomeBonus: 500,
  aiModes: {
    fast:    { provider, model, baseUrl, apiKey },  // ← apiKey 真 key 在这
    precise: { provider, model, baseUrl, apiKey },
  },
  recharge: { minAmount: 500, maxAmount: 100000, creditsPerYuan: 100 },  // 单位:分
  dailyUidConsumeLimit: 500000,
  maintenance: false,
}
```

**修改方式**: CloudBase 控制台 → 数据库 → `app_config` → `global` 文档,直接编辑 JSON。修改后 60s 内全网生效(云函数有 60s 内存缓存)。

### 2.4 `recharge_orders` (Milestone B)

```
{ _id: outTradeNo, uid, channel, payAmount, credits, status, prepayId, qrCode, paidAt, createdAt, expiresAt, thirdTradeNo }
```

---

## 3. 云函数清单

| 函数 | 鉴权 | 入参 | 出参/职责 |
|------|------|------|------|
| `ai-proxy` | 网关验签 | `{mode, messages, temperature?, max_tokens?}` | 懒建 user_credits → 转发上游 → 扣分 → 写流水 → 返回 `{...上游响应, _credits}` |
| `get-balance` | 网关验签 | `{}` | `{balance, totalRecharged, totalConsumed, recentTransactions:20}` |
| `app-config` | 网关验签 | `{}` | sanitize 后的配置(无 apiKey) |
| `checkUpdate` | 无 | `{currentVersion}` | 现有更新检查函数,与积分系统无关 |
| `create-recharge` (M.B) | 网关验签 | `{amount, channel}` | 创单 + 拿二维码 |
| `recharge-callback` (M.B) | 无(自验签) | 微信/支付宝异步通知 | 加积分 + 写流水 + 状态机幂等 |
| `query-order` (M.B) | 网关验签 | `{orderId}` | 订单状态轮询 |

**所有 M.A 函数共享**: `cloudbase/_shared/{response,config-cache}.js`,部署前由 [`cloudbase/sync-shared.js`](../cloudbase/sync-shared.js) 复制到各函数的 `lib/` 目录。

> v1 的 `_shared/jwt.js` 与 `_shared/auth-helper.js` 已删除 — 网关接管验签,我们只读 `event.userInfo.uid`。

**部署前必跑**: `node cloudbase/sync-shared.js`

### 3.1 鉴权代码骨架

```js
// 所有需要登录的函数,开头都是这两行:
exports.main = async (event, context) => {
  const uid = (event.userInfo && event.userInfo.uid)
           || (context.extendedContext && context.extendedContext.userId);
  if (!uid) return fail(401, 'UNAUTHORIZED');
  // ... 业务逻辑
};
```

### 3.2 网关权限

去 CloudBase 控制台 → 权限控制 → 「注册用户」角色 → 添加自定义策略,确认这 4 个函数路径已放行(默认 HTTP 访问服务对注册用户已是放行,部署后浏览一遍即可)。

---

## 4. 反作弊关键设计

| 风险 | 防护机制 |
|------|----------|
| 用户解包找开发者 API Key | apiKey 永远在 `app_config.aiModes.*.apiKey`,客户端通过 `app-config` 云函数拿不到(`sanitizeForClient` 剥掉) |
| 伪造客户端调云函数 | **网关层验签 AccessToken**,token 由 CloudBase 私钥签发,密钥不暴露给我们的代码 |
| 本地修改积分余额 | 客户端 state 是 UI 缓存,每次 AI 响应都用服务端 `_credits.balanceAfter` 覆盖 |
| 客户端伪报 token 数 | `ai-proxy` 从上游 `usage.total_tokens` 读,不信客户端 |
| 并发请求超扣 | `db.command.inc(-credits)` 原子操作,数据库层串行化 |
| 单用户脚本刷量 | `app_config.dailyUidConsumeLimit` 当日 token 总量上限(从 `credit_transactions` 当日聚合判断) |
| 注册脚本批量薅 500 积分 | CloudBase 内置邮件验证码 (60s 冷却 + 平台频次限制) + `welcomedAt` 字段防重领 |
| 截屏/抓包看到 AccessToken | AccessToken 只 2h 有效,SDK 自动刷;泄露最多损失 2h |
| 重复回调骗充值 | `recharge_orders.thirdTradeNo` 唯一索引 + 状态机幂等 (M.B) |

---

## 5. 客户端集成

### 5.1 SDK 单例与登录态

[`src/services/cloudbase.js`](../src/services/cloudbase.js) 是整个应用的 CloudBase 入口:

```js
import cloudbase from '@cloudbase/js-sdk';
const app = cloudbase.init({ env: __TCB_ENV_ID__, region: __TCB_REGION__ });
export const auth = app.auth({ persistence: 'local' });

// 注册:发邮件激活码
export async function signUp({ email, password }) { ... }

// 登录方式 1:邮箱密码
export async function signInWithPassword({ email, password }) { ... }

// 登录方式 2:邮箱验证码 (推荐 — 无需记密码)
export async function sendCode(email) { ... }     // 拿 verificationInfo
export async function signInWithCode({ email, code, verificationInfo }) { ... }

// 登录态广播
export function onLoginStateChanged(handler) { ... }
export function getCurrentUser() { ... }
```

登录成功后,`onLoginStateChanged` 会触发 — `App.jsx` 通过 `window.desktopAPI.authSetUid(uid)` IPC 把 uid 同步给主进程,主进程更新 `syncSession` 切换同步引擎。

### 5.2 AI 调用统一收口

所有 AI 调用都走 [`src/services/ai-proxy.js`](../src/services/ai-proxy.js) 的 `callAI()`:

```js
import { callAI, CallAIError } from '@/services/ai-proxy';

const data = await callAI({
  mode: 'fast',     // 'fast' | 'precise'
  messages: [...],  // OpenAI 兼容格式
  max_tokens: 256,
  temperature: 0.7,
});
const content = extractContent(data);
const credits = data._credits; // {used, balanceAfter, mode}
```

`callAI` 内部:
1. `await auth.getAccessToken()` 拿当前 token (SDK 自动续期)
2. `fetch(__AI_PROXY_URL__, {Authorization: 'Bearer <token>', body: ...})`
3. 401 → 抛 `CallAIError('NOT_LOGGED_IN')`
4. 402 → 抛 `CallAIError('INSUFFICIENT_CREDITS')`
5. 503 → 抛 `CallAIError('MAINTENANCE')`
6. 成功 → 广播 `credits-updated` window CustomEvent (`{balance, used, mode, totalTokens}`),供 `CreditsPanel` 实时更新

**4 处客户端入口已全部改完**:
- [`src/hooks/useScreenshotAI.js`](../src/hooks/useScreenshotAI.js) — 截图识别待办 (`mode: 'precise'`)
- [`src/hooks/useSettings.js`](../src/hooks/useSettings.js) — 测试连接 / 文本测试 (2 处,跟随用户选的 mode)
- [`src/features/files/components/QuickLinks.jsx`](../src/features/files/components/QuickLinks.jsx) — URL 转中文标题 (`mode: 'fast'`,5 层兜底的第 4 层)

**禁止**: 在 `src/` 下新增 `fetch('https://api.moonshot.cn/...')` 之类的直连 — 一律走 `callAI()`。

### 5.3 UI 组件

- [`src/features/sync/components/SyncPanel.jsx`](../src/features/sync/components/SyncPanel.jsx) — 注册/登录入口,内嵌验证码发送 + 输入流程
- [`src/features/credits/CreditsPanel.jsx`](../src/features/credits/CreditsPanel.jsx) — 余额显示 + 累计充值/消耗 + 最近 20 条流水 + 充值按钮 (M.B 占位)
- [`src/features/settings/components/SettingsPanel.jsx`](../src/features/settings/components/SettingsPanel.jsx) — AI 模式切换 (Fast/Precise) + 内嵌 SyncPanel 与 CreditsPanel

`aiSettings` electron-store 字段已简化为 `{ mode, shortcutKey }` — `apiKey/provider/customBaseUrl/customModel` 字段全部删除。

### 5.4 vite 注入的字面量

[`vite.config.js`](../vite.config.js) `define` 字段:

```js
__TCB_ENV_ID__:       JSON.stringify(env.TCB_ENV_ID || 'ds-dev-d9g28xlrgd2600837'),
__TCB_REGION__:       JSON.stringify(env.TCB_REGION || 'ap-shanghai'),
__AI_PROXY_URL__:     JSON.stringify(env.AI_PROXY_URL),
__GET_BALANCE_URL__:  JSON.stringify(env.GET_BALANCE_URL),
__APP_CONFIG_URL__:   JSON.stringify(env.APP_CONFIG_URL),
// M.B 追加:
__CREATE_RECHARGE_URL__: JSON.stringify(env.CREATE_RECHARGE_URL),
__QUERY_ORDER_URL__:     JSON.stringify(env.QUERY_ORDER_URL),
```

`__VERIFY_API_URL__` 已废弃(自家 sendVerifyCode 函数已删除)。`.env` 模板见 [`.env.example`](../.env.example)。

---

## 6. 部署流程

### 首次部署 (Milestone A)

```bash
# 1. CloudBase 控制台开启:
#    - 身份认证 → 邮箱密码登录方式
#    - 身份认证 → 邮箱验证码登录方式
#    - 内置邮件服务(验证码模板默认即可)
#    - 权限控制 → 「注册用户」对 ai-proxy/get-balance/app-config 的访问已放行

# 2. 同步共享代码到各云函数
node cloudbase/sync-shared.js

# 3. 部署 3 个云函数 (M.A)
cloudbase fn deploy ai-proxy --force
cloudbase fn deploy get-balance --force
cloudbase fn deploy app-config --force

# 4. 初始化数据库默认配置
node cloudbase/migrations/seed-app-config.js

# 5. 控制台 → 数据库 → app_config → global 文档,
#    把 aiModes.fast.apiKey / aiModes.precise.apiKey 填上真 key

# 6. 把每个云函数的 HTTP 触发器 URL 配进客户端 .env (TCB_ENV_ID, AI_PROXY_URL, GET_BALANCE_URL, APP_CONFIG_URL)
#    然后 npm run dist
```

### 老用户迁移

v2 不再使用 `users` 集合,CloudBase Auth 内部表与之不通用 — 老用户(数量 < 100)需重新注册。建议:
1. 控制台清空 `users` 与 `verifyCodes` 集合(可选,留着也无害,但已无代码引用)
2. 发版前在 README / 设置面板加一条提示:"v2 起请重新注册账号,首次注册仍送 500 积分"

### 后续配置调整(无需重新部署)

- **改倍率**: `app_config.tokensPerCredit` 改成 500 → 同样的 token 扣分翻倍
- **换 AI 厂商**: `app_config.aiModes.fast.apiKey/baseUrl/model` 改了即可
- **维护模式**: `app_config.maintenance = true` → 所有 ai-proxy 调用返回 503

修改后**最多等 60 秒**(云函数 `getAppConfig` 缓存 TTL)。

---

## 7. 验证清单(发版前必跑)

1. **新邮箱注册** → 收到 CloudBase 内置邮件 → 6 位码登录成功 → 设置面板看到余额 500
2. **截图 AI 调用** → 余额减少几个积分 → 流水多 1 条 `recharge_gift:welcome` (首次) + 1 条 `consume`,`meta.totalTokens` 与上游 `usage.total_tokens` 一致
3. **改 `tokensPerCredit` 为 500** → 等 60s → 再调 → 同样 token 数扣分翻倍
4. **手动改测试号余额为 0** → 调 AI → 客户端弹"积分不足,请充值"(`CallAIError('INSUFFICIENT_CREDITS')`),不是裸 502
5. **DevTools** `window.dispatchEvent(new CustomEvent('credits-updated', {detail:{balance:99999}}))` → CreditsPanel 显示 99999 → 下次调 AI 用服务端真值覆盖
6. **解包客户端 .asar**:`grep -r 'moonshot\|sk-\|qwen\|baseUrl' release/win-unpacked/resources/` → **0 命中**才合格(命中说明 apiKey 漏了)
7. **AccessToken 续期**:控制台调短 token 有效期(或本地等 2h+)→ SDK 自动 refresh → 调 AI 仍成功
8. **维护模式**: `maintenance:true` 等 60s → 调 AI 返回 503 + `CallAIError('MAINTENANCE')` → 关掉后 60s 内恢复
9. **登出/换账号**: 调用 `signOut()` → store 中 token 清掉 → CreditsPanel 退化到"请先登录"提示

---

## 8. 历史踩坑

### v2 迁移期发现的坑

- **`auth.signInWithEmail` 必须先 `getVerification` 再 `verify`**,跳过 `verify` 会 422 — 已在 `cloudbase.js` 的 `signInWithCode` 里走完 3 步
- **`@cloudbase/js-sdk@2.x` 在 Electron 渲染进程要 `persistence: 'local'`**,默认 `'session'` 会在 reload 后丢登录态
- **`auth.getAccessToken()` 返回的是 `{accessToken, env, ...}` 对象**,不是字符串 — `callAI` 里要用 `token.accessToken`
- **网关验签后,`event.userInfo.uid` 而非 `event.userInfo.openId`** — 老的 v1 文档里出现的 `openId` 写法已过时
- **`db.command.inc` 只能在 update 里用,不能在 add 里用** — 懒初始化时若用 inc 会插入失败,要先 `add({balance: 500, ...})` 再后续 `update + inc`

### 待补 (M.B)

- [ ] 微信支付 Native 下单签名算法易踩坑(SHA256 with RSA + 时间戳 + nonce_str 顺序)
- [ ] 支付宝当面付的 RSA 公钥更新会断回调

---

## 9. 关键文件

### 云函数

- [cloudbase/_shared/response.js](../cloudbase/_shared/response.js) — 统一 CORS / `ok` / `fail` / `parseBody`
- [cloudbase/_shared/config-cache.js](../cloudbase/_shared/config-cache.js) — `app_config` 60s 缓存 + sanitize
- [cloudbase/sync-shared.js](../cloudbase/sync-shared.js) — 部署前把 `_shared/` 同步到各函数 `lib/`
- [cloudbase/functions/ai-proxy/index.js](../cloudbase/functions/ai-proxy/index.js) — **核心**,扣分逻辑在这
- [cloudbase/functions/get-balance/index.js](../cloudbase/functions/get-balance/index.js)
- [cloudbase/functions/app-config/index.js](../cloudbase/functions/app-config/index.js)

> v1 遗留的 `cloudbase/_shared/jwt.js` / `auth-helper.js` 与 `cloudbase/functions/{auth-register,auth-login,sendVerifyCode}/` 已全部删除。

### 迁移脚本

- [cloudbase/migrations/seed-app-config.js](../cloudbase/migrations/seed-app-config.js)

### 客户端

- [src/services/cloudbase.js](../src/services/cloudbase.js) — SDK 单例 + 登录态导出
- [src/services/ai-proxy.js](../src/services/ai-proxy.js) — `callAI` / `fetchBalance` / `fetchAppConfig`
- [src/features/credits/CreditsPanel.jsx](../src/features/credits/CreditsPanel.jsx) — 余额 + 流水 + 充值入口
- [src/features/sync/components/SyncPanel.jsx](../src/features/sync/components/SyncPanel.jsx) — 注册/登录 UI
- [src/features/settings/components/SettingsPanel.jsx](../src/features/settings/components/SettingsPanel.jsx) — AI 模式切换
- [src/hooks/useScreenshotAI.js](../src/hooks/useScreenshotAI.js)
- [src/hooks/useSettings.js](../src/hooks/useSettings.js)
- [src/features/files/components/QuickLinks.jsx](../src/features/files/components/QuickLinks.jsx)

### 主进程

- [main/sync/auth.js](../main/sync/auth.js) — 已简化,只剩 session 维护
- [main/sync/cloud.js](../main/sync/cloud.js) — 删除了 user 相关方法
- [main/ipc/sync.js](../main/ipc/sync.js) — 简化 IPC,身份相关改由渲染端 SDK 处理
