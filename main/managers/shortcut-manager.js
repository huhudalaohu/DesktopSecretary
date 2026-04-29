/**
 * ShortcutManager — 全局快捷键管理
 */

class ShortcutManager {
  constructor({ globalShortcut, getMainWindow }) {
    this.globalShortcut = globalShortcut;
    this.getMainWindow = getMainWindow;
    this.registeredShortcut = null;
    this.registeredPinShortcut = null;
  }

  register(accelerator, onTriggered) {
    if (this.registeredShortcut) {
      try { this.globalShortcut.unregister(this.registeredShortcut); } catch {}
      this.registeredShortcut = null;
    }
    if (!accelerator) return { success: true };

    try {
      const ok = this.globalShortcut.register(accelerator, () => {
        const win = this.getMainWindow();
        if (win && !win.isDestroyed()) {
          onTriggered();
        }
      });
      if (ok) {
        this.registeredShortcut = accelerator;
        console.log(`[Shortcut] 已注册: ${accelerator}`);
        return { success: true };
      }
      return { success: false, error: '快捷键注册失败，可能已被其他程序占用' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  unregister() {
    if (this.registeredShortcut) {
      try { this.globalShortcut.unregister(this.registeredShortcut); } catch {}
      console.log(`[Shortcut] 已注销: ${this.registeredShortcut}`);
      this.registeredShortcut = null;
    }
    return { success: true };
  }

  registerPin(accelerator, onTriggered) {
    if (this.registeredPinShortcut) {
      try { this.globalShortcut.unregister(this.registeredPinShortcut); } catch {}
      this.registeredPinShortcut = null;
    }
    if (!accelerator) return { success: true };

    try {
      const ok = this.globalShortcut.register(accelerator, () => {
        const win = this.getMainWindow();
        if (win && !win.isDestroyed()) {
          onTriggered();
        }
      });
      if (ok) {
        this.registeredPinShortcut = accelerator;
        console.log(`[PinShortcut] 已注册: ${accelerator}`);
        return { success: true };
      }
      return { success: false, error: '快捷键注册失败，可能已被其他程序占用' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  unregisterPin() {
    if (this.registeredPinShortcut) {
      try { this.globalShortcut.unregister(this.registeredPinShortcut); } catch {}
      console.log(`[PinShortcut] 已注销: ${this.registeredPinShortcut}`);
      this.registeredPinShortcut = null;
    }
    return { success: true };
  }

  unregisterAll() {
    this.globalShortcut.unregisterAll();
    this.registeredShortcut = null;
    this.registeredPinShortcut = null;
  }
}

module.exports = { ShortcutManager };
