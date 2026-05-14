/**
 * 迁移脚本: 初始化 app_config/global 文档
 *
 * 用途:
 *   首次部署积分系统时,在 CloudBase 数据库 app_config 集合写入默认配置文档。
 *   已存在则不覆盖(除非加 --force)。
 *
 * 用法:
 *   node cloudbase/migrations/seed-app-config.js                # 仅写不存在的字段
 *   node cloudbase/migrations/seed-app-config.js --force        # 强制覆盖
 *   node cloudbase/migrations/seed-app-config.js --print        # 仅打印当前文档
 *
 * 环境变量(同主进程):
 *   TCB_ENV_ID         (默认 ds-dev-d9g28xlrgd2600837)
 *   TCB_SECRET_ID      腾讯云 SecretId
 *   TCB_SECRET_KEY     腾讯云 SecretKey
 *
 * 注意: 写入完成后,你需要去 CloudBase 控制台手动填 aiModes.fast/precise 的 apiKey。
 *       这个脚本只填占位字符串,绝不能把真 key 写进 git。
 */

try { require('dotenv').config(); } catch {}

const path = require('path');
const fs = require('fs');

const ENV_ID = process.env.TCB_ENV_ID || 'ds-dev-d9g28xlrgd2600837';
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const PRINT_ONLY = argv.includes('--print');

const DEFAULT_CONFIG = {
  _id: 'global',
  tokensPerCredit: 1000,
  welcomeBonus: 500,
  aiModes: {
    // models 数组:ai-proxy 顺序尝试,首选失败自动降级到下一个。
    // model 字段保留为单值兜底,新版只看 models[0]。
    fast: {
      provider: 'dashscope',
      model: 'kimi-k2.6',
      models: ['kimi-k2.6', 'qwen-plus', 'qwen-turbo'],
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: '',
    },
    precise: {
      provider: 'dashscope',
      model: 'kimi-k2.6',
      models: ['kimi-k2.6', 'qwen-max', 'qwen-plus'],
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: '',
    },
  },
  recharge: {
    minAmount: 500,
    maxAmount: 100000,
    creditsPerYuan: 100,
  },
  payment: {
    provider: 'mock',
    enabled: true,
    orderExpireSeconds: 300,
    wechat: { mchid: '', certSerial: '', privateKey: '', apiV3Key: '', notifyUrl: '' },
    alipay: { appId: '', privateKey: '', alipayPublicKey: '', notifyUrl: '' },
  },
  dailyUidConsumeLimit: 500000,
  maintenance: false,
  updatedAt: new Date(),
};

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
    console.error('[seed-app-config] 缺少 TCB_SECRET_ID / TCB_SECRET_KEY');
    process.exit(1);
  }

  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: ENV_ID, secretId, secretKey });
  const db = app.database();

  // 0. 确保所需集合存在(首次部署时 CloudBase 不会自动建集合)
  const REQUIRED_COLLECTIONS = ['app_config', 'user_credits', 'credit_transactions', 'recharge_orders'];
  for (const name of REQUIRED_COLLECTIONS) {
    try {
      await db.createCollection(name);
      console.log(`[seed-app-config] 已创建集合: ${name}`);
    } catch (err) {
      const msg = (err && (err.message || err.errMsg)) || '';
      // 已存在的报错忽略,其它继续抛
      if (/exist/i.test(msg) || /ResourceInUse/i.test(err?.code || '') || /already/i.test(msg)) {
        console.log(`[seed-app-config] 集合 ${name} 已存在`);
      } else {
        throw err;
      }
    }
  }

  const coll = db.collection('app_config');

  // 1. 读现有
  let existing = null;
  try {
    const { data } = await coll.doc('global').get();
    existing = Array.isArray(data) ? data[0] : data;
  } catch {}

  if (PRINT_ONLY) {
    console.log('当前 app_config/global:');
    console.log(JSON.stringify(existing || null, null, 2));
    return;
  }

  if (existing && !FORCE) {
    console.log('[seed-app-config] 文档已存在,跳过(用 --force 强制覆盖)');
    console.log('当前内容:');
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  // 2. 写入(set 是 upsert)
  const payload = { ...DEFAULT_CONFIG };
  delete payload._id; // CloudBase 限制
  await coll.doc('global').set(payload);
  console.log(`[seed-app-config] ${existing ? '已覆盖' : '已创建'} app_config/global`);
  console.log(JSON.stringify({ _id: 'global', ...payload }, null, 2));
  console.log('\n下一步: 去 CloudBase 控制台 → 数据库 → app_config 集合 → global 文档,');
  console.log('      把 aiModes.fast.apiKey 和 aiModes.precise.apiKey 填上你的真 API Key。');
}

main().catch(err => {
  console.error('[seed-app-config] 失败:', err);
  process.exit(1);
});
