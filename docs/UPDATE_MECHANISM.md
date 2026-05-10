# DesktopSecretary 自动更新机制

> **修改更新相关代码前必读。** 任何一处配错都可能导致整批客户端永久无法自动更新（参见文末"历史踩坑")。

---

## 1. 整体链路

```
本地: bump version → git push → 在 GitHub UI 创建 tag/release
  ↓ 自动触发 (.github/workflows/build.yml)
GitHub Actions matrix 构建 (Windows + macOS)
  ↓ electron-builder 打包，产出:
  │   ├─ 安装包: DesktopSecretary-x.x.x-{win-x64.exe | mac-arm64.zip | mac-x64.zip | arm64.dmg | x64.dmg}
  │   ├─ latest.yml          (Windows 元数据，给 electron-updater 检查更新用)
  │   ├─ latest-mac.yml      (macOS 元数据)
  │   └─ app-update.yml      (打入应用包内 Resources/，客户端启动时读取，告诉 autoUpdater 去哪查)
  ↓ softprops/action-gh-release 上传
GitHub Release v.x.x.x assets (含 yml，关键!)
  ↓ 本地手动执行
PROXY_URL=http://127.0.0.1:7897 node scripts/build/sync-from-github-to-cos.js --version=x.x.x
  ↓ 下载 assets + 上传 (含 latest*.yml)
腾讯云 COS: ds-update-1420931574/updates/{win,mac}/
  ↓ 客户端定时拉
electron-updater 读 latest.yml / latest-mac.yml 比对版本 → 触发更新
```

---

## 2. 三个 yml 文件,千万别搞混

| 文件 | 在哪 | 谁生成 | 作用 |
|------|------|--------|------|
| `app-update.yml` | **应用包内** `Resources/app-update.yml` (mac) 或 `resources/` (win) | electron-builder 打包时,基于 `package.json` 的 `build.publish` 字段生成 | 客户端启动时读它,知道**去哪查更新**(feedURL)。**没有这个文件,客户端启动 autoUpdater 直接 ENOENT 报错,永远没法自动更新。** |
| `latest.yml` | GitHub Release + COS `updates/win/latest.yml` | electron-builder 打包时输出到 `release/` | Windows 客户端拉取它,比对自己版本 → 决定是否更新 |
| `latest-mac.yml` | GitHub Release + COS `updates/mac/latest-mac.yml` | electron-builder 打包时输出到 `release/` | macOS 客户端拉取它,比对自己版本 → 决定是否更新 |

**关键区别**:
- `app-update.yml` 是"客户端的地图"——出厂打包时刻一次性确定,装到用户机器上就改不动了
- `latest*.yml` 是"远端的花名册"——每次发版都要更新,客户端拉过来对照

---

## 3. 关键文件清单

### 3.1 [package.json](../package.json) — `build.publish` 必须有

```json
{
  "build": {
    "publish": [
      {
        "provider": "generic",
        "url": "https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/updates/${os}"
      }
    ]
  }
}
```

- `${os}` 是 electron-builder 的占位符,打包 mac → `mac`,打包 win → `win`
- **没有这个字段 = `app-update.yml` 不会生成 = 已发出去的客户端永久坏掉**(除非用户手动下载新版)
- 历史上曾配为 `"publish": null`,后被移除。**永远不要再写 `publish: null`,要写也要写完整的 generic 配置**

### 3.2 [package.json](../package.json) — 平台 `artifactName`

```json
"win":   { "artifactName": "${productName}-${version}-win-x64.${ext}" }
"mac":   { "artifactName": "${productName}-${version}-mac-${arch}.${ext}" }
"dmg":   { "artifactName": "${productName}-${version}-${arch}.${ext}" }
```

注意:**dmg 命名特意没有 `-mac-`**(历史遗留),所以同一个 1.0.12 mac 版本会同时产出:
- `DesktopSecretary-1.0.12-mac-arm64.zip` (含 `-mac-`)
- `DesktopSecretary-1.0.12-arm64.dmg` (无 `-mac-`)

electron-builder 生成的 `latest-mac.yml` 会用实际文件名,sync 脚本和 publish 脚本也都用 glob 匹配,所以**这个不一致不会导致 bug**——但提到这点是为了让你看到 yml 里 dmg 没 `-mac-` 时不要以为是错的。

### 3.3 [main.js](../main.js) `autoUpdater` 配置

```javascript
const platformDir = process.platform === 'darwin' ? 'mac' : 'win';
const feedUrl = `https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/updates/${platformDir}`;
autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
```

- `setFeedURL` 是对 `app-update.yml` 内容的**运行时覆盖**
- 现状两边的 url 是一样的,`setFeedURL` 是冗余但安全
- **不要把 `setFeedURL` 删掉**就指望 `app-update.yml` 兜底,除非你确定打包流程已修复并测过——保留 `setFeedURL` 也没成本

