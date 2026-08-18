import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Coins, RotateCw, Plus, AlertCircle } from 'lucide-react';
import { fetchBalance, CallAIError } from '../../services/ai-proxy';
import { getCurrentUser, onLoginStateChanged } from '../../services/cloudbase';

/**
 * 积分中心面板
 *
 * 已登录: 显示余额 + 总充值 / 总消耗 + 最近 20 条流水 + 充值按钮(M.B 占位)
 * 未登录: 提示先在「账号与同步」面板登录
 */

function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function describeTransaction(t) {
  switch (t.type) {
    case 'consume': {
      const meta = t.meta || {};
      const tokens = meta.totalTokens != null ? `${meta.totalTokens} tokens` : '';
      const mode = meta.mode === 'precise' ? '精准' : (meta.mode === 'fast' ? '快速' : '');
      return [`AI 调用${mode ? ` · ${mode}` : ''}`, tokens].filter(Boolean).join(' · ');
    }
    case 'recharge_paid':   return `充值 (¥${(t.meta?.payAmount || 0) / 100})`;
    case 'recharge_gift': {
      const reason = t.meta?.reason;
      if (reason === 'welcome') return '注册赠送';
      if (typeof reason === 'string' && reason.startsWith('promo:')) return `活动赠送 ${reason.slice(6)}`;
      return '系统赠送';
    }
    case 'admin_adjust':    return `管理员调整 (${t.meta?.reason || ''})`;
    default:                return t.type;
  }
}

const INITIAL_LOAD_RETRY_DELAYS = [1500, 3000];

function getBalanceErrorMessage(err) {
  if (err instanceof CallAIError && err.code === 'NOT_LOGGED_IN') {
    return '请先登录';
  }
  return err?.message || '获取失败';
}

