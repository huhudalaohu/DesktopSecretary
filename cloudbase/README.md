# CloudBase 云函数 — 积分/会员系统

DesktopSecretary 积分系统所有的服务端代码都在这里。

## 目录结构

```
cloudbase/
├── README.md                 ← 本文档
├── _shared/                  ← 共享工具代码(每个云函数会拷贝一份过去)
│   ├── jwt.js                  HS256 签发/校验,无外部依赖,只用 Node 内置 crypto
│   ├── response.js             jsonResponse + CORS
│   ├── auth-helper.js          从 Authorization 头解析 Bearer token
│   └── config-cache.js         读 app_config 文档 + 60s 内存缓存
├── functions/                ← 云函数源码,每个文件夹对应一个函数
│   ├── auth-register/          注册:验证码 + bcrypt + 创 user_credits + 签 JWT
│   ├── auth-login/             登录:bcrypt 比对 + 签 JWT + 返回余额
│   ├── ai-proxy/               核心:JWT 校验 → 余额 → 上游 AI → 扣分 → 流水
│   ├── get-balance/            查询余额 + 最近流水
│   └── app-config/             返回脱敏后的 app_config(给客户端用)
├── migrations/               ← 一次性脚本,本地跑(用 admin SDK)
│   ├── seed-app-config.js      首次部署时往 app_config 集合写入默认文档
│   └── init-user-credits.js    给所有现存 users 创建 user_credits 记录(送 500)
└── sync-shared.js            ← 把 _shared/*.js 复制到每个 functions/<name>/lib/

```

## 数据库集合(需要手动在 CloudBase 控制台创建)

| 集合 | 主键 | 说明 |
|------|------|------|
| `users` (已存在) | 自动 _id | 用户表 |
| `userData` (已存在) | uid | 用户业务数据同步 |
| `verifyCodes` (已存在) | email | 注册验证码 |
| **`user_credits`** | uid | 用户当前积分余额 |
| **`credit_transactions`** | 自动 _id | 积分流水(consume / recharge / gift) |
| **`recharge_orders`** | outTradeNo | 充值订单(Milestone B) |
| **`app_config`** | 'global'(单文档) | 全局配置(AI 模式、倍率、限额) |

详细 schema 见 [schema.md](./schema.md)(待建)。

## 部署流程

### 1. 首次部署前的准备

#### 1.1 配置环境变量(在 CloudBase 控制台 → 函数 → 环境变量)

每个云函数都需要这些环境变量:

```
TCB_ENV=ds-dev-d9g28xlrgd2600837    # 当前 CloudBase 环境 ID(也可读 SYMBOL_CURRENT_ENV)
JWT_SECRET=<随机生成的 32 字节字符串>   # 必填,生产环境务必用强随机
```

`auth-register` / `auth-login` 不需要额外的 env vars。
`ai-proxy` / `app-config` 同样不需要——AI key 是从 `app_config.aiModes[mode].apiKey` 读的(数据库),不在 env vars。

> **生成 JWT_SECRET**:`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

#### 1.2 把 `_shared` 复制到每个函数目录

```bash
node cloudbase/sync-shared.js
```

这一步会把 `cloudbase/_shared/*.js` 复制到每个 `functions/<name>/lib/` 下,这样每个函数目录是自包含的、可以直接打包上传。

#### 1.3 在数据库中初始化 `app_config` 文档

```bash
node cloudbase/migrations/seed-app-config.js
```

会写入一条 doc id = 'global' 的文档,默认值见脚本。**部署后你需要去控制台数据库手动填上 `aiModes.fast.apiKey` 和 `aiModes.precise.apiKey`!**

### 2. 上传云函数到 CloudBase

每个 `functions/<name>/` 目录就是一个完整的云函数,可以:

**方法 A:压缩上传**
```bash
cd cloudbase/functions/auth-register
zip -r ../auth-register.zip .
# 上传 auth-register.zip 到控制台
```

**方法 B:用 CloudBase CLI**
```bash
npm i -g @cloudbase/cli
tcb login
cd cloudbase/functions/auth-register
tcb fn deploy auth-register --force
```

每个函数都需要配置 **HTTP 触发器(不鉴权)**,然后把生成的 URL 填到客户端 `.env`:
```
AUTH_REGISTER_URL=https://xxx.tcloudbase.com/auth-register
AUTH_LOGIN_URL=https://xxx.tcloudbase.com/auth-login
AI_PROXY_URL=https://xxx.tcloudbase.com/ai-proxy
GET_BALANCE_URL=https://xxx.tcloudbase.com/get-balance
APP_CONFIG_URL=https://xxx.tcloudbase.com/app-config
```

### 3. 老用户迁移(Milestone A 上线时跑一次)

```bash
node cloudbase/migrations/init-user-credits.js
```

会扫描 `users` 集合,给所有还没有 `user_credits` 记录的老用户创建一条初始 500 积分,并在 `credit_transactions` 写一条 `recharge_gift:welcome_migration` 流水。

## 核心安全设计

- **API Key 永不下发**:所有 AI provider 的 key 存在 `app_config.aiModes[mode].apiKey`(数据库),只有云函数 admin SDK 能读;`app-config` 云函数返回给客户端时**强制过滤掉 apiKey 字段**
- **JWT 签发**:`auth-register` / `auth-login` 用 `JWT_SECRET`(env var)签 HS256,7 天过期
- **服务端是唯一真值**:积分余额永远以 `user_credits.balance` 为准,客户端只缓存做 UI 显示,每次 ai-proxy 响应里附带 `_credits.balanceAfter` 覆盖客户端
- **Token 用量从上游响应读**:`ai-proxy` 不信任客户端报的 token 数,只看上游 AI 返回的 `usage.total_tokens`
- **原子扣分**:`db.command.inc(-credits)` 保证并发安全

## 常用调试命令

```bash
# 测注册
curl -X POST $AUTH_REGISTER_URL \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"pass123","code":"123456"}'

# 测登录
curl -X POST $AUTH_LOGIN_URL \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"pass123"}'

# 测 ai-proxy(替换 $TOKEN 为登录返回的 jwt)
curl -X POST $AI_PROXY_URL \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"mode":"fast"}'

# 查余额
curl $GET_BALANCE_URL -H "Authorization: Bearer $TOKEN"
```

## 修改前必读

如果你即将修改 `cloudbase/` 下的任何文件,先读 [docs/CREDITS_SYSTEM.md](../docs/CREDITS_SYSTEM.md)(在主仓库的文档目录)以了解整体设计和反作弊约束。
