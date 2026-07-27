import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Cloud, RotateCw, LogOut, User, AlertCircle, CheckCircle, Mail } from 'lucide-react';
import {
  signUpWithEmail,
  signInWithPassword,
  signInWithEmailCode,
  sendEmailCode,
  signOut,
  onLoginStateChanged,
  getCurrentUser,
  getAccessToken,
} from '../../../services/cloudbase';
import { fetchBalance, CallAIError } from '../../../services/ai-proxy';

const api = window.desktopAPI;

// 邮箱输入归一化:中文输入法容易混入全角 ＠/．/。,复制粘贴可能带零宽字符,
// 不归一化会被格式校验误判为「邮箱格式不正确」
const normalizeEmail = (s) => (s || '')
  .replace(/＠/g, '@')
  .replace(/[．。｡]/g, '.')
  .replace(/[\u200B-\u200D\uFEFF]/g, '') // 零宽字符
  .trim()
  .toLowerCase();

/**
 * v2: 注册/登录通过 @cloudbase/js-sdk 直连 CloudBase 身份认证服务,
 *     主进程只负责把 uid 同步给同步引擎(api.authSetUid / api.authClearUid)。
 *
 * 支持模式:
 *   - login-password: 邮箱+密码登录
 *   - login-code:     邮箱+6位验证码登录
 *   - register:       邮箱+密码注册(SDK 内部签发 token,无需自家发码)
 */