### 3.4 [.github/workflows/build.yml](../.github/workflows/build.yml) — release 上传必须含 yml

```yaml
- name: Upload Windows assets to Release
  uses: softprops/action-gh-release@v2
  with:
    files: |
      release/*.exe
      release/*.exe.blockmap
      release/latest.yml          # ← 必须

- name: Upload macOS assets to Release
  uses: softprops/action-gh-release@v2
  with:
    files: |
      release/*.dmg
      release/*.zip
      release/latest-mac.yml      # ← 必须
```

历史上漏写过 `latest*.yml`,导致 GitHub Release 上没有 yml 文件,sync 脚本无法把 yml 同步到 COS,COS 上的 yml 一直停留在旧版本 → 客户端检测不到新版。

### 3.5 [scripts/build/sync-from-github-to-cos.js](../scripts/build/sync-from-github-to-cos.js)

从 GitHub Release 下载 assets 上传到 COS。**它依赖 GitHub Release 上有 `latest.yml` / `latest-mac.yml`**——如果 Release 里没有,sync 出来的 COS 也就没有,客户端就检测不到更新。

GitHub 在国内速度慢,需要本地代理:`.env` 里配 `PROXY_URL=http://127.0.0.1:7897`(Clash Verge Rev 默认端口)。

### 3.6 [scripts/build/publish.js](../scripts/build/publish.js) — 本地打包发布(备用)

如果你在 mac 设备上本地 `npm run dist` 出包,这个脚本能直接把 `release/` 目录里的全套(含 yml)上传到 COS。但**你大概率没有 mac 设备**,所以这个脚本主要用于纯 Windows 流程,或者紧急修补时。

---

## 4. 完整发版流程(标准)

```bash
# 1. 改 package.json 版本号,如 1.0.12 → 1.0.13
# 2. 提交并推送
git add package.json
git commit -m "chore: bump version to 1.0.13"
git push

# 3. 在 GitHub UI 创建 tag v1.0.13 + Release(也可以用 gh CLI)
gh release create v1.0.13 --generate-notes

# 4. 等 GitHub Action 跑完(~10-15 分钟,matrix 两个平台并行)
gh run watch

# 5. 验证 Release 资产齐全
gh release view v1.0.13 --json assets --jq '.assets[].name'
# 必须看到: latest.yml, latest-mac.yml, *.exe, *.dmg, *.zip 全套

# 6. 本地同步到 COS
node scripts/build/sync-from-github-to-cos.js --version=1.0.13

# 7. 验证 COS 上的 yml 已经是新版本
curl https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/updates/win/latest.yml
curl https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/updates/mac/latest-mac.yml
# version 字段必须是 1.0.13

# 8. (可选) 清理过老的版本归档,默认保留最近 5 个
node scripts/build/cleanup-cos.js
```

---

## 5. 验证清单(每次发版后必跑)

| 检查项 | 命令 | 预期 |
|--------|------|------|
| GitHub Release 含 yml | `gh release view vX.X.X --json assets --jq '.assets[].name'` | 列表里有 `latest.yml` 和 `latest-mac.yml` |
| COS Windows yml 是新版 | `curl https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/updates/win/latest.yml` | `version: X.X.X` 正确 |
| COS macOS yml 是新版 | `curl https://ds-update-1420931574.cos.ap-guangzhou.myqcloud.com/updates/mac/latest-mac.yml` | `version: X.X.X` 正确 |
| COS 文件齐全 | 各平台 200 OK 检查每个文件 | exe/dmg/zip 都返回 200 |
| 客户端能检测到新版 | 旧版本应用点"检查更新" | 提示发现新版,而不是 ENOENT |

---

## 6. 历史踩坑(别再犯)

### 坑 1: `package.json` 配 `publish: null` → app-update.yml 不生成
- **症状**:客户端启动报 `ENOENT: no such file or directory, open '.../Resources/app-update.yml'`
- **影响范围**:**已发布的客户端永久无法自动更新**,只能让用户手动下载下一版
- **根因**:electron-builder 看到 `publish: null` 不生成 `app-update.yml`,没有这个文件 autoUpdater 启动直接报错
- **修复**:在 `package.json` 的 `build` 里写完整的 `publish: [{ provider: 'generic', url: '...${os}' }]`
- **教训**:`setFeedURL` 在代码里调用**不能替代** `app-update.yml`——electron-updater 启动时强制读这个文件

### 坑 2: GitHub Action 上传 release 漏了 `latest*.yml`
- **症状**:COS 上的 `latest-mac.yml` 一直停留在旧版本(比如 1.0.8),mac 客户端检测不到新版
- **根因**:`softprops/action-gh-release` 的 `files:` glob 里没写 `release/latest*.yml`,所以 GitHub Release 上没有 yml,sync 脚本同步不到 COS
- **修复**:确保 release 上传步骤包含 `release/latest.yml` (Win) 和 `release/latest-mac.yml` (Mac)
- **如何应急补救**:写一次性脚本(参考 [scripts/build/fix-mac-yml.js](../scripts/build/fix-mac-yml.js))从 COS 流式下载文件,算 sha512 + size,生成正确的 `latest-mac.yml`,上传覆盖

