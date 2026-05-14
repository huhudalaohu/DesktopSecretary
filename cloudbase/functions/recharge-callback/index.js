/**
 * 云函数: recharge-callback
 *
 * 真实支付渠道(微信支付 / 支付宝)的异步通知入口。
 *
 * 本函数当前是 **占位实现** — M.B 一期走 MOCK,客户端只调 mock-pay,不会有外部
 * 调用打到这里。M.B 二期接入真渠道时再实现:
 *
 *   1. **无鉴权**: 调用方是支付网关,不带 AccessToken;改用渠道签名校验
 *   2. 微信:验 wechatpay-signature / 序列号,解密 resource → 提取 transaction_id
 *   3. 支付宝:验 sign / 商户公钥
 *   4. 用 thirdTradeNo 唯一索引拦截重放(数据库层面)
 *   5. 复用与 mock-pay 一样的乐观锁/加分/写流水路径
 *   6. 按渠道格式返回成功体(微信: `{code:'SUCCESS', message:'OK'}`)
 *
 * 部署:
 *   - 触发器: HTTP 访问服务,**「未登录用户」也要放行**(渠道不会带身份)
 *   - 接入真渠道前应在控制台关掉这个函数对未登录用户的入口,避免被恶意调用
 *   - 依赖: @cloudbase/node-sdk(本期未使用,二期接入时启用)
 */

const { fail, handleOptions } = require('./lib/response');

exports.main = async (event) => {
  const corsResp = handleOptions(event);
  if (corsResp) return corsResp;

  // 占位:本轮 MOCK 模式不应有人调用到这里。
  console.warn('[recharge-callback] 收到回调,但当前 provider=mock,理论上不应触发。', {
    method: event && event.httpMethod,
    headers: event && event.headers,
  });
  return fail(501, 'recharge-callback 暂未实现(等接入真实支付渠道后启用)', { code: 'NOT_IMPLEMENTED' });
};