export default function SyncPanel() {
  const [status, setStatus] = useState({ isLoggedIn: false });
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [mode, setMode] = useState('login-password'); // 'login-password' | 'login-code' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [verificationId, setVerificationId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [importLocalData, setImportLocalData] = useState(true);
  const countdownTimer = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const main = await api.syncGetStatus();
      const sdkUser = getCurrentUser();
      const loggedIn = (main && main.isLoggedIn) || !!sdkUser;

      // 防御:hasLoginState 显示已登录,但 accessToken 拿不到(SDK session 残缺,
      // 通常是上一次安装的残留)。这种情况下 fetchBalance 一定 401,会显示"请先
      // 登录"。直接当未登录处理,逼用户重新登一次走干净的代码路径。
      if (loggedIn) {
        const token = await getAccessToken();
        if (!token || !token.accessToken) {
          console.warn('[SyncPanel] hasLoginState 有 user 但 accessToken 拿不到,清理残缺 session');
          try { await signOut(); } catch {}
          try { await api.authClearUid(); } catch {}
          setStatus({ isLoggedIn: false });
          return;
        }
      }

      if (main && main.isLoggedIn) {
        setStatus({ isLoggedIn: true, username: main.username || sdkUser?.email || '' });
      } else if (sdkUser) {
        // SDK 有但主进程没绑:补一下
        setStatus({ isLoggedIn: true, username: sdkUser.email || '' });
        api.authSetUid(sdkUser.uid, { username: sdkUser.email || '', isNewUser: false }).catch(() => {});
      } else {
        setStatus({ isLoggedIn: false });
      }
    } catch (err) {
      console.error('[SyncPanel] 获取状态失败:', err);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const cleanupSync = api.onSyncStatusChange?.((data) => {
      setSyncing(data.isSyncing);
      if (data.success && (data.direction === 'push' || data.direction === 'pull')) {
        setLastSync(Date.now());
      }
    });
    const cleanupAuth = onLoginStateChanged((state) => {
      const u = state?.user || (typeof state?.uid === 'string' ? state : null);
      if (u && u.uid) {
        setStatus({ isLoggedIn: true, username: u.email || '' });
      } else {
        setStatus({ isLoggedIn: false });
      }
    });
    return () => {
      cleanupSync?.();
      cleanupAuth?.();
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, [loadStatus]);

  const showMsg = (text, type = 'error') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 3000);
  };

  const startCountdown = (seconds = 60) => {
    setCountdown(seconds);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(countdownTimer.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSendCode = async () => {
    const email = normalizeEmail(username);
    if (!email) {
      showMsg('请先输入邮箱地址');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMsg('邮箱格式不正确');
      return;
    }
    if (countdown > 0) return;

    // 注册场景要求邮箱未注册 (NOT_USER),登录验证码要求已注册 (USER)
    const target = mode === 'register' ? 'NOT_USER' : 'USER';

    setSendingCode(true);
    try {
      const r = await sendEmailCode(email, target);
      const vid = r && (r.verification_id || r.verificationId);
      if (!vid) throw new Error('SDK 未返回 verification_id');
      setVerificationId(vid);
      showMsg('验证码已发送,请查收邮件', 'success');
      startCountdown(60);
    } catch (err) {
      showMsg(err.message || '发送失败');
    } finally {
      setSendingCode(false);
    }
  };

  const handleLoginPassword = async () => {
    const email = normalizeEmail(username);
    if (!email || !password) {
      showMsg('请输入邮箱和密码');
      return;
    }
    setLoading(true);
    try {
      const { uid, user } = await signInWithPassword({ email, password });
      console.log('[Auth] UID:', uid);
      const bound = await api.authSetUid(uid, {
        username: user.email || email,
        isNewUser: false,
      });
      if (!bound.success) throw new Error(bound.error || '同步引擎绑定失败');

      // 核对/补建 MySQL 积分记录（老用户或上次初始化失败的兜底）
      try {
        await fetchBalance();
      } catch (initErr) {
        console.warn('[SyncPanel] 登录后积分核对失败:', initErr.message);
      }

      setStatus({ isLoggedIn: true, username: user.email || email });
      setUsername(''); setPassword(''); setCode('');
      window.dispatchEvent(new CustomEvent('credits-updated', { detail: {} }));
      showMsg('登录成功', 'success');
    } catch (err) {
      showMsg(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLoginCode = async () => {
    const email = normalizeEmail(username);
    if (!email || !code || code.length !== 6) {
      showMsg('请输入邮箱和 6 位验证码');
      return;
    }
    if (!verificationId) {
      showMsg('请先获取验证码');
      return;
    }
    setLoading(true);
    try {
      const { uid, user } = await signInWithEmailCode({ email, code, verification_id: verificationId });
      console.log('[Auth] UID:', uid);
      const bound = await api.authSetUid(uid, {
        username: user.email || email,
        isNewUser: false,
      });
      if (!bound.success) throw new Error(bound.error || '同步引擎绑定失败');

      // 核对/补建 MySQL 积分记录
      try {
        await fetchBalance();
      } catch (initErr) {
        console.warn('[SyncPanel] 登录后积分核对失败:', initErr.message);
      }

      setStatus({ isLoggedIn: true, username: user.email || email });
      setUsername(''); setCode(''); setVerificationId(null);
      window.dispatchEvent(new CustomEvent('credits-updated', { detail: {} }));
      showMsg('登录成功', 'success');
    } catch (err) {
      // 验证码用完即作废
      setVerificationId(null);
      setCode('');
      showMsg(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    const email = normalizeEmail(username);
    if (!email || !password) {
      showMsg('请输入邮箱和密码');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMsg('邮箱格式不正确');
      return;
    }
    if (password.length < 6) {
      showMsg('密码长度至少 6 位');
      return;
    }
    if (password !== confirmPassword) {
      showMsg('两次输入的密码不一致');
      return;
    }
    if (!code || code.length !== 6) {
      showMsg('请输入 6 位邮箱验证码');
      return;
    }
    if (!verificationId) {
      showMsg('请先点击「获取验证码」');
      return;
    }
    setLoading(true);
    try {
      const { uid, user } = await signUpWithEmail({
        email,
        password,
        verification_id: verificationId,
        code,
      });
      console.log('[Auth] UID:', uid);

      // signUp 成功未必同时建立 session(accessToken)。如果没拿到,显式用密码登一次。
      // CloudBase Auth 的 hasLoginState 与 getAccessToken 是两套状态,fetchBalance
      // 这种带 Authorization Bearer 的请求必须依赖后者,否则会被网关拒为 401。
      let token = await getAccessToken();
      if (!token || !token.accessToken) {
        await signInWithPassword({ email, password });
        token = await getAccessToken();
        if (!token || !token.accessToken) {
          throw new Error('注册成功但登录失败,请手动登录');
        }
      }

      const bound = await api.authSetUid(uid, {
        username: user.email || email,
        isNewUser: true,
        importLocalData,
      });
      if (!bound.success) throw new Error(bound.error || '同步引擎绑定失败');

      // 显式初始化 MySQL 积分记录（500 welcome），比事件广播更可靠
      try {
        await fetchBalance();
      } catch (initErr) {
        console.warn('[SyncPanel] 注册后积分初始化失败:', initErr.message);
        // 不阻断：CreditsPanel 稍后会通过事件重试
      }

      setStatus({ isLoggedIn: true, username: user.email || email });
      setUsername(''); setPassword(''); setConfirmPassword(''); setCode('');
      setVerificationId(null);
      setImportLocalData(true);
      setMode('login-password');
      // 同时广播事件供 CreditsPanel 刷新 UI
      window.dispatchEvent(new CustomEvent('credits-updated', { detail: {} }));
      showMsg(importLocalData ? '注册成功,已同步本地数据' : '注册成功,已创建空账户', 'success');
    } catch (err) {
      // 验证码用过一次就作废,无论成功失败都清掉,让用户重新发码
      setVerificationId(null);
      setCode('');
      showMsg(err.message || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    try {
      await signOut();
      await api.authClearUid();
      setStatus({ isLoggedIn: false });
      showMsg('已退出登录', 'success');
    } catch (err) {
      showMsg(err.message || '退出失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const result = await api.syncNow();
      if (result.success) {
        setLastSync(Date.now());
        showMsg(result.direction === 'none' ? '数据已是最新' : '同步成功', 'success');
      } else {
        showMsg(result.error || '同步失败');
      }
    } catch (err) {
      showMsg(err.message || '同步失败');
    } finally {
      setSyncing(false);
    }
  };

  const formatLastSync = (ts) => {
    if (!ts) return '未同步';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return new Date(ts).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const handleSubmit = () => {
    if (mode === 'register') return handleRegister();
    if (mode === 'login-code') return handleLoginCode();
    return handleLoginPassword();
  };

  // 已登录
  if (status.isLoggedIn) {
    return (
      <section className="card p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">账号与同步</h3>

        <div className="flex items-center gap-1.5">
          <User size={12} className="text-fluent-accent" />
          <span className="text-[10px] text-fluent-text-primary font-medium">{status.username}</span>
          <span className="text-[9px] text-fluent-success ml-auto flex items-center gap-0.5">
            <Cloud size={9} />
            已登录
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[9px] text-fluent-text-tertiary">上次同步: {formatLastSync(lastSync)}</span>
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            className="btn-accent px-2 py-0.5 text-[9px]"
          >
            {syncing ? <RotateCw size={9} className="animate-spin" /> : <Cloud size={9} />}
            {syncing ? '同步中...' : '立即同步'}
          </button>
        </div>

        <button
          onClick={handleLogout}
          disabled={loading}
          className="btn w-full py-1 text-[9px]"
        >
          <LogOut size={9} />
          退出登录
        </button>

        {message && (
          <div className={`text-[10px] rounded-fluent px-2 py-1.5 flex items-center gap-1 ${
            message.type === 'success'
              ? 'text-fluent-success bg-green-50 border border-green-200'
              : 'text-fluent-danger bg-red-50 border border-red-200'
          }`}>
            {message.type === 'success' ? <CheckCircle size={10} /> : <AlertCircle size={10} />}
            {message.text}
          </div>
        )}
      </section>
    );
  }

  // 未登录
  const tabs = [
    { id: 'login-password', label: '密码登录' },
    { id: 'login-code', label: '验证码登录' },
    { id: 'register', label: '注册' },
  ];

  return (
    <section className="card p-2.5 space-y-2">
      <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">账号与同步</h3>

      <div className="text-[9px] text-fluent-text-tertiary leading-relaxed">
        新用户注册即送 500 积分,登录后可使用 AI 功能。
      </div>

      <div className="flex gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => { setMode(t.id); setMessage(null); }}
            className={`flex-1 py-0.5 rounded-fluent text-[9px] transition-colors ${
              mode === t.id ? 'bg-fluent-accent-light text-fluent-accent' : 'text-fluent-text-secondary hover:bg-fluent-fill-hover'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="邮箱地址"
          className="input w-full text-[10px]"
        />

        {(mode === 'login-password' || mode === 'register') && (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? '密码 (至少6位)' : '密码'}
            className="input w-full text-[10px]"
          />
        )}

        {mode === 'register' && (
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="确认密码"
            className="input w-full text-[10px]"
          />
        )}

        {(mode === 'login-code' || mode === 'register') && (
          <div className="flex gap-1">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6位邮箱验证码"
              className="input flex-1 text-[10px]"
            />
            <button
              onClick={handleSendCode}
              disabled={sendingCode || countdown > 0}
              className="btn text-[9px] whitespace-nowrap"
            >
              <Mail size={9} />
              {countdown > 0 ? `${countdown}s` : (sendingCode ? '发送中...' : '获取验证码')}
            </button>
          </div>
        )}

        {mode === 'register' && (
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={importLocalData}
              onChange={(e) => setImportLocalData(e.target.checked)}
              className="w-3 h-3 rounded-fluent border-fluent-stroke-control text-fluent-accent focus:ring-fluent-accent"
            />
            <span className="text-[9px] text-fluent-text-secondary">将当前本地数据同步到新账户</span>
          </label>
        )}
      </div>

      <button
        onClick={handleSubmit}
        disabled={loading}
        className="btn-accent w-full py-1 text-[10px]"
      >
        {loading ? '处理中...' : (mode === 'register' ? '注册' : '登录')}
      </button>

      {message && (
        <div className={`text-[10px] rounded-fluent px-2 py-1.5 flex items-center gap-1 ${
          message.type === 'success'
            ? 'text-fluent-success bg-green-50 border border-green-200'
            : 'text-fluent-danger bg-red-50 border border-red-200'
        }`}>
          {message.type === 'success' ? <CheckCircle size={10} /> : <AlertCircle size={10} />}
          {message.text}
        </div>
      )}
    </section>
  );
}
