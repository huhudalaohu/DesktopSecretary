/**
 * 用户积分的"懒初始化"工具函数(MySQL 版,迁自 doc DB 实现)。
 *
 * 任何接触 user_credits 表的入口(ai-proxy / get-balance / mock-pay / 未来的充值)
 * 都应该先调一次 ensureUserCredits,保证:
 *   1. 用户首次出现时建立 user_credits 行
 *   2. 一次性发放 welcome 积分,写一条 recharge_gift:welcome 流水
 *   3. 已发放过(welcomed_at IS NOT NULL)的账号不会重复发放
 *
 * SQL 版相对 doc DB 版的关键差异:
 *   - 接口签名变为 ensureUserCredits(uid, config) — 不再需要传 db,内部通过 _shared/mysql.js 拿连接
 *   - 整体包在 tx() 里,SELECT ... FOR UPDATE 行锁兜底并发首登,避免双发 welcome
 *
 * 返回字段名维持 camelCase 与原 doc DB 版本兼容:{balance, totalRecharged, totalConsumed, welcomedAt}
 * 调用方代码可以零改动地迁移。
 */

const { tx } = require('./mysql');

/**
 * @param {string} uid 用户 uid
 * @param {object} config app_config(至少要有 welcomeBonus)
 * @returns {Promise<{balance, totalRecharged, totalConsumed, welcomedAt}>}
 */
async function ensureUserCredits(uid, config) {
  if (!uid) throw new Error('[credits-init] uid 缺失');

  return await tx(async (conn) => {
    // 1. 行锁 + 查现状
    const [rows] = await conn.execute(
      'SELECT uid, balance, total_recharged, total_consumed, welcomed_at FROM user_credits WHERE uid = ? FOR UPDATE',
      [uid]
    );

    // 2. 已初始化 → 直接返回
    if (rows.length > 0 && rows[0].welcomed_at) {
      const r = rows[0];
      return {
        balance: r.balance,
        totalRecharged: r.total_recharged,
        totalConsumed: r.total_consumed,
        welcomedAt: r.welcomed_at,
      };
    }

    // 3. 首次初始化
    const bonus = Number(config && config.welcomeBonus) || 0;
    const now = new Date();

    if (rows.length === 0) {
      await conn.execute(
        `INSERT INTO user_credits (uid, balance, total_recharged, total_consumed, welcomed_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
        [uid, bonus, bonus, now, now]
      );
    } else {
      // 行已存在但没 welcomed_at(理论上不该出现,兜底)
      await conn.execute(
        `UPDATE user_credits
            SET balance         = balance + ?,
                total_recharged = total_recharged + ?,
                welcomed_at     = ?,
                updated_at      = ?
          WHERE uid = ?`,
        [bonus, bonus, now, now, uid]
      );
    }

    if (bonus > 0) {
      await conn.execute(
        `INSERT INTO credit_transactions (uid, type, amount, balance_after, meta, created_at)
         VALUES (?, 'recharge_gift', ?, ?, ?, ?)`,
        [uid, bonus, bonus, JSON.stringify({ reason: 'welcome' }), now]
      );
    }

    return {
      balance: bonus,
      totalRecharged: bonus,
      totalConsumed: 0,
      welcomedAt: now,
    };
  });
}

module.exports = { ensureUserCredits };
