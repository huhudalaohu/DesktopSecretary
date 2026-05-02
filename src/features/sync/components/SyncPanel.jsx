import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Cloud, CloudOff, RotateCw, LogOut, User, AlertCircle, CheckCircle, Mail } from 'lucide-react';

const api = window.desktopAPI;

// 腾讯云 CloudBase 云函数 URL（部署后填入）
// 示例: 'https://ds-dev-d9g28xlrgd2600837-xxx.ap-guangzhou.app.tcloudbase.com/sendVerifyCode'
const VERIFY_API_URL =
  typeof __VERIFY_API_URL__ !== 'undefined' ? __VERIFY_API_URL__ : '';

export default function SyncPanel() {
  const [status, setStatus] = useState({ isLoggedIn: false });
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [importLocalData, setImportLocalData] = useState(true);
  const countdownTimer = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.syncGetStatus();
      setStatus(s);
    } catch (err) {
      console.error('[SyncPanel] 获取状态失败:', err);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const cleanup = api.onSyncStatusChange?.((data) => {
      setSyncing(data.isSyncing);
      if (data.success && (data.direction === 'push' || data.direction === 'pull')) {
        setLastSync(Date.now());
      }
    });
    return () => {
      cleanup?.();
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
    const email = username.trim().toLowerCase();
    if (!email) {
      showMsg('请先输入邮箱地址');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMsg('邮箱格式不正确');
      return;
    }
    if (countdown > 0) return;

    setSendingCode(true);
    try {
      let result;
      if (VERIFY_API_URL) {
        // 云函数模式（推荐）：24h 在线，不依赖本地电脑
        const resp = await fetch(VERIFY_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        result = await resp.json();
      } else {
        // 本地回退模式：依赖 Electron 主进程运行
        result = await api.syncSendCode(email);
      }
      if (result.success) {
        showMsg(result.message || '验证码已发送', 'success');
        startCountdown(60);
      } else {
        showMsg(result.error || '发送失败');
      }
    } catch (err) {
      showMsg(err.message || '发送失败');
    } finally {
      setSendingCode(false);
    }
  };

  const handleLogin = async () => {
    if (!username.trim() || !password) {
      showMsg('请输入邮箱和密码');
      return;
    }
    setLoading(true);
    try {
      const result = await api.syncLogin(username.trim(), password);
      if (result.success) {
        setStatus({ isLoggedIn: true, username: result.username });
        setUsername('');
        setPassword('');
        setCode('');
        setMode('login');
        showMsg('登录成功', 'success');
      } else {
        showMsg(result.error || '登录失败');
      }
    } catch (err) {
      showMsg(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!username.trim() || !password) {
      showMsg('请输入邮箱和密码');
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
      showMsg('请输入 6 位验证码');
      return;
    }
    setLoading(true);
    try {
      const result = await api.syncRegister(username.trim(), password, code, importLocalData);
      if (result.success) {
        setStatus({ isLoggedIn: true, username: result.username });
        setUsername('');
        setPassword('');
        setConfirmPassword('');
        setCode('');
        setImportLocalData(true);
        setMode('login');
        showMsg(importLocalData ? '注册成功，已同步本地数据' : '注册成功，已创建空账户', 'success');
      } else {
        showMsg(result.error || '注册失败');
      }
    } catch (err) {
      showMsg(err.message || '注册失败');
    } finally {
      setLoading(false);
    }
  };



  const handleLogout = async () => {
    setLoading(true);
    try {
      await api.syncLogout();
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

  // 已登录状态
  if (status.isLoggedIn) {
    return (
      <section className="bg-white rounded-md p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">账号与同步</h3>

        <div className="flex items-center gap-1.5">
          <User size={12} className="text-[#0099FF]" />
          <span className="text-[10px] text-gray-700 font-medium">{status.username}</span>
          <span className="text-[9px] text-green-500 ml-auto flex items-center gap-0.5">
            <Cloud size={9} />
            已登录
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[9px] text-gray-400">上次同步: {formatLastSync(lastSync)}</span>
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            className="px-2 py-0.5 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[9px] transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            {syncing ? <RotateCw size={9} className="animate-spin" /> : <Cloud size={9} />}
            {syncing ? '同步中...' : '立即同步'}
          </button>
        </div>

        <button
          onClick={handleLogout}
          disabled={loading}
          className="w-full py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-500 text-[9px] transition-colors disabled:opacity-50 flex items-center justify-center gap-1 border border-[#E5E5E5]"
        >
          <LogOut size={9} />
          退出登录
        </button>

        {message && (
          <div className={`text-[10px] rounded-md px-2 py-1.5 flex items-center gap-1 ${
            message.type === 'success'
              ? 'text-green-600 bg-green-50 border border-green-200'
              : 'text-red-600 bg-red-50 border border-red-200'
          }`}>
            {message.type === 'success' ? <CheckCircle size={10} /> : <AlertCircle size={10} />}
            {message.text}
          </div>
        )}
      </section>
    );
  }

  // 未登录状态
  return (
    <section className="bg-white rounded-md p-2.5 space-y-2">
      <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">账号与同步</h3>

      <div className="text-[9px] text-gray-400 leading-relaxed">
        使用邮箱注册登录，同步数据到云端实现多端一致。
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => { setMode('login'); setMessage(null); }}
          className={`flex-1 py-0.5 rounded text-[9px] transition-colors ${
            mode === 'login' ? 'bg-[#0099FF] text-white' : 'bg-[#F5F5F5] text-gray-500 hover:bg-[#EBEBEB]'
          }`}
        >
          登录
        </button>
        <button
          onClick={() => { setMode('register'); setMessage(null); }}
          className={`flex-1 py-0.5 rounded text-[9px] transition-colors ${
            mode === 'register' ? 'bg-[#0099FF] text-white' : 'bg-[#F5F5F5] text-gray-500 hover:bg-[#EBEBEB]'
          }`}
        >
          注册
        </button>
      </div>

      <div className="space-y-1.5">
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="邮箱地址"
          className="w-full px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF]"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码 (至少6位)"
          className="w-full px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF]"
        />
        {mode === 'register' && (
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="确认密码"
            className="w-full px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF]"
          />
        )}
        {mode === 'register' && (
          <div className="flex gap-1">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6位验证码"
              className="flex-1 px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF]"
            />
            <button
              onClick={handleSendCode}
              disabled={sendingCode || countdown > 0}
              className="px-2 py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-500 text-[9px] transition-colors disabled:opacity-50 border border-[#E5E5E5] flex items-center gap-1 whitespace-nowrap"
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
              className="w-3 h-3 rounded border-gray-300 text-[#0099FF] focus:ring-[#0099FF]"
            />
            <span className="text-[9px] text-gray-500">将当前本地数据同步到新账户</span>
          </label>
        )}
      </div>

      <button
        onClick={mode === 'login' ? handleLogin : handleRegister}
        disabled={loading}
        className="w-full py-1 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[10px] transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
      >
        {loading ? '处理中...' : (mode === 'login' ? '登录' : '注册')}
      </button>



      {message && (
        <div className={`text-[10px] rounded-md px-2 py-1.5 flex items-center gap-1 ${
          message.type === 'success'
            ? 'text-green-600 bg-green-50 border border-green-200'
            : 'text-red-600 bg-red-50 border border-red-200'
        }`}>
          {message.type === 'success' ? <CheckCircle size={10} /> : <AlertCircle size={10} />}
          {message.text}
        </div>
      )}
    </section>
  );
}
