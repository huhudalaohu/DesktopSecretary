/**
 * 平台抽象层入口
 *
 * 所有 process.platform 分支应下沉到本目录；main.js 只引用
 * 抽象 API，不再直接写 if (process.platform === 'win32')。
 */

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

module.exports = {
  isWin,
  isMac,
  isLinux,
  windowInfo: require('./window-info'),
  screenCapture: require('./screen-capture'),
  permissions: require('./permissions'),
  shortcuts: require('./shortcuts'),
  windowOptions: require('./window-options'),
};