export default function CreditsPanel({ onOpenRecharge }) {
  const [user, setUser] = useState(() => getCurrentUser());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [balance, setBalance] = useState(null);
  const [totalRecharged, setTotalRecharged] = useState(0);
  const [totalConsumed, setTotalConsumed] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const retryTimerRef = useRef(null);
  const requestIdRef = useRef(0);

  const clearPendingRetry = useCallback(() => {
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const applyBalance = useCallback((result) => {
    setBalance(result.balance);
    setTotalRecharged(result.totalRecharged);
    setTotalConsumed(result.totalConsumed);
    setTransactions(result.recentTransactions || []);
  }, []);

  const refresh = useCallback(async () => {
    if (!getCurrentUser()) return;
    const requestId = ++requestIdRef.current;
    clearPendingRetry();
    setLoading(true);
    setError(null);
    try {
      const r = await fetchBalance();
      if (requestId === requestIdRef.current) applyBalance(r);
    } catch (err) {
      if (requestId === requestIdRef.current) setError(getBalanceErrorMessage(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [applyBalance, clearPendingRetry]);

  const refreshAfterInitialization = useCallback(() => {
    if (!getCurrentUser()) return;
    const requestId = ++requestIdRef.current;
    clearPendingRetry();
    setLoading(true);
    setError(null);

    const attempt = async (attemptIndex) => {
      try {
        const r = await fetchBalance();
        if (requestId !== requestIdRef.current) return;
        applyBalance(r);
        setLoading(false);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        const retryDelay = INITIAL_LOAD_RETRY_DELAYS[attemptIndex];
        if (retryDelay) {
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            attempt(attemptIndex + 1);
          }, retryDelay);
          return;
        }
        setLoading(false);
        setError('暂时未获取到积分余额，请稍后点击刷新');
      }
    };

    attempt(0);
  }, [applyBalance, clearPendingRetry]);

  // 登录态变化时刷新
  useEffect(() => {
    const cleanup = onLoginStateChanged((state) => {
      const u = state?.user || (typeof state?.uid === 'string' ? state : null);
      setUser(u);
      if (u && u.uid) refreshAfterInitialization();
      else {
        ++requestIdRef.current;
        clearPendingRetry();
        setLoading(false);
        setError(null);
        setBalance(null);
        setTransactions([]);
      }
    });
    if (getCurrentUser()) refreshAfterInitialization();
    return () => {
      ++requestIdRef.current;
      clearPendingRetry();
      cleanup?.();
    };
  }, [clearPendingRetry, refreshAfterInitialization]);

  // 监听 ai-proxy 广播的余额变化,本地直接更新无需 re-fetch
  // 同时支持 detail 为空的"强制刷新"信号(用于注册/登录成功后兜底)
  useEffect(() => {
    const onCreditsUpdated = (e) => {
      const next = e?.detail?.balance;
      if (typeof next === 'number') {
        setBalance(next);
        const used = e?.detail?.used;
        if (typeof used === 'number') setTotalConsumed((v) => v + used);
      } else {
        // 没带 balance:重新拉一次(注册刚成功 + 错误态时尤其有用)
        refreshAfterInitialization();
      }
    };
    window.addEventListener('credits-updated', onCreditsUpdated);
    return () => window.removeEventListener('credits-updated', onCreditsUpdated);
  }, [refreshAfterInitialization]);

  // 未登录态: 提示去登录(SyncPanel 在上方,用户能直接看到)
  if (!user || !user.uid) {
    return (
      <section className="card p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">积分中心</h3>
        <div className="text-[10px] text-fluent-text-tertiary leading-relaxed">
          登录账号后查看积分余额。新用户注册即送 500 积分。
        </div>
      </section>
    );
  }

  return (
    <section className="card p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">积分中心</h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="icon-btn p-0.5"
          title="刷新"
        >
          <RotateCw size={10} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 余额卡片 */}
      <div className="flex items-end justify-between">
        <div className="flex items-baseline gap-1">
          <Coins size={14} className="text-amber-500" />
          <span className="text-[20px] font-semibold text-fluent-text-primary leading-none">
            {balance == null ? '—' : balance}
          </span>
          <span className="text-[10px] text-fluent-text-tertiary ml-1">积分</span>
        </div>
        <button
          onClick={onOpenRecharge}
          disabled={!onOpenRecharge}
          className="btn-accent px-2 py-0.5 text-[9px]"
        >
          <Plus size={9} />
          充值
        </button>
      </div>

      {/* 累计统计 */}
      <div className="flex items-center justify-between text-[9px] text-fluent-text-tertiary">
        <span>累计充值: {totalRecharged}</span>
        <span>累计消耗: {totalConsumed}</span>
      </div>

      {error && (
        <div className="text-[10px] rounded-fluent px-2 py-1.5 text-fluent-danger bg-red-50 border border-red-200 flex items-center gap-1">
          <AlertCircle size={10} />
          {error}
        </div>
      )}

      {/* 最近流水 */}
      <div className="border-t border-fluent-stroke-divider pt-1.5">
        <div className="text-[9px] text-fluent-text-tertiary mb-1">最近记录</div>
        {transactions.length === 0 ? (
          <div className="text-[9px] text-fluent-text-tertiary py-2 text-center">暂无流水</div>
        ) : (
          <ul className="space-y-0.5 max-h-[120px] overflow-y-auto">
            {transactions.map((t, i) => {
              const positive = t.amount > 0;
              return (
                <li
                  key={t._id || `${t.createdAt}-${i}`}
                  className="flex items-center justify-between gap-1 px-1 py-0.5 rounded-fluent hover:bg-fluent-fill-hover"
                >
                  <span className="text-[10px] text-fluent-text-secondary truncate flex-1">{describeTransaction(t)}</span>
                  <span className={`text-[10px] font-medium flex-shrink-0 ${
                    positive ? 'text-fluent-success' : 'text-fluent-text-primary'
                  }`}>
                    {positive ? '+' : ''}{t.amount}
                  </span>
                  <span className="text-[9px] text-fluent-text-tertiary flex-shrink-0 w-16 text-right">
                    {formatTime(t.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
