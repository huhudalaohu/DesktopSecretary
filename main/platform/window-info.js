/**
 * 前台窗口信息抽象
 *
 * 返回形状:
 *   { title: string, processName: string, rect: { left, top, right, bottom } } | null
 *
 * 主实现: get-windows (napi-rs, ~5ms，跨平台)
 *   - Windows: 直接调 Win32 API
 *   - macOS:   需要辅助功能权限，首次调用失败会被上层 permissions 层捕获
 *
 * 降级: Windows 上仍保留 PowerShell 作 fallback（例如 get-windows 二进制加载失败）
 */

const { execSync, exec } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// get-windows v9+ 是 ESM-only，用 dynamic import 懒加载
let getWindowsModulePromise = null;
let getWindowsModuleResolved = null;
function loadGetWindows() {
  if (!getWindowsModulePromise) {
    getWindowsModulePromise = import('get-windows')
      .then((m) => { getWindowsModuleResolved = m; return m; })
      .catch((err) => {
        console.warn('[WindowInfo] get-windows 加载失败，将使用 fallback:', err.message);
        return null;
      });
  }
  return getWindowsModulePromise;
}

/**
 * 把 get-windows 的 bounds 转成我们的 rect
 */
function normalizeGetWindowsResult(result) {
  if (!result) return null;
  const b = result.bounds || {};
  return {
    title: result.title || '',
    processName: result.owner?.name || '',
    rect: {
      left: b.x ?? 0,
      top: b.y ?? 0,
      right: (b.x ?? 0) + (b.width ?? 0),
      bottom: (b.y ?? 0) + (b.height ?? 0),
    },
  };
}

// ========== Windows PowerShell fallback ==========

const PS_SCRIPT = `
  Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    using System.Text;
    public class Win32 {
      [DllImport("user32.dll")]
      public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll", CharSet = CharSet.Auto)]
      public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
      [DllImport("user32.dll")]
      public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
      [DllImport("user32.dll")]
      public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
      [StructLayout(LayoutKind.Sequential)]
      public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    }
"@;
  $hwnd = [Win32]::GetForegroundWindow();
  $title = New-Object System.Text.StringBuilder 256;
  [Win32]::GetWindowText($hwnd, $title, 256) | Out-Null;
  $rect = New-Object Win32+RECT;
  [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null;
  $pidVal = [uint32]0;
  [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pidVal) | Out-Null;
  $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue;
  @{ title = $title.ToString(); processName = if ($proc) { $proc.ProcessName } else { "" }; rect = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom } } | ConvertTo-Json -Compress
`;

function parsePowerShell(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

function powerShellAsync() {
  return new Promise((resolve) => {
    const cmd = `powershell -NoProfile -Command "${PS_SCRIPT.replace(/"/g, '\\"')}"`;
    exec(cmd, { timeout: 3000, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(parsePowerShell(stdout));
    });
  });
}

function powerShellSync() {
  try {
    const cmd = `powershell -Command "${PS_SCRIPT.replace(/"/g, '\\"')}"`;
    const output = execSync(cmd, { timeout: 5000, encoding: 'utf8' });
    return parsePowerShell(output);
  } catch {
    return null;
  }
}

// ========== 对外接口 ==========

/**
 * 异步获取前台窗口
 * @returns {Promise<{title, processName, rect}|null>}
 */
async function getForegroundWindow() {
  const mod = await loadGetWindows();
  if (mod && typeof mod.activeWindow === 'function') {
    try {
      const win = await mod.activeWindow();
      const normalized = normalizeGetWindowsResult(win);
      if (normalized) return normalized;
    } catch (err) {
      // macOS 无辅助功能权限、Win 二进制加载失败等都走到这里
      console.log('[WindowInfo] get-windows 失败，回退:', err.message);
    }
  }

  // fallback：仅 Windows 有 PowerShell 兜底
  if (isWin) return powerShellAsync();
  return null;
}

/**
 * 同步获取前台窗口（IPC get-front-windows 保留接口）
 */
function getForegroundWindowSync() {
  // 首选 activeWindowSync（如果模块已加载）
  if (getWindowsModuleResolved && typeof getWindowsModuleResolved.activeWindowSync === 'function') {
    try {
      const win = getWindowsModuleResolved.activeWindowSync();
      const normalized = normalizeGetWindowsResult(win);
      if (normalized) return normalized;
    } catch (err) {
      console.log('[WindowInfo] get-windows sync 失败，回退:', err.message);
    }
  }
  if (isWin) return powerShellSync();
  return null;
}

// 预加载一次，启动后立即填充 moduleResolved
loadGetWindows();

module.exports = {
  getForegroundWindow,
  getForegroundWindowSync,
};
