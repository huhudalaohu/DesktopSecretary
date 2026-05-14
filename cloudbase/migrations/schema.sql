-- CloudBase MySQL 8.0 schema for credits / recharge module.
--
-- 三张表:
--   user_credits         一用户一行,balance / totalRecharged / totalConsumed / welcomedAt
--   credit_transactions  扣分 / 充值 / 赠送流水,append-only
--   recharge_orders      充值订单状态机
--
-- 说明:
--   - 一律 InnoDB + utf8mb4,无 CHECK (balance>=0):业务层 ai-proxy 已在扣分前 402 拦截
--     且历史数据迁移可能短暂出现 balance<0(理论上不应该,但 CHECK 报错会导致整个迁移卡住)
--   - timestamp 字段使用 MySQL 默认行为,连接侧通过 mysql.js 强制 timezone='+00:00' 保证一致
--   - meta 用 JSON 列(MySQL 8.0 原生),配合 ai-proxy 的日用量聚合 JSON_EXTRACT 提取 totalTokens
--   - recharge_orders.third_trade_no UNIQUE 但允许多 NULL:同时存在 N 个 pending(无交易号)
--     但只能有一个 paid 用同一交易号,防回调重放
--
-- 使用方式:
--   1. CloudBase 控制台 → SQL 型数据库 → 数据库管理 → SQL 编辑器,粘贴执行
--   2. 或本地 mysql -h <host> -P 3306 -u <user> -p <db> < schema.sql

CREATE TABLE IF NOT EXISTS user_credits (
  uid              VARCHAR(64)  PRIMARY KEY,
  balance          INT          NOT NULL DEFAULT 0,
  total_recharged  INT          NOT NULL DEFAULT 0,
  total_consumed   INT          NOT NULL DEFAULT 0,
  welcomed_at      TIMESTAMP    NULL DEFAULT NULL,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_transactions (
  id             BIGINT       AUTO_INCREMENT PRIMARY KEY,
  uid            VARCHAR(64)  NOT NULL,
  type           ENUM('consume','recharge_paid','recharge_gift','admin_adjust') NOT NULL,
  amount         INT          NOT NULL,
  balance_after  INT          NOT NULL,
  meta           JSON         NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_uid_created (uid, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recharge_orders (
  id              VARCHAR(64)   PRIMARY KEY,                -- = outTradeNo,业务侧生成
  uid             VARCHAR(64)   NOT NULL,
  channel         ENUM('mock','wechat','alipay') NOT NULL,
  pay_amount      INT           NOT NULL,                   -- 单位:分
  credits         INT           NOT NULL,
  status          ENUM('pending','paid','failed','expired') NOT NULL DEFAULT 'pending',
  qr_code_data    TEXT          NULL,
  third_trade_no  VARCHAR(128)  NULL DEFAULT NULL,
  fail_reason     VARCHAR(256)  NULL DEFAULT NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      TIMESTAMP     NULL DEFAULT NULL,
  paid_at         TIMESTAMP     NULL DEFAULT NULL,
  INDEX idx_uid_created (uid, created_at DESC),
  UNIQUE INDEX idx_third_trade_no (third_trade_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
