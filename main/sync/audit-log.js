const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 512 * 1024;

function getLogPath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('logs'), 'sync.log');
  } catch {
    return path.join(process.cwd(), 'logs', 'sync.log');
  }
}

class SyncAuditLog {
  constructor() {
    this.logPath = getLogPath();
  }

  write(entry) {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      if (fs.existsSync(this.logPath) && fs.statSync(this.logPath).size >= MAX_LOG_BYTES) {
        fs.renameSync(this.logPath, `${this.logPath}.1`);
      }
      fs.appendFile(this.logPath, line, () => {});
    } catch {
      // 日志故障不能影响离线优先的本地数据操作。
    }
  }
}

module.exports = { SyncAuditLog };
