import React, { useState } from 'react';
import SyncPanel from '../../sync/components/SyncPanel';
import CreditsPanel from '../../credits/CreditsPanel';
import ReminderLevelSettings from '../../reminders/components/ReminderLevelSettings';
import TrashPanel from '../../trash/components/TrashPanel';
import QuickLinkCategorySettings from '../../files/components/QuickLinkCategorySettings';
import { AI_MODE_OPTIONS } from '../../../config/ai-config';
import { MODULE_VISIBILITY_OPTIONS } from '../../../config/module-visibility';
import { CURRENT_APP_VERSION } from '../../../hooks/useAutoUpdate';
import {
  RotateCw, Download, CheckCircle, ArrowUpCircle, AlertCircle,
  SlidersHorizontal, Gauge, Cloud, Sparkles, Database, Info, Trash2,
} from 'lucide-react';

const SETTINGS_CATEGORIES = [
  { id: 'general', label: '常规', Icon: SlidersHorizontal },
  { id: 'efficiency', label: '效率', Icon: Gauge },
  { id: 'account', label: '账号', Icon: Cloud },
  { id: 'ai', label: 'AI', Icon: Sparkles },
  { id: 'data', label: '数据', Icon: Database },
  { id: 'trash', label: '回收站', Icon: Trash2 },
  { id: 'about', label: '关于', Icon: Info },
];

