import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Coins, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { createRechargeOrder, queryOrder, mockPayOrder, CallAIError } from '../../services/ai-proxy';

/**
 * RechargeModal — 充值弹窗(M.B 第一期 MOCK 模式)
 *
 * 三段式 UI:
 *   stage='input'    输入金额 → 确认 → 调 createRechargeOrder
 *   stage='paying'   显示二维码 + 倒计时 + 「模拟支付成功」按钮 → 调 mockPayOrder
 *                    同时每 2s 轮 queryOrder,直到 status !== 'pending'
 *   stage='success'  显示新余额,1.5s 后自动关闭
 *
 * 设计原则:
 *   - 渲染在 App.jsx 根级(zoom 容器外),用 fixed inset-0 z-[9999] 覆盖窗口
 *   - 服务端为单一真值,客户端只用 status / balanceAfter 做 UI 渲染
 *   - 关闭时不主动取消订单(订单 5min 自动过期);用户重新打开可继续支付
 */

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 90;        // 2s × 90 ≈ 3min,与默认订单 5min 过期错开
const SUCCESS_AUTO_CLOSE_MS = 1500;
const DEFAULT_YUAN = 10;
const MIN_YUAN = 5;
const MAX_YUAN = 1000;
const CREDITS_PER_YUAN_HINT = 100;   // 仅 UI 预估,服务端为准

