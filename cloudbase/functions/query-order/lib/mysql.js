/**
 * CloudBase MySQL 连接管理 + 事务封装。
 *
 * 设计要点:
 *   - 单实例单长连接:云函数实例间隔执行复用同一连接(避免每次请求 TCP 握手 + auth)
 *   - 调用前 ping 探活,断了重连(MySQL wait_timeout 默认 28800s,云函数实例本身寿命更短,
 *     通常不会超时,但 auto-sleep 模式实例休眠唤醒后旧连接可能已断)
 *   - 并发请求等同一个 pending promise,避免连接风暴
 *   - tx(fn) 包裹 beginTransaction / commit / rollback,业务函数抛错自动回滚
 *
 * 环境变量(在 CloudBase 控制台 → 云函数 → 环境变量 配置):
 *   DB_HOST       MySQL 内网地址(VPC 内访问)
 *   DB_PORT       端口,默认 3306
 *   DB_USER       用户名
 *   DB_PASSWORD   密码
 *   DB_NAME       库名
 *
 * 用法:
 *   const { getConnection, tx } = require('./lib/mysql');
 *   // 单条查询:
 *   const conn = await getConnection();
 *   const [rows] = await conn.execute('SELECT ... WHERE uid = ?', [uid]);
 *   // 多步事务:
 *   const r = await tx(async (conn) => {
 *     await conn.execute(...);
 *     await conn.execute(...);
 *     return { ok: true };
 *   });
 */

const mysql = require('mysql2/promise');

let active = null;
let pending = null;

function readConfig() {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;
  const port = Number(process.env.DB_PORT) || 3306;
  if (!host || !user || !password || !database) {
    throw new Error('[mysql] DB_HOST / DB_USER / DB_PASSWORD / DB_NAME 未配置,请检查云函数环境变量');
  }
  return {
    host,
    user,
    password,
    database,
    port,
    timezone: '+00:00',     // 统一 UTC,避免主进程/云函数时区漂移
    dateStrings: false,     // 让 mysql2 把 TIMESTAMP 解析成 Date 对象
    charset: 'utf8mb4',
    connectTimeout: 10 * 1000,
    // 不开 stringifyObjects,JSON 列我们自己 JSON.stringify
  };
}

async function getConnection() {
  if (active) {
    try {
      await active.ping();
      return active;
    } catch (err) {
      console.warn('[mysql] ping 失败,丢弃旧连接重建:', err && err.message);
      try { await active.end(); } catch {}
      active = null;
    }
  }
  if (!pending) {
    const cfg = readConfig();
    // 冷启动时 VPC ENI 可能尚未就绪,偶发 ETIMEDOUT/ECONNREFUSED —— 失败后 1s 重试一次
    pending = mysql.createConnection(cfg)
      .catch((err) => {
        console.warn('[mysql] 首次连接失败,1s 后重试一次:', err && err.message);
        return new Promise((r) => setTimeout(r, 1000)).then(() => mysql.createConnection(cfg));
      })
      .then((conn) => {
        active = conn;
        pending = null;
        return conn;
      })
      .catch((err) => {
        pending = null;
        throw err;
      });
  }
  return await pending;
}

/**
 * 包裹一段业务为单事务。任一步骤抛错则 ROLLBACK,正常返回则 COMMIT。
 *
 * 注意:不要在 tx 里再调 tx —— mysql2 同一连接不支持嵌套事务,会撞 ER_BAD_FIELD_ERROR。
 * 如果业务确实需要嵌套,改用 SAVEPOINT(本项目暂无此需求)。
 */
async function tx(fn) {
  const conn = await getConnection();
  await conn.beginTransaction();
  let result;
  try {
    result = await fn(conn);
  } catch (err) {
    try { await conn.rollback(); } catch (e) {
      console.warn('[mysql] rollback 失败:', e && e.message);
    }
    throw err;
  }
  try {
    await conn.commit();
  } catch (err) {
    // commit 失败 — 极少见(网络中断),保险起见再 rollback 一次
    try { await conn.rollback(); } catch {}
    throw err;
  }
  return result;
}

/**
 * 业务错误:在 tx 回调里抛出,事务会回滚,外层根据 statusCode/code 转 fail() 响应。
 * 用 throw new BizError(409, 'ORDER_CONFLICT', '订单状态已变更') 比传 status 字段更顺手。
 */
class BizError extends Error {
  constructor(statusCode, code, message) {
    super(message || code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

module.exports = { getConnection, tx, BizError };