### 坑 3: GitHub Action 内直接 publish 到 COS 不可靠
- **症状**:Action 跑到上传 COS 步骤就失败/超时
- **根因**:GitHub runners 在美国,COS 在广州,跨太平洋延迟大且不稳定;COS 大文件超时频发
- **修复**:Action 只负责打包 + 传 GitHub Release;COS 上传走本地 sync 脚本(国内网络快多了)
- **教训**:**别再尝试**让 Action 直传 COS

### 坑 4: 从 GitHub Release 下载到本地慢/超时
- **症状**:sync 脚本卡在 0% 或频繁断流
- **根因**:GitHub CDN 在国内不稳定,下载几百 MB 包很慢
- **修复**:`.env` 配 `PROXY_URL=http://127.0.0.1:7897`(Clash Verge Rev),sync 脚本走代理;还有 3 次自动重试

### 坑 5: COS 列目录用普通 prefix 扫描非常慢
- **症状**:`cleanup-cos.js` 跑几百页 (每页 26 对象) 还在跑
- **根因**:`getBucket` 不带 `Delimiter` 会全表扫描
- **修复**:用 `Delimiter: '/'` + `CommonPrefixes` 高效列出版本号目录(参考 [scripts/build/cleanup-cos.js](../scripts/build/cleanup-cos.js) 的 `listVersionDirs`)

### 坑 6: dmg 与 mac zip 的 artifactName 不一致
- **观察**:dmg 没有 `-mac-` 前缀,mac zip 有
- **会不会出 bug**:不会。electron-builder 自己生成 yml 时用的是真实文件名,所以名字不一致没问题
- **但是**:如果你手写 yml 或者写脚本拼文件名,要记住这两个命名规则不同,别想当然

### 坑 7: sync 脚本 dedup 把 yml 也跳过了 → COS 上的 yml 永远是旧版
- **症状**:sync 完成日志里看到 `[Sync] 跳过（已存在）: updates/mac/latest-mac.yml`,客户端拉到的 yml 永远是旧版本号
- **根因**:`checkCosFileExists` 对所有文件统一处理,但 yml 文件名不变(`latest.yml` / `latest-mac.yml`),内容每次新版必变 → dedup 永远命中,新内容永远上不去
- **修复**:在 [sync-from-github-to-cos.js](../scripts/build/sync-from-github-to-cos.js) 里**强制覆盖** yml,不走 dedup
- **教训**:**dedup 必须按"内容是否会变"来判断,而不是统一一刀切**。yml 类元数据 = 总会变 = 必须覆盖;安装包 = 内容由文件名 + 版本号决定 = 可以 dedup

### 坑 8: blockmap 没被同步 → Windows 自动更新走全量下载
- **症状**:Windows 客户端检测到新版后,差分更新失败,回落到全量下载安装包(85MB+)
- **根因**:sync 脚本的过滤器只匹配 `.exe / .zip / .dmg / latest*.yml`,**漏了 `.exe.blockmap`**;而且 cosKey 推断也只看 `endsWith('.exe')`,blockmap 即使被同步也会跑去 mac 目录
- **修复**:过滤器加上 `.endsWith('.exe.blockmap')`,cosKey 推断同步加上 blockmap 判断
- **教训**:发版前用第 5 节"验证清单"过一遍,curl 检查 COS 上每类文件都齐全

---

## 7. Memory 提示给未来的 Claude

如果你正要修改:
- `package.json` 的 `build` 字段(尤其是 `publish` / `artifactName`)
- `main.js` 的 `autoUpdater` 配置
- `.github/workflows/build.yml`
- `scripts/build/sync-from-github-to-cos.js`
- `scripts/build/publish.js`

**先把本文档完整读一遍**,然后用本文第 5 节的"验证清单"自检你的改动会不会让客户端检测不到更新。

特别注意:**很多更新错误是"延迟暴露"的**——你改完构建配置可能要发一次新版才能验证;而且坏掉的客户端是回不来的(用户必须手动下载),代价很高。

发版前如果不确定,跑一遍:
```bash
npm run dist                 # 本地打包
ls release/                  # 必须看到 app-update.yml(在 .icon-ico 同级,或 win-unpacked/resources/ 内)
ls release/*.yml             # 必须看到 latest.yml / latest-mac.yml 至少一个
```

如果 `app-update.yml` 在 `release/` 或 `release/win-unpacked/resources/` 找不到,**立即停手**——你的 `package.json` 的 `publish` 配置肯定坏了。