function formatSeconds(s) {
  if (s <= 0) return '00:00';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export default function RechargeModal({ onClose }) {
  const [stage, setStage] = useState('input');   // 'input' | 'paying' | 'success' | 'expired' | 'failed'
  const [yuanInput, setYuanInput] = useState(String(DEFAULT_YUAN));
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [paying, setPaying] = useState(false);
  const [order, setOrder] = useState(null);      // { orderId, qrCodeData, expiresAt, credits, payAmount }
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [newBalance, setNewBalance] = useState(null);

  const mountedRef = useRef(true);
  const inputRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // input 阶段:首次渲染聚焦
  useEffect(() => {
    if (stage === 'input' && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [stage]);

  // ESC 关闭(success 阶段也允许立即关闭)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // success 阶段 → 自动关闭
  useEffect(() => {
    if (stage !== 'success') return;
    const t = setTimeout(() => {
      if (mountedRef.current) onClose?.();
    }, SUCCESS_AUTO_CLOSE_MS);
    return () => clearTimeout(t);
  }, [stage, onClose]);

  // 倒计时(paying 阶段)
  useEffect(() => {
    if (stage !== 'paying' || !order?.expiresAt) return;
    const tick = () => {
      const diff = Math.max(0, Math.floor((new Date(order.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(diff);
      if (diff <= 0) setStage('expired');
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [stage, order]);

  // 轮询(paying 阶段)
  useEffect(() => {
    if (stage !== 'paying' || !order?.orderId) return;
    let attempts = 0;
    let cancelled = false;

    const poll = async () => {
      attempts += 1;
      try {
        const r = await queryOrder(order.orderId);
        if (cancelled || !mountedRef.current) return;
        if (r.status === 'paid') {
          // balanceAfter 可能由 mockPayOrder 已设置(并发场景);兜底用 credits 估算
          setNewBalance((prev) => prev != null ? prev : null);
          setStage('success');
          return true;
        }
        if (r.status === 'expired') {
          setStage('expired');
          return true;
        }
        if (r.status === 'failed') {
          setError('订单失败');
          setStage('failed');
          return true;
        }
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        if (err instanceof CallAIError && err.code === 'NOT_LOGGED_IN') {
          setError('登录已过期,请重新登录');
          setStage('failed');
          return true;
        }
        // 网络抖动不退出,继续轮
      }
      return false;
    };

    const tick = async () => {
      const done = await poll();
      if (done || cancelled || !mountedRef.current) return;
      if (attempts >= MAX_POLL_ATTEMPTS) {
        setError('支付超时,请重新发起');
        setStage('failed');
        return;
      }
    };

    const handle = setInterval(tick, POLL_INTERVAL_MS);
    // 首次立刻打一次,避免 2s 等待
    tick();
    return () => { cancelled = true; clearInterval(handle); };
  }, [stage, order]);

  const yuanNum = useMemo(() => {
    const n = Math.floor(Number(yuanInput));
    return Number.isFinite(n) ? n : 0;
  }, [yuanInput]);

  const isAmountValid = yuanNum >= MIN_YUAN && yuanNum <= MAX_YUAN;
  const previewCredits = isAmountValid ? yuanNum * CREDITS_PER_YUAN_HINT : 0;

  const handleSubmitAmount = async () => {
    if (!isAmountValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await createRechargeOrder({ amount: yuanNum * 100 });
      if (!mountedRef.current) return;
      setOrder(r);
      setStage('paying');
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof CallAIError) {
        if (err.code === 'INVALID_AMOUNT') setError(err.message || '金额超出允许范围');
        else if (err.code === 'PAYMENT_DISABLED') setError('充值通道暂时关闭');
        else if (err.code === 'NOT_LOGGED_IN') setError('请先登录');
        else setError(err.message || '创建订单失败');
      } else {
        setError(err?.message || '创建订单失败');
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const handleMockPay = async () => {
    if (!order?.orderId || paying) return;
    setPaying(true);
    setError(null);
    try {
      const r = await mockPayOrder(order.orderId);
      if (!mountedRef.current) return;
      if (r.success && typeof r.balanceAfter === 'number') {
        setNewBalance(r.balanceAfter);
        setStage('success');
      }
      // 否则继续等轮询(理论上 success 直接命中)
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof CallAIError) {
        if (err.code === 'ORDER_CONFLICT' || err.code === 'ORDER_NOT_PENDING') {
          setError('订单状态已变更,请刷新或重新发起');
        } else if (err.code === 'ORDER_EXPIRED') {
          setStage('expired');
        } else if (err.code === 'MOCK_DISABLED') {
          setError('生产环境不支持模拟支付');
        } else {
          setError(err.message || '支付失败');
        }
      } else {
        setError(err?.message || '支付失败');
      }
    } finally {
      if (mountedRef.current) setPaying(false);
    }
  };

  const handleRestart = () => {
    setOrder(null);
    setError(null);
    setNewBalance(null);
    setSecondsLeft(0);
    setStage('input');
  };

  // ============= 渲染 =============

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="w-[300px] bg-white rounded-xl shadow-2xl border border-[#E5E5E5] overflow-hidden">
        {/* 标题 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#F0F0F0]">
          <div className="flex items-center gap-1.5">
            <Coins size={14} className="text-amber-500" />
            <span className="text-[12px] font-semibold text-gray-800">积分充值</span>
          </div>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-[#EBEBEB] text-gray-400 hover:text-gray-600 transition-colors"
            title="关闭 (Esc)"
          >
            <X size={12} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-4 py-3 space-y-3">
          {error && (
            <div className="flex items-start gap-1.5 text-[10px] rounded-md px-2 py-1.5 text-red-600 bg-red-50 border border-red-200">
              <AlertCircle size={11} className="flex-shrink-0 mt-[1px]" />
              <span>{error}</span>
            </div>
          )}

          {stage === 'input' && (
            <>
              <div>
                <div className="text-[10px] text-gray-500 mb-1">充值金额(¥{MIN_YUAN}~¥{MAX_YUAN})</div>
                <div className="flex items-center gap-1">
                  <span className="text-[16px] text-gray-400">¥</span>
                  <input
                    ref={inputRef}
                    type="number"
                    min={MIN_YUAN}
                    max={MAX_YUAN}
                    step="1"
                    value={yuanInput}
                    onChange={(e) => setYuanInput(e.target.value.replace(/[^\d]/g, ''))}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitAmount(); }}
                    className="flex-1 px-2 py-1.5 text-[16px] font-semibold border border-[#E5E5E5] rounded focus:outline-none focus:border-[#0099FF]"
                    placeholder={String(DEFAULT_YUAN)}
                  />
                </div>
                <div className="mt-1 text-[10px] text-gray-400">
                  {isAmountValid
                    ? <>将获得 <span className="text-amber-600 font-medium">{previewCredits}</span> 积分(¥1 = {CREDITS_PER_YUAN_HINT} 积分)</>
                    : <span className="text-red-500">金额需在 ¥{MIN_YUAN}~¥{MAX_YUAN} 之间</span>
                  }
                </div>
              </div>

              <button
                onClick={handleSubmitAmount}
                disabled={!isAmountValid || submitting}
                className="w-full py-2 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
              >
                {submitting && <Loader2 size={12} className="animate-spin" />}
                {submitting ? '创建订单中...' : '确认充值'}
              </button>
            </>
          )}

          {stage === 'paying' && order && (
            <>
              <div className="text-center space-y-1.5">
                <div className="text-[10px] text-gray-400">订单号</div>
                <div className="text-[10px] text-gray-600 font-mono">{order.orderId}</div>
                <div className="flex items-center justify-center gap-2 pt-1">
                  <span className="text-[10px] text-gray-400">金额</span>
                  <span className="text-[16px] font-semibold text-gray-800">¥{(order.payAmount / 100).toFixed(2)}</span>
                  <span className="text-[10px] text-amber-600">→ {order.credits} 积分</span>
                </div>
              </div>

              <div className="flex justify-center py-1">
                {order.qrCodeData ? (
                  <img src={order.qrCodeData} alt="二维码" className="w-[140px] h-[140px] border border-[#E5E5E5] rounded" />
                ) : (
                  <div className="w-[140px] h-[140px] flex items-center justify-center text-[10px] text-gray-400 border border-dashed border-gray-300 rounded">
                    无二维码
                  </div>
                )}
              </div>

              <div className="text-center text-[10px] text-gray-500">
                剩余 <span className="font-mono text-amber-600">{formatSeconds(secondsLeft)}</span>
              </div>

              <button
                onClick={handleMockPay}
                disabled={paying || secondsLeft <= 0}
                className="w-full py-2 rounded bg-green-500 hover:bg-green-600 text-white text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
              >
                {paying && <Loader2 size={12} className="animate-spin" />}
                {paying ? '处理中...' : '模拟支付成功 (MOCK)'}
              </button>

              <button
                onClick={onClose}
                className="w-full py-1.5 rounded text-[11px] text-gray-500 hover:bg-[#F5F5F5] transition-colors"
              >
                取消
              </button>
            </>
          )}

          {stage === 'success' && (
            <div className="py-3 text-center space-y-2">
              <CheckCircle2 size={36} className="mx-auto text-green-500" />
              <div className="text-[13px] font-medium text-gray-800">充值成功</div>
              {order && (
                <div className="text-[11px] text-amber-600">
                  +{order.credits} 积分
                </div>
              )}
              {newBalance != null && (
                <div className="text-[10px] text-gray-500">
                  当前余额:<span className="text-gray-800 font-semibold">{newBalance}</span>
                </div>
              )}
            </div>
          )}

          {stage === 'expired' && (
            <>
              <div className="py-3 text-center space-y-1.5">
                <AlertCircle size={28} className="mx-auto text-orange-400" />
                <div className="text-[12px] font-medium text-gray-700">订单已过期</div>
                <div className="text-[10px] text-gray-500">请重新发起充值</div>
              </div>
              <button
                onClick={handleRestart}
                className="w-full py-2 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[12px] font-medium transition-colors"
              >
                重新充值
              </button>
            </>
          )}

          {stage === 'failed' && (
            <>
              <div className="py-3 text-center space-y-1.5">
                <AlertCircle size={28} className="mx-auto text-red-400" />
                <div className="text-[12px] font-medium text-gray-700">支付失败</div>
                {error && <div className="text-[10px] text-gray-500">{error}</div>}
              </div>
              <button
                onClick={handleRestart}
                className="w-full py-2 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[12px] font-medium transition-colors"
              >
                重新发起
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
