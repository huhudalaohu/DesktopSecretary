/**
 * 用户积分的"懒初始化"工具函数(doc DB 版)。
 *
 * 任何接触 user_credits 的入口(ai-proxy / get-balance / direct-recharge)
 * 都应该先调一次 ensureUserCredits,保证:
 *   1. 用户首次出现时建立 user_credits 文档
 *   2. 一次性发放 welcome 积分,写一条 recharge_gift:welcome 流水
 *   3. 已发放过(welcomedAt字段存在)的账号不会重复发放
 *
 * 接口签名: ensureUserCredits(db, uid, config)
 * 返回: {balance, totalRecharged, totalConsumed, welcomedAt}
 */

/**
 * @param {object} db CloudBase doc DB 实例
 * @param {string} uid 用户 uid
 * @param {object} config app_config(至少要有 welcomeBonus)
 * @returns {Promise<{balance, totalRecharged, totalConsumed, welcomedAt}>}
 */
async function ensureUserCredits(db, uid, config) {
  if (!uid) throw new Error('[credits-init] uid 缺失');

  const _ = db.command;
  const creditsColl = db.collection('user_credits');
  const txColl = db.collection('credit_transactions');

  // 1. 查现存文档
  const doc = await creditsColl.doc(uid).get();
  const data = Array.isArray(doc.data) ? doc.data[0] : doc.data;
  const exists = data && (data._id || data.uid);

  if (exists && data.welcomedAt) {
    return {
      balance: data.balance || 0,
      totalRecharged: data.totalRecharged || 0,
      totalConsumed: data.totalConsumed || 0,
      welcomedAt: data.welcomedAt,
    };
  }

  // 2. 首次初始化
  const bonus = Number(config && config.welcomeBonus) || 0;
  const now = new Date();

  if (!exists) {
    await creditsColl.add({
      _id: uid,
      balance: bonus,
      totalRecharged: bonus,
      totalConsumed: 0,
      welcomedAt: now,
      updatedAt: now,
    });
  } else {
    // 行已存在但没 welcomedAt(理论上不该出现,兜底)
    await creditsColl.doc(uid).update({
      balance: _.inc(bonus),
      totalRecharged: _.inc(bonus),
      welcomedAt: now,
      updatedAt: now,
    });
  }

  if (bonus > 0) {
    await txColl.add({
      uid,
      type: 'recharge_gift',
      amount: bonus,
      balanceAfter: bonus,
      meta: { reason: 'welcome' },
      createdAt: now,
    });
  }

  return {
    balance: bonus,
    totalRecharged: bonus,
    totalConsumed: 0,
    welcomedAt: now,
  };
}

module.exports = { ensureUserCredits };
