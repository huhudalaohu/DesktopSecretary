import { useState, useEffect } from 'react';

// Vite 构建时自动注入版本号，与 package.json 保持同步
export const CURRENT_APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.3';

export function useAutoUpdate(api) {
  const [updateStatus, setUpdateStatus] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);

  useEffect(() => {
    const cleanup = api.onUpdateStatus((data) => {
      setUpdateStatus(data.status);
      setUpdateInfo(data);
    });
    return cleanup;
  }, [api]);

  const handleCheckUpdate = async () => {
    setUpdateStatus('checking');
    setUpdateInfo(null);
    try {
      await api.checkUpdate();
    } catch (err) {
      setUpdateStatus('error');
      setUpdateInfo({ error: err.message });
    }
  };

  const handleDownloadUpdate = async () => {
    try {
      await api.downloadUpdate();
    } catch (err) {
      setUpdateStatus('error');
      setUpdateInfo({ error: err.message });
    }
  };

  const handleInstallUpdate = async () => {
    try {
      await api.quitAndInstall();
    } catch (err) {
      setUpdateStatus('error');
      setUpdateInfo({ error: err.message });
    }
  };

  return {
    updateStatus,
    updateInfo,
    handleCheckUpdate,
    handleDownloadUpdate,
    handleInstallUpdate,
  };
}
