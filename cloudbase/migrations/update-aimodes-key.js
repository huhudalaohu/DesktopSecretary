/**
 * 迁移脚本: 把 aiModes.fast/precise 的 apiKey/models/model/baseUrl/provider 一次写入 app_config/global
 *
 * 用法 (单引号包裹避免 shell 解释):
 *   node cloudbase/migrations/update-aimodes-key.js \
 *     --apiKey 'sk-xxx' \
 *     --baseUrl 'https://dashscope.aliyuncs.com/compatible-mode/v1' \
 *     --models 'kimi-k2.6,qwen-plus,qwen-turbo' \
 *     --provider 'dashscope' \
 *     [--mode all|fast|precise]   // 默认 all,同时改两个
 *     [--model 'kimi-k2.6']        // 可选,兜底单值;不填则取 models[0]
 *
 * 注意: app_config/global 必须已存在(先跑 seed-app-config.js)。
 *       此脚本只改 aiModes 字段,不动其它配置。
 *       models 是有序数组,ai-proxy 顺序尝试,首选失败自动降级。
 */

try { require('dotenv').config(); } catch {}

const path = require('path');
const fs = require('fs');

const ENV_ID = process.env.TCB_ENV_ID || 'ds-dev-d9g28xlrgd2600837';
const args = process.argv.slice(2);

function getArg(name, fallback = '') {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1] || fallback;
}

const apiKey = getArg('apiKey');
const baseUrl = getArg('baseUrl');
const modelsRaw = getArg('models');
const modelSingle = getArg('model');
const provider = getArg('provider', 'custom');
const mode = (getArg('mode', 'all') || 'all').toLowerCase();

const models = modelsRaw
  ? modelsRaw.split(',').map(s => s.trim()).filter(Boolean)
  : (modelSingle ? [modelSingle] : []);
const model = modelSingle || models[0] || '';

if (!apiKey) {
  console.error('[update-aimodes-key] 必须提供 --apiKey');
  process.exit(1);
}
if (!baseUrl) {
  console.error('[update-aimodes-key] 必须提供 --baseUrl');
  process.exit(1);
}
if (models.length === 0) {
  console.error('[update-aimodes-key] 必须提供 --models a,b,c 或 --model x');
  process.exit(1);
}
if (!['all', 'fast', 'precise'].includes(mode)) {
  console.error(`[update-aimodes-key] --mode 必须是 all/fast/precise, 实际: ${mode}`);
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
    console.error('[update-aimodes-key] 缺少 TCB_SECRET_ID / TCB_SECRET_KEY');
    process.exit(1);
  }

  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: ENV_ID, secretId, secretKey });
  const db = app.database();
  const coll = db.collection('app_config');

  const { data: docData } = await coll.doc('global').get();
  const existing = Array.isArray(docData) ? docData[0] : docData;
  if (!existing) {
    console.error('[update-aimodes-key] app_config/global 不存在,先跑 seed-app-config.js');
    process.exit(1);
  }

  const aiModes = { ...(existing.aiModes || {}) };
  const newEntry = { provider, model, models, baseUrl, apiKey };

  const targets = mode === 'all' ? ['fast', 'precise'] : [mode];
  for (const t of targets) {
    aiModes[t] = { ...(aiModes[t] || {}), ...newEntry };
  }

  await coll.doc('global').update({
    aiModes,
    updatedAt: new Date(),
  });

  const masked = apiKey.length > 10 ? `${apiKey.slice(0, 6)}***${apiKey.slice(-4)}` : '***';
  console.log(`[update-aimodes-key] 已更新 aiModes.${targets.join(', aiModes.')}`);
  console.log(`  provider = ${provider}`);
  console.log(`  baseUrl  = ${baseUrl}`);
  console.log(`  models   = [${models.join(', ')}]`);
  console.log(`  model    = ${model}  (向后兼容兜底)`);
  console.log(`  apiKey   = ${masked}`);
}

main().catch(err => {
  console.error('[update-aimodes-key] 失败:', err);
  process.exit(1);
});
