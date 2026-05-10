# DesktopSecretary — Claude 工作指引

## 修改更新相关模块前必读

如果你即将修改以下任意文件,**先完整读一遍 [docs/UPDATE_MECHANISM.md](docs/UPDATE_MECHANISM.md)**:

- `package.json` 的 `build.publish` / `build.win` / `build.mac` / `build.dmg` 字段
- `main.js` 中 `autoUpdater` 相关代码
- `.github/workflows/build.yml`
- `scripts/build/sync-from-github-to-cos.js`
- `scripts/build/publish.js`
- `scripts/build/cleanup-cos.js`

**为什么强制要求**:更新机制的错误是"延迟暴露"的——一旦发出错版本,已下载的客户端就**永久无法自动更新**,用户只能手动下载新版,代价非常高。文档里记录了 6 个历史踩坑,确保不再犯。

发版前请用文档第 5 节"验证清单"自检。

## 常用命令

```bash
npm run dev              # 本地开发
npm run dist             # 本地打包(产物在 release/)
npm run upload           # 把 release/ 上传到 COS(本地打包后用)
npm run cleanup-cos      # 清理 COS 上的旧版本归档(默认保留 5 个)
node scripts/build/sync-from-github-to-cos.js --version=x.x.x   # 从 GitHub Release 同步到 COS
```

## 注意事项

- **不要在 GitHub Action 里直传 COS**:跨太平洋上传不稳定,统一走"本地 sync"链路
- **从 GitHub 下载需要走代理**:`.env` 里配 `PROXY_URL=http://127.0.0.1:7897`(Clash Verge Rev)
