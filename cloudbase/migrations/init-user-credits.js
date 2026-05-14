/**
 * 迁移脚本: 为现有 users 集合里的所有用户初始化 user_credits 文档,送 500 积分
 *
 * 用途:
 *   积分系统上线时,一次性把历史用户也加进 user_credits 集合(_id = uid),
 *   并各送 500 积分作为欢迎礼。每位用户写一条 credit_transactions 流水。
 *
 * 用法:
 *   node cloudbase/migrations/init-user-credits.js              # 实跑
 *   node cloudbase/migrations/init-user-credits.js --dry        # 干跑,只打印不写
 *   node cloudbase/migrations/init-user-credits.js --bonus=300  # 自定义赠送数(默认 500)
 *
 * 幂等性:
 *   - 已存在 user_credits 文档的用户会被跳过
 *   - 重跑安全
 */

try { require('dotenv').config(); } catch {}

const path = require('path');
const fs = require('fs');

const ENV_ID = process.env.TCB_ENV_ID || 'ds-dev-d9g28xlrgd2600837';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const bonusArg = argv.find(a => a.startsWith('--bonus='));
const BONUS = bonusArg ? parseInt(bonusArg.split('=')[1], 10) : 500;

if (!Number.isFinite(BONUS) || BONUS < 0) {
  console.error('[init-user-credits] --bonus 必须是非负整数');
  process.exit(1);
}

function loadCredentials() {
  let secretId = process.env.TCB_SECRET_ID;
  let secretKey = process.env.TCB_SECRET_KEY;
  if (secretId && secretKey) return { secretId, secretKey };

  const configPath = path.join(__dirname, '..', '..', 'config', 'publish-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { secretId: c.secretId, secretKey: c.secretKey };
    } catch {}
  }
  return { secretId: null, secretKey: null };
}

async function main() {
  const { secretId, secretKey } = loadCredentials();
  if (!secretId || !secretKey) {
    console.error('[init-user-credits] 缺少 TCB_SECRET_ID / TCB_SECRET_KEY');
    process.exit(1);
  }

  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: ENV_ID, secretId, secretKey });
  const db = app.database();
  const usersColl = db.collection('users');
  const creditsColl = db.collection('user_credits');
  const txColl = db.collection('credit_transactions');

  console.log(`[init-user-credits] 模式: ${DRY ? 'DRY-RUN(不写)' : '实跑'}, 赠送积分: ${BONUS}\n`);

  // 1. 拉所有用户(分页,每次 100)
  const allUsers = [];
  let offset = 0;
  const PAGE = 100;
  while (true) {
    const { data } = await usersColl.skip(offset).limit(PAGE).get();
    if (!data || data.length === 0) break;
    allUsers.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  console.log(`[init-user-credits] 找到 ${allUsers.length} 个用户`);

  // 2. 批量处理
  let createdCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const u of allUsers) {
    const uid = u._id;
    const email = u.username || '';
    if (!uid) {
      console.warn('  跳过无 _id 的用户:', JSON.stringify(u).slice(0, 100));
      errorCount++;
      continue;
    }

    // 查是否已有 credits 文档
    let exists = false;
    try {
      const { data } = await creditsColl.doc(uid).get();
      const doc = Array.isArray(data) ? data[0] : data;
      exists = !!doc;
    } catch {}

    if (exists) {
      skippedCount++;
      continue;
    }

    if (DRY) {
      console.log(`  [DRY] 将创建 user_credits/${uid} (${email}) 余额=${BONUS}`);
      createdCount++;
      continue;
    }

    try {
      const now = new Date();
      await creditsColl.doc(uid).set({
        balance: BONUS,
        totalRecharged: BONUS,
        totalConsumed: 0,
        updatedAt: now,
      });
      if (BONUS > 0) {
        await txColl.add({
          uid,
          type: 'recharge_gift',
          amount: BONUS,
          balanceAfter: BONUS,
          meta: { reason: 'migration:initial' },
          createdAt: now,
        });
      }
      console.log(`  ✓ 已创建 user_credits/${uid} (${email}) +${BONUS} 积分`);
      createdCount++;
    } catch (err) {
      console.error(`  ✗ 失败 ${uid} (${email}):`, err.message);
      errorCount++;
    }
  }

  console.log(`\n[init-user-credits] 完成 — 创建: ${createdCount}, 跳过(已存在): ${skippedCount}, 失败: ${errorCount}`);
}

main().catch(err => {
  console.error('[init-user-credits] 失败:', err);
  process.exit(1);
});
