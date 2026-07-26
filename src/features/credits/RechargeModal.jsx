import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Coins, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { directRecharge, CallAIError } from '../../services/ai-proxy';

/**
 * RechargeModal — 充值弹窗(简化版:一步直达)
 *
 * 两段式 UI:
 *   stage='input'     输入金额 → 确认 → 调 directRecharge
 *   stage='success'   显示充值成功 + 新余额 → 1.5s 后自动关闭
 *
 * 设计原则:
 *   - 渲染在 App.jsx 根级(zoom 容器外),用 fixed inset-0 z-[9999] 覆盖窗口
 *   - 服务端为单一真值,客户端只用返回的 balanceAfter 做 UI 渲染
 */

const SUCCESS_AUTO_CLOSE_MS = 1500;
const DEFAULT_YUAN = 10;
const MIN_YUAN = 5;
const MAX_YUAN = 1000;
const CREDITS_PER_YUAN_HINT = 100;   // 仅 UI 预估,服务端为准

export default function RechargeModal({ onClose }) {
  const [stage, setStage] = useState('input');   // 'input' | 'submitting' | 'success' | 'failed'
  const [yuanInput, setYuanInput] = useState(String(DEFAULT_YUAN));
  const [error, setError] = useState(null);
  const [newBalance, setNewBalance] = useState(null);
  const [credits, setCredits] = useState(null);

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

  // ESC 关闭
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

  const yuanNum = useMemo(() => {
    const n = Math.floor(Number(yuanInput));
    return Number.isFinite(n) ? n : 0;
  }, [yuanInput]);

  const isAmountValid = yuanNum >= MIN_YUAN && yuanNum <= MAX_YUAN;
  const previewCredits = isAmountValid ? yuanNum * CREDITS_PER_YUAN_HINT : 0;

  const handleSubmit = async () => {
    if (!isAmountValid || stage === 'submitting') return;
    setStage('submitting');
    setError(null);
    try {
      const r = await directRecharge({ amount: yuanNum * 100 });
      if (!mountedRef.current) return;
      setNewBalance(r.balanceAfter);
      setCredits(r.credits);
      setStage('success');
    } catch (err) {
      if (!mountedRef.current) return;
      console.error('[RechargeModal] 充值失败:', err?.code, err?.message, err);
      if (err instanceof CallAIError) {
        if (err.code === 'INVALID_AMOUNT') setError(err.message || '金额超出允许范围');
        else if (err.code === 'PAYMENT_DISABLED') setError('充值通道暂时关闭');
        else if (err.code === 'NOT_LOGGED_IN') setError('请先登录');
        else setError(`${err.code}: ${err.message}` || '充值失败');
      } else {
        setError(err?.message || '充值失败');
      }
      setStage('failed');
    }
  };

  const handleRestart = () => {
    setError(null);
    setNewBalance(null);
    setCredits(null);
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
      <div className="w-[300px] bg-fluent-surface-flyout rounded-fluent-lg shadow-fluent-flyout border border-fluent-stroke-card overflow-hidden">
        {/* 标题 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-fluent-stroke-divider">
          <div className="flex items-center gap-1.5">
            <Coins size={14} className="text-amber-500" />
            <span className="text-[12px] font-semibold text-fluent-text-primary">积分充值</span>
          </div>
          <button
            onClick={onClose}
            className="icon-btn"
            title="关闭 (Esc)"
          >
            <X size={12} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-4 py-3 space-y-3">
          {error && (
            <div className="flex items-start gap-1.5 text-[10px] rounded-fluent px-2 py-1.5 text-fluent-danger bg-red-50 border border-red-200">
              <AlertCircle size={11} className="flex-shrink-0 mt-[1px]" />
              <span>{error}</span>
            </div>
          )}

          {stage === 'input' && (
            <>
              <div>
                <div className="text-[10px] text-fluent-text-secondary mb-1">充值金额(¥{MIN_YUAN}~¥{MAX_YUAN})</div>
                <div className="flex items-center gap-1">
                  <span className="text-[16px] text-fluent-text-tertiary">¥</span>
                  <input
                    ref={inputRef}
                    type="number"
                    min={MIN_YUAN}
                    max={MAX_YUAN}
                    step="1"
                    value={yuanInput}
                    onChange={(e) => setYuanInput(e.target.value.replace(/[^\d]/g, ''))}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
                    className="input flex-1 py-1.5 text-[16px] font-semibold"
                    placeholder={String(DEFAULT_YUAN)}
                  />
                </div>
                <div className="mt-1 text-[10px] text-fluent-text-tertiary">
                  {isAmountValid
                    ? <>将获得 <span className="text-amber-600 font-medium">{previewCredits}</span> 积分(¥1 = {CREDITS_PER_YUAN_HINT} 积分)</>
                    : <span className="text-fluent-danger">金额需在 ¥{MIN_YUAN}~¥{MAX_YUAN} 之间</span>
                  }
                </div>
              </div>

              <button
                onClick={handleSubmit}
                disabled={!isAmountValid}
                className="btn-accent w-full py-2 text-[12px] font-medium"
              >
                确认充值
              </button>
            </>
          )}

          {stage === 'submitting' && (
            <div className="py-6 text-center space-y-2">
              <Loader2 size={28} className="mx-auto text-fluent-accent animate-spin" />
              <div className="text-[11px] text-fluent-text-secondary">充值处理中...</div>
            </div>
          )}

          {stage === 'success' && (
            <div className="py-3 text-center space-y-2">
              <CheckCircle2 size={36} className="mx-auto text-fluent-success" />
              <div className="text-[13px] font-medium text-fluent-text-primary">充值成功</div>
              {credits != null && (
                <div className="text-[11px] text-amber-600">
                  +{credits} 积分
                </div>
              )}
              {newBalance != null && (
                <div className="text-[10px] text-fluent-text-secondary">
                  当前余额:<span className="text-fluent-text-primary font-semibold">{newBalance}</span>
                </div>
              )}
            </div>
          )}

          {stage === 'failed' && (
            <>
              <div className="py-3 text-center space-y-1.5">
                <AlertCircle size={28} className="mx-auto text-fluent-danger" />
                <div className="text-[12px] font-medium text-fluent-text-primary">充值失败</div>
                {error && <div className="text-[10px] text-fluent-text-secondary">{error}</div>}
              </div>
              <button
                onClick={handleRestart}
                className="btn-accent w-full py-2 text-[12px] font-medium"
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