export default function SettingsPanel({
  panelRef,
  fontScale,
  setFontScale,
  fontChoice,
  fontWeight,
  setFontWeight,
  setFontChoice,
  aiSettings,
  setAiSettings,
  editingShortcut,
  setEditingShortcut,
  shortcutInput,
  setShortcutInput,
  editingPinShortcut,
  setEditingPinShortcut,
  pinShortcutInput,
  setPinShortcutInput,
  testing,
  textTesting,
  testResult,
  textTestResult,
  settingsSaveMsg,
  autoLaunch,
  setAutoLaunch,
  moduleVisibility,
  onModuleVisibilityChange,
  reminderLevels,
  setReminderLevels,
  dataStats,
  dataActionMsg,
  exporting,
  importing,
  trashedWorkspaces,
  trashedTodos,
  updateStatus,
  updateInfo,
  // handlers
  handleSaveSettings,
  handleSaveShortcut,
  handleSavePinShortcut,
  handleTestConnection,
  handleTextTest,
  handleExportData,
  handleImportData,
  restoreWorkspace,
  restoreTodo,
  permanentlyDeleteWorkspace,
  permanentlyDeleteTodo,
  clearTrash,
  handleCheckUpdate,
  handleDownloadUpdate,
  handleInstallUpdate,
  // external API
  api,
  // 充值弹窗触发(模态框在 App.jsx 根级渲染,避免被 SettingsPanel 的 overflow 裁剪)
  onOpenRecharge,
}) {
  const [activeCategory, setActiveCategory] = useState('general');
  const currentMode = aiSettings.mode || 'fast';

  return (
    <div
      ref={panelRef}
      style={{ zoom: 1 / fontScale }}
      className="card mx-4 mt-3 mb-2 h-[60vh] max-h-[560px] min-h-[260px] p-2.5 overflow-hidden flex flex-col shrink-0"
    >
      {/* 设置标题 */}
      <div className="flex items-center justify-between px-1 pb-2 shrink-0">
        <h2 className="text-sm font-semibold text-fluent-text-primary tracking-wide">设置</h2>
        <span className="text-[9px] text-fluent-text-tertiary">Desktop Secretary</span>
      </div>

      <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 flex-1 min-h-0 overflow-hidden">
        <nav aria-label="设置分类" className="min-h-0 rounded-fluent-lg bg-fluent-fill-subtle border border-fluent-stroke-card p-1 space-y-0.5 overflow-y-auto overscroll-contain">
          {SETTINGS_CATEGORIES.map(({ id, label, Icon }) => {
            const active = activeCategory === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveCategory(id)}
                className={`w-full h-8 px-1.5 rounded-fluent flex items-center gap-1.5 text-[10px] transition-colors ${
                  active
                    ? 'bg-fluent-surface-solid text-fluent-accent shadow-fluent-card'
                    : 'text-fluent-text-secondary hover:bg-fluent-fill-hover hover:text-fluent-text-primary'
                }`}
              >
                <Icon size={12} strokeWidth={active ? 2.2 : 1.8} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 min-h-0 h-full overflow-y-auto overscroll-contain pr-0.5 space-y-3">

          <div className={activeCategory === 'general' ? 'space-y-3' : 'hidden'}>
      {/* ===== 通用设置 ===== */}
      <section className="card p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">通用</h3>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-fluent-text-secondary">开机自动启动</span>
          <button
            onClick={async () => {
              const next = !autoLaunch;
              setAutoLaunch(next);
              await api.setAutoLaunch(next);
            }}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              autoLaunch ? 'bg-fluent-accent' : 'bg-fluent-text-tertiary'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                autoLaunch ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-fluent-text-secondary">界面字号</span>
          <div className="flex gap-1">
            {[
              { label: '小', value: 0.9 },
              { label: '中', value: 1.0 },
              { label: '大', value: 1.1 },
            ].map((opt) => (
              <button
                key={opt.label}
                onClick={async () => {
                  setFontScale(opt.value);
                  await api.storeSet('fontScale', opt.value);
                }}
                className={`px-2 py-0.5 rounded-fluent text-[10px] transition-colors ${
                  Math.abs(fontScale - opt.value) < 0.01
                    ? 'bg-fluent-accent-light text-fluent-accent'
                    : 'text-fluent-text-secondary hover:bg-fluent-fill-hover'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-fluent-text-secondary">界面字体</span>
          <div className="flex gap-1">
            {[
              { label: '系统默认', value: 'system' },
              { label: '文楷', value: 'wenkai' },
              { label: '方圆体', value: 'modern' },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={async () => {
                  setFontChoice(opt.value);
                  await api.storeSet('fontChoice', opt.value);
                }}
                className={`px-2 py-0.5 rounded-fluent text-[10px] transition-colors ${
                  fontChoice === opt.value
                    ? 'bg-fluent-accent-light text-fluent-accent'
                    : 'text-fluent-text-secondary hover:bg-fluent-fill-hover'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-fluent-text-secondary">字体粗细</span>
          <div className="flex gap-1">
            {[
              { label: '细体', value: '300' },
              { label: '标准', value: '400' },
              { label: '粗体', value: '500' },
              { label: '特粗', value: '600' },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={async () => {
                  setFontWeight(opt.value);
                  await api.storeSet('fontWeight', opt.value);
                }}
                className={`px-2 py-0.5 rounded-fluent text-[10px] transition-colors ${
                  fontWeight === opt.value
                    ? 'bg-fluent-accent-light text-fluent-accent'
                    : 'text-fluent-text-secondary hover:bg-fluent-fill-hover'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ===== 模块显示 ===== */}
      <section className="card p-2.5 space-y-1">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider mb-2">模块显示</h3>
        {MODULE_VISIBILITY_OPTIONS.map((module) => {
          const visible = moduleVisibility?.[module.id] !== false;
          return (
            <div key={module.id} className="flex items-center justify-between py-0.5">
              <span className="text-[10px] text-fluent-text-secondary">{module.label}</span>
              <button
                type="button"
                role="switch"
                aria-checked={visible}
                aria-label={`${module.label}${visible ? '已显示' : '已隐藏'}`}
                onClick={() => onModuleVisibilityChange(module.id, !visible)}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  visible ? 'bg-fluent-accent' : 'bg-fluent-text-tertiary'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                    visible ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </section>

          </div>

          <div className={activeCategory === 'account' ? 'space-y-3' : 'hidden'}>
            <SyncPanel />
            {activeCategory === 'account' && <CreditsPanel onOpenRecharge={onOpenRecharge} />}
          </div>

          <div className={activeCategory === 'ai' ? 'space-y-3' : 'hidden'}>
      {/* ===== AI 配置(v2:平台垫付) ===== */}
      <section className="card p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">AI 模式</h3>

        <div className="text-[10px] text-fluent-text-tertiary leading-relaxed">
          AI 调用由平台统一垫付,按上游 token 用量扣积分。无需配置 API Key。
        </div>

        <div className="flex gap-1">
          {AI_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setAiSettings({ ...aiSettings, mode: opt.value })}
              className={`flex-1 py-1 rounded-fluent text-[10px] transition-colors ${
                currentMode === opt.value
                  ? 'bg-fluent-accent-light text-fluent-accent'
                  : 'text-fluent-text-secondary hover:bg-fluent-fill-hover'
              }`}
              title={opt.desc}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="text-[9px] text-fluent-text-tertiary">
          {AI_MODE_OPTIONS.find((o) => o.value === currentMode)?.desc}
        </div>

        {/* 保存 */}
        <div className="flex gap-1 pt-1">
          <button
            onClick={handleSaveSettings}
            className="btn-accent flex-1 !py-1 !text-[10px]"
          >
            保存
          </button>
        </div>
        {settingsSaveMsg && (
          <div className={`text-[10px] rounded-fluent px-2 py-1.5 ${
            settingsSaveMsg.type === 'success'
              ? 'text-fluent-success bg-green-50 border border-green-200'
              : 'text-fluent-danger bg-red-50 border border-red-200'
          }`}>
            {settingsSaveMsg.text}
          </div>
        )}

        {/* 测试 */}
        <div className="border-t border-fluent-stroke-divider pt-2 space-y-2">
          <div className="flex gap-1">
            <button
              onClick={handleTestConnection}
              disabled={testing}
              className="flex-1 py-1 rounded-fluent bg-fluent-surface-solid hover:bg-fluent-fill-hover text-fluent-success text-[10px] transition-colors disabled:opacity-50 border border-fluent-stroke-control"
            >
              {testing ? '测试中...' : '测试连接'}
            </button>
            <button
              onClick={handleTextTest}
              disabled={textTesting}
              className="flex-1 py-1 rounded-fluent bg-fluent-surface-solid hover:bg-fluent-fill-hover text-fluent-warning text-[10px] transition-colors disabled:opacity-50 border border-fluent-stroke-control"
            >
              {textTesting ? '测试中...' : '文字 API 测试'}
            </button>
          </div>
          {testResult && (
            <div className={`text-[10px] rounded-fluent px-2 py-1.5 ${
              testResult.success
                ? 'text-fluent-success bg-green-50 border border-green-200'
                : 'text-fluent-danger bg-red-50 border border-red-200'
            }`}>
              {testResult.message}
            </div>
          )}
          {textTestResult && (
            <div className={`text-[10px] rounded-fluent px-2 py-1.5 ${
              textTestResult.success
                ? 'text-fluent-success bg-green-50 border border-green-200'
                : 'text-fluent-danger bg-red-50 border border-red-200'
            }`}>
              {textTestResult.message}
            </div>
          )}
        </div>
      </section>

          </div>

          <div className={activeCategory === 'efficiency' ? 'space-y-3' : 'hidden'}>
      {/* ===== 快捷键 ===== */}
      <section className="card p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">快捷键</h3>
        {editingShortcut ? (
          <div className="flex gap-1">
            <input
              autoFocus
              value={shortcutInput}
              onChange={(e) => setShortcutInput(e.target.value)}
              onKeyDown={(e) => {
                e.preventDefault();
                const parts = [];
                if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
                if (e.shiftKey) parts.push('Shift');
                if (e.altKey) parts.push('Alt');
                const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
                  parts.push(key);
                  setShortcutInput(parts.join('+'));
                }
              }}
              placeholder="按下快捷键组合..."
              className="flex-1 px-2 py-1 text-[10px] rounded-fluent bg-fluent-surface-solid border border-fluent-stroke-control text-fluent-text-primary placeholder:text-fluent-text-tertiary outline-none focus:border-fluent-accent"
            />
            <button onClick={handleSaveShortcut} className="btn-accent !px-2 !py-1 !text-[10px]">保存</button>
            <button
              onClick={() => { setEditingShortcut(false); setShortcutInput(aiSettings.shortcutKey || ''); }}
              className="btn !px-2 !py-1 !text-[10px]"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <code className="flex-1 px-2 py-1 text-[10px] rounded-fluent bg-fluent-fill-hover border border-fluent-stroke-control text-fluent-text-secondary">
              {aiSettings.shortcutKey || '未设置'}
            </code>
            <button
              onClick={() => setEditingShortcut(true)}
              className="btn !px-2 !py-1 !text-[10px]"
            >
              修改
            </button>
          </div>
        )}
        <div className="text-[9px] text-fluent-text-tertiary">全局快捷键，无需点击按钮即可截图</div>

        {/* 钉住状态快捷键 */}
        <div className="pt-1 border-t border-fluent-stroke-divider">
          <div className="text-[9px] text-fluent-text-tertiary mb-1">切换窗口钉住/释放</div>
          {editingPinShortcut ? (
            <div className="flex gap-1">
              <input
                autoFocus
                value={pinShortcutInput}
                onChange={(e) => setPinShortcutInput(e.target.value)}
                onKeyDown={(e) => {
                  e.preventDefault();
                  const parts = [];
                  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
                  if (e.shiftKey) parts.push('Shift');
                  if (e.altKey) parts.push('Alt');
                  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
                    parts.push(key);
                    setPinShortcutInput(parts.join('+'));
                  }
                }}
                placeholder="按下快捷键组合..."
                className="flex-1 px-2 py-1 text-[10px] rounded-fluent bg-fluent-surface-solid border border-fluent-stroke-control text-fluent-text-primary placeholder:text-fluent-text-tertiary outline-none focus:border-fluent-accent"
              />
              <button onClick={handleSavePinShortcut} className="btn-accent !px-2 !py-1 !text-[10px]">保存</button>
              <button
                onClick={() => { setEditingPinShortcut(false); setPinShortcutInput(pinShortcutInput || ''); }}
                className="btn !px-2 !py-1 !text-[10px]"
              >
                取消
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <code className="flex-1 px-2 py-1 text-[10px] rounded-fluent bg-fluent-fill-hover border border-fluent-stroke-control text-fluent-text-secondary">
                {pinShortcutInput || '未设置'}
              </code>
              <button
                onClick={() => setEditingPinShortcut(true)}
                className="btn !px-2 !py-1 !text-[10px]"
              >
                修改
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ===== 时间提醒层级 ===== */}
      <section className="card p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">时间提醒层级</h3>
        <ReminderLevelSettings
          levels={reminderLevels}
          onChange={async (next) => {
            setReminderLevels(next);
            await api.storeSet('reminderLevels', next);
          }}
        />
      </section>

      <QuickLinkCategorySettings />

          </div>

          <div className={activeCategory === 'data' ? 'space-y-3' : 'hidden'}>
      {/* ===== 数据管理 ===== */}
      <section className="card p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">数据管理</h3>

        {dataStats && (
          <div className="space-y-1">
            <div className="text-[10px] text-fluent-text-secondary">
              存储占用: <span className="font-medium text-fluent-text-primary">{dataStats.fileSizeFormatted}</span>
            </div>
            <div className="text-[9px] text-fluent-text-tertiary">
              {dataStats.counts.workspaces} 个工作区 · {dataStats.counts.todos} 条待办 · {dataStats.counts.links} 个链接
            </div>
          </div>
        )}

        <div className="flex gap-1">
          <button
            onClick={handleExportData}
            disabled={exporting}
            className="btn flex-1 !py-1 !text-[10px]"
          >
            {exporting ? '导出中...' : '导出数据'}
          </button>
          <button
            onClick={handleImportData}
            disabled={importing}
            className="btn flex-1 !py-1 !text-[10px]"
          >
            {importing ? '导入中...' : '导入恢复'}
          </button>
        </div>

        {dataActionMsg && (
          <div className={`text-[10px] rounded-fluent px-2 py-1.5 ${
            dataActionMsg.type === 'success'
              ? 'text-fluent-success bg-green-50 border border-green-200'
              : 'text-fluent-danger bg-red-50 border border-red-200'
          }`}>
            {dataActionMsg.text}
          </div>
        )}

        <div className="text-[9px] text-fluent-text-tertiary leading-relaxed">
          Excel 用于查看历史，JSON 用于换电脑时完整恢复。
        </div>
      </section>

          </div>

          <div className={activeCategory === 'trash' ? 'space-y-3' : 'hidden'}>
            <TrashPanel
              trashedWorkspaces={trashedWorkspaces}
              trashedTodos={trashedTodos}
              restoreWorkspace={restoreWorkspace}
              restoreTodo={restoreTodo}
              permanentlyDeleteWorkspace={permanentlyDeleteWorkspace}
              permanentlyDeleteTodo={permanentlyDeleteTodo}
              clearTrash={clearTrash}
            />
          </div>

          <div className={activeCategory === 'about' ? 'space-y-3' : 'hidden'}>
      {/* ===== 关于 / 更新检查 ===== */}
      <section className="card p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">关于</h3>

        <div className="flex items-center justify-between">
          <div className="text-[10px] text-fluent-text-secondary">
            当前版本: <span className="font-medium text-fluent-text-primary">{CURRENT_APP_VERSION}</span>
          </div>
          <button
            onClick={handleCheckUpdate}
            disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
            className="btn !px-2 !py-1 !text-[10px]"
          >
            {updateStatus === 'checking' ? (
              <>
                <RotateCw size={10} className="animate-spin" />
                检查中...
              </>
            ) : (
              <>
                <ArrowUpCircle size={10} />
                检查更新
              </>
            )}
          </button>
        </div>

        {updateStatus === 'latest' && (
          <div className="text-[10px] rounded-fluent px-2 py-1.5 text-fluent-success bg-green-50 border border-green-200 flex items-center gap-1">
            <CheckCircle size={10} />
            已是最新版本
          </div>
        )}

        {updateStatus === 'available' && updateInfo && (
          <div className="space-y-1.5">
            <div className="text-[10px] rounded-fluent px-2 py-1.5 text-fluent-warning bg-amber-50 border border-amber-200 flex items-center gap-1">
              <ArrowUpCircle size={10} />
              发现新版本 {updateInfo.latestVersion}
            </div>
            {updateInfo.releaseNotes && (
              <div className="text-[9px] text-fluent-text-tertiary leading-relaxed">{updateInfo.releaseNotes}</div>
            )}
            <button
              onClick={handleDownloadUpdate}
              className="btn-accent w-full !py-1 !text-[10px]"
            >
              <Download size={10} />
              下载更新
            </button>
          </div>
        )}

        {updateStatus === 'downloading' && (
          <div className="space-y-1.5">
            <div className="text-[10px] rounded-fluent px-2 py-1.5 text-fluent-accent bg-fluent-accent-light border border-fluent-accent-border flex items-center gap-1">
              <RotateCw size={10} className="animate-spin" />
              正在下载更新{updateInfo?.progress !== undefined ? ` (${updateInfo.progress}%)` : ''}
            </div>
            {updateInfo?.progress !== undefined && (
              <div className="h-1.5 w-full bg-fluent-fill-hover rounded-full overflow-hidden">
                <div
                  className="h-full bg-fluent-accent rounded-full transition-all duration-300"
                  style={{ width: `${updateInfo.progress}%` }}
                />
              </div>
            )}
          </div>
        )}

        {updateStatus === 'downloaded' && (
          <div className="space-y-1.5">
            <div className="text-[10px] rounded-fluent px-2 py-1.5 text-fluent-success bg-green-50 border border-green-200 flex items-center gap-1">
              <CheckCircle size={10} />
              下载完成，重启后安装
            </div>
            <button
              onClick={handleInstallUpdate}
              className="btn-accent w-full !py-1 !text-[10px]"
            >
              重启并安装
            </button>
          </div>
        )}

        {updateStatus === 'error' && (
          <div className="text-[10px] rounded-fluent px-2 py-1.5 text-fluent-danger bg-red-50 border border-red-200 flex items-center gap-1">
            <AlertCircle size={10} />
            检查更新失败{updateInfo?.error ? `：${updateInfo.error}` : ''}
          </div>
        )}
      </section>
          </div>
        </div>
      </div>
    </div>
  );
}
