# 数据库集合 Schema 定义

CloudBase 是文档型数据库(类似 MongoDB),无强 schema,但下文是**约定的字段结构**——所有云函数和迁移脚本必须遵守。

## `users` (已存在,不动)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `_id` | string | √ | 自动生成,即 uid |
| `username` | string | √ | 邮箱(已小写化) |
| `passwordHash` | string | √ | bcrypt(saltRounds=10) |
| `createdAt` | Date | √ | 注册时间 |
| `lastLoginAt` | Date | √ | 最后登录时间 |

## `user_credits` (新增)

主键:**doc id = uid**(与 `users._id` 一致),便于 O(1) 查找和原子操作。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `_id` | string | √ | uid(== users._id) |
| `balance` | number | √ | 当前余额(整数,可为 0,**不允许负数**) |
| `totalRecharged` | number | √ | 累计充值(含赠送和迁移) |
| `totalConsumed` | number | √ | 累计消耗(永远是正数,记录消耗总量) |
| `updatedAt` | Date | √ | 最后修改时间 |

> 原子操作:扣分用 `db.command.inc(-credits)` 同时改 `balance` 和 `totalConsumed`。  
> 加分用 `db.command.inc(+credits)` 同时改 `balance` 和 `totalRecharged`。  
> **不允许直接 `update({ balance: x })`**,必须用 inc 保证并发安全。

## `credit_transactions` (新增)

每次扣分/加分都写一条不可变流水。**只增不删**,审计用。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `_id` | string | √ | 自动生成 |
| `uid` | string | √ | 关联用户 |
| `type` | enum | √ | `consume` / `recharge_paid` / `recharge_gift` / `admin_adjust` |
| `amount` | number | √ | **正数=进账,负数=消耗**(如 consume 时为 -2) |
| `balanceAfter` | number | √ | 操作完成后的余额(便于对账) |
| `meta` | object | √ | 上下文,见下表 |
| `createdAt` | Date | √ | 写入时间 |

### `meta` 字段(按 type 取舍)

```js
// type='consume':AI 消耗
meta = {
  mode: 'fast' | 'precise',
  provider: 'moonshot',
  model: 'moonshot-v1-8k',
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  source: 'screenshot' | 'quicklink' | 'settings_test'  // 调用来源
}

// type='recharge_paid':付费充值
meta = {
  orderId: 'xxxx',
  payAmount: 5000,            // 单位:分
  channel: 'wechat' | 'alipay'
}

// type='recharge_gift':赠送
meta = {
  reason: 'welcome' | 'welcome_migration' | 'promo:CODE'
}

// type='admin_adjust':后台手动调整
meta = {
  operator: 'huhudalaohu',    // 操作人(后台账号或姓名)
  reason: '人工补偿'
}
```

## `recharge_orders` (新增,Milestone B 才用到)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `_id` | string | √ | outTradeNo 业务订单号 |
| `uid` | string | √ | 下单用户 |
| `channel` | enum | √ | `wechat` / `alipay` |
| `payAmount` | number | √ | 支付金额(分) |
| `credits` | number | √ | 该订单到账积分 |
| `status` | enum | √ | `pending` / `paid` / `expired` / `refunded` |
| `prepayId` | string |  | 微信/支付宝预下单返回 |
| `qrCode` | string |  | 收银台二维码 URL |
| `thirdTradeNo` | string |  | 第三方交易号(回调时填,**唯一索引**防重放) |
| `paidAt` | Date |  | 支付完成时间 |
| `createdAt` | Date | √ | |
| `expiresAt` | Date | √ | 默认 15 分钟 |

## `app_config` (新增)

**只有一个文档**,doc id = `'global'`。

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `_id` | string | `'global'` | 固定值 |
| `tokensPerCredit` | number | 1000 | 多少 token 等价于 1 积分,后台可改 |
| `welcomeBonus` | number | 500 | 新用户注册赠送积分 |
| `aiModes.fast.provider` | string |  | 快速模式的 provider 标识(任意,目前服务端只识别 OpenAI 兼容格式) |
| `aiModes.fast.model` | string |  | 模型名 |
| `aiModes.fast.baseUrl` | string |  | API 根 URL(不带 `/chat/completions`) |
| `aiModes.fast.apiKey` | string |  | **后台填**,Bearer token |
| `aiModes.precise.*` | 同上 |  | 精准模式 |
| `recharge.minAmount` | number | 500 | 最低充值(分),默认 5 元 |
| `recharge.maxAmount` | number | 100000 | 最高单次充值(分) |
| `recharge.creditsPerYuan` | number | 100 | 1 元 = 多少积分 |
| `dailyUidConsumeLimit` | number | 500000 | 单用户单日 token 上限,反滥用 |
| `maintenance` | boolean | false | 维护模式,true 时所有 ai-proxy 拒绝 |

> ⚠️ `app-config` 云函数返回给客户端时**强制脱敏**(过滤所有 `apiKey` 字段)。
