import React from 'react';
import SyncPanel from '../../sync/components/SyncPanel';
import CreditsPanel from '../../credits/CreditsPanel';
import ReminderLevelSettings from '../../reminders/components/ReminderLevelSettings';
import { AI_MODE_OPTIONS } from '../../../config/ai-config';
import { CURRENT_APP_VERSION } from '../../../hooks/useAutoUpdate';
import {
  RotateCw, Download, CheckCircle, ArrowUpCircle, AlertCircle,
} from 'lucide-react';

export default function SettingsPanel({
  panelRef,
  fontScale,
  setFontScale,
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
  reminderLevels,
  setReminderLevels,
  dataStats,
  dataActionMsg,
  exporting,
  importing,
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
  handleCheckUpdate,
  handleDownloadUpdate,
  handleInstallUpdate,
  // external API
  api,
  // 充值弹窗触发(模态框在 App.jsx 根级渲染,避免被 SettingsPanel 的 overflow 裁剪)
  onOpenRecharge,
}) {
  const currentMode = aiSettings.mode || 'fast';

  return (
    <div
      ref={panelRef}
      style={{ zoom: 1 / fontScale }}
      className="mx-4 mb-2 rounded-lg bg-[#F0F0F0] border border-[#D4D4D4] p-3 space-y-3 shadow-md max-h-[50vh] overflow-y-auto"
    >
      {/* 设置标题 */}
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-gray-700 tracking-wide">设置</h2>
        <span className="text-[9px] text-gray-400">Desktop Secretary</span>
      </div>

      {/* ===== 通用设置 ===== */}
      <section className="bg-white rounded-md p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">通用</h3>
        <div className="text-[10px] text-gray-400 leading-relaxed">
          拖动顶部标题栏可移动窗口。靠近屏幕边缘自动吸附并收起；浮空时可调整尺寸。
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-500">开机自动启动</span>
          <button
            onClick={async () => {
              const next = !autoLaunch;
              setAutoLaunch(next);
              await api.setAutoLaunch(next);
            }}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              autoLaunch ? 'bg-[#0099FF]' : 'bg-gray-300'
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
          <span className="text-[10px] text-gray-500">界面字号</span>
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
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                  Math.abs(fontScale - opt.value) < 0.01
                    ? 'bg-[#0099FF] text-white'
                    : 'bg-[#F5F5F5] text-gray-600 hover:bg-[#EBEBEB]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <SyncPanel />

      <CreditsPanel onOpenRecharge={onOpenRecharge} />

      {/* ===== AI 配置(v2:平台垫付) ===== */}
      <section className="bg-white rounded-md p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">AI 模式</h3>

        <div className="text-[10px] text-gray-400 leading-relaxed">
          AI 调用由平台统一垫付,按上游 token 用量扣积分。无需配置 API Key。
        </div>

        <div className="flex gap-1">
          {AI_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setAiSettings({ ...aiSettings, mode: opt.value })}
              className={`flex-1 py-1 rounded text-[10px] transition-colors ${
                currentMode === opt.value
                  ? 'bg-[#0099FF] text-white'
                  : 'bg-[#F5F5F5] text-gray-500 hover:bg-[#EBEBEB]'
              }`}
              title={opt.desc}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="text-[9px] text-gray-400">
          {AI_MODE_OPTIONS.find((o) => o.value === currentMode)?.desc}
        </div>

        {/* 保存 */}
        <div className="flex gap-1 pt-1">
          <button
            onClick={handleSaveSettings}
            className="flex-1 py-1 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[10px] transition-colors"
          >
            保存
          </button>
        </div>
        {settingsSaveMsg && (
          <div className={`text-[10px] rounded-md px-2 py-1.5 ${
            settingsSaveMsg.type === 'success'
              ? 'text-green-600 bg-green-50 border border-green-200'
              : 'text-red-600 bg-red-50 border border-red-200'
          }`}>
            {settingsSaveMsg.text}
          </div>
        )}

        {/* 测试 */}
        <div className="border-t border-[#F0F0F0] pt-2 space-y-2">
          <div className="flex gap-1">
            <button
              onClick={handleTestConnection}
              disabled={testing}
              className="flex-1 py-1 rounded bg-green-50 hover:bg-green-100 text-green-600 text-[10px] transition-colors disabled:opacity-50 border border-green-200"
            >
              {testing ? '测试中...' : '测试连接'}
            </button>
            <button
              onClick={handleTextTest}
              disabled={textTesting}
              className="flex-1 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-600 text-[10px] transition-colors disabled:opacity-50 border border-amber-200"
            >
              {textTesting ? '测试中...' : '文字 API 测试'}
            </button>
          </div>
          {testResult && (
            <div className={`text-[10px] rounded-md px-2 py-1.5 ${
              testResult.success
                ? 'text-green-600 bg-green-50 border border-green-200'
                : 'text-red-600 bg-red-50 border border-red-200'
            }`}>
              {testResult.message}
            </div>
          )}
          {textTestResult && (
            <div className={`text-[10px] rounded-md px-2 py-1.5 ${
              textTestResult.success
                ? 'text-green-600 bg-green-50 border border-green-200'
                : 'text-red-600 bg-red-50 border border-red-200'
            }`}>
              {textTestResult.message}
            </div>
          )}
        </div>
      </section>

      {/* ===== 快捷键 ===== */}
      <section className="bg-white rounded-md p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">快捷键</h3>
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
              className="flex-1 px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF]"
            />
            <button onClick={handleSaveShortcut} className="px-2 py-1 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[10px]">保存</button>
            <button
              onClick={() => { setEditingShortcut(false); setShortcutInput(aiSettings.shortcutKey || ''); }}
              className="px-2 py-1 rounded bg-[#F5F5F5] text-gray-500 text-[10px]"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <code className="flex-1 px-2 py-1 text-[10px] rounded bg-[#F5F5F5] border border-[#E5E5E5] text-gray-600">
              {aiSettings.shortcutKey || '未设置'}
            </code>
            <button
              onClick={() => setEditingShortcut(true)}
              className="px-2 py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-500 text-[10px]"
            >
              修改
            </button>
          </div>
        )}
        <div className="text-[9px] text-gray-400">全局快捷键，无需点击按钮即可截图</div>

        {/* 钉住状态快捷键 */}
        <div className="pt-1 border-t border-[#E5E5E5]">
          <div className="text-[9px] text-gray-400 mb-1">切换窗口钉住/释放</div>
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
                className="flex-1 px-2 py-1 text-[10px] rounded bg-white border border-[#E5E5E5] text-gray-800 placeholder-gray-300 outline-none focus:border-[#0099FF]"
              />
              <button onClick={handleSavePinShortcut} className="px-2 py-1 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[10px]">保存</button>
              <button
                onClick={() => { setEditingPinShortcut(false); setPinShortcutInput(pinShortcutInput || ''); }}
                className="px-2 py-1 rounded bg-[#F5F5F5] text-gray-500 text-[10px]"
              >
                取消
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <code className="flex-1 px-2 py-1 text-[10px] rounded bg-[#F5F5F5] border border-[#E5E5E5] text-gray-600">
                {pinShortcutInput || '未设置'}
              </code>
              <button
                onClick={() => setEditingPinShortcut(true)}
                className="px-2 py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-500 text-[10px]"
              >
                修改
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ===== 时间提醒层级 ===== */}
      <section className="bg-white rounded-md p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">时间提醒层级</h3>
        <ReminderLevelSettings
          levels={reminderLevels}
          onChange={async (next) => {
            setReminderLevels(next);
            await api.storeSet('reminderLevels', next);
          }}
        />
      </section>

      {/* ===== 数据管理 ===== */}
      <section className="bg-white rounded-md p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">数据管理</h3>

        {dataStats && (
          <div className="space-y-1">
            <div className="text-[10px] text-gray-500">
              存储占用: <span className="font-medium text-gray-700">{dataStats.fileSizeFormatted}</span>
            </div>
            <div className="text-[9px] text-gray-400">
              {dataStats.counts.workspaces} 个工作区 · {dataStats.counts.todos} 条待办 · {dataStats.counts.links} 个链接
            </div>
          </div>
        )}

        <div className="flex gap-1">
          <button
            onClick={handleExportData}
            disabled={exporting}
            className="flex-1 py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-600 text-[10px] transition-colors disabled:opacity-50 border border-[#E5E5E5]"
          >
            {exporting ? '导出中...' : '导出数据'}
          </button>
          <button
            onClick={handleImportData}
            disabled={importing}
            className="flex-1 py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-600 text-[10px] transition-colors disabled:opacity-50 border border-[#E5E5E5]"
          >
            {importing ? '导入中...' : '导入恢复'}
          </button>
        </div>

        {dataActionMsg && (
          <div className={`text-[10px] rounded-md px-2 py-1.5 ${
            dataActionMsg.type === 'success'
              ? 'text-green-600 bg-green-50 border border-green-200'
              : 'text-red-600 bg-red-50 border border-red-200'
          }`}>
            {dataActionMsg.text}
          </div>
        )}

        <div className="text-[9px] text-gray-400 leading-relaxed">
          Excel 用于查看历史，JSON 用于换电脑时完整恢复。
        </div>
      </section>

      {/* ===== 关于 / 更新检查 ===== */}
      <section className="bg-white rounded-md p-2.5 space-y-2">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">关于</h3>

        <div className="flex items-center justify-between">
          <div className="text-[10px] text-gray-500">
            当前版本: <span className="font-medium text-gray-700">{CURRENT_APP_VERSION}</span>
          </div>
          <button
            onClick={handleCheckUpdate}
            disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
            className="px-2 py-1 rounded bg-[#F5F5F5] hover:bg-[#EBEBEB] text-gray-600 text-[10px] transition-colors disabled:opacity-50 border border-[#E5E5E5] flex items-center gap-1"
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
          <div className="text-[10px] rounded-md px-2 py-1.5 text-green-600 bg-green-50 border border-green-200 flex items-center gap-1">
            <CheckCircle size={10} />
            已是最新版本
          </div>
        )}

        {updateStatus === 'available' && updateInfo && (
          <div className="space-y-1.5">
            <div className="text-[10px] rounded-md px-2 py-1.5 text-amber-600 bg-amber-50 border border-amber-200 flex items-center gap-1">
              <ArrowUpCircle size={10} />
              发现新版本 {updateInfo.latestVersion}
            </div>
            {updateInfo.releaseNotes && (
              <div className="text-[9px] text-gray-400 leading-relaxed">{updateInfo.releaseNotes}</div>
            )}
            <button
              onClick={handleDownloadUpdate}
              className="w-full py-1 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[10px] transition-colors flex items-center justify-center gap-1"
            >
              <Download size={10} />
              下载更新
            </button>
          </div>
        )}

        {updateStatus === 'downloading' && (
          <div className="space-y-1.5">
            <div className="text-[10px] rounded-md px-2 py-1.5 text-blue-600 bg-blue-50 border border-blue-200 flex items-center gap-1">
              <RotateCw size={10} className="animate-spin" />
              正在下载更新{updateInfo?.progress !== undefined ? ` (${updateInfo.progress}%)` : ''}
            </div>
            {updateInfo?.progress !== undefined && (
              <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#0099FF] rounded-full transition-all duration-300"
                  style={{ width: `${updateInfo.progress}%` }}
                />
              </div>
            )}
          </div>
        )}

        {updateStatus === 'downloaded' && (
          <div className="space-y-1.5">
            <div className="text-[10px] rounded-md px-2 py-1.5 text-green-600 bg-green-50 border border-green-200 flex items-center gap-1">
              <CheckCircle size={10} />
              下载完成，重启后安装
            </div>
            <button
              onClick={handleInstallUpdate}
              className="w-full py-1 rounded bg-[#0099FF] hover:bg-[#007ACC] text-white text-[10px] transition-colors"
            >
              重启并安装
            </button>
          </div>
        )}

        {updateStatus === 'error' && (
          <div className="text-[10px] rounded-md px-2 py-1.5 text-red-600 bg-red-50 border border-red-200 flex items-center gap-1">
            <AlertCircle size={10} />
            检查更新失败{updateInfo?.error ? `：${updateInfo.error}` : ''}
          </div>
        )}
      </section>
    </div>
  );
}
