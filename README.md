# 防撤回 · SnowLora 版

把 [xh321/LiteLoaderQQNT-Anti-Recall](https://github.com/xh321/LiteLoaderQQNT-Anti-Recall) `master`（v0.3.0）移植到 **SnowLora 0.3.0+** 加载器的独立插件。零运行时依赖：用 JSON 文件替代 `level-party`，用 SnowLora 的 `load.js` + `console-message` 宿主通道替代 LiteLoader 的 `main/preload/renderer` 三段注入。

## 安装

1. 从 [Releases](https://github.com/MengBad/qqnt-anti-recall-snowlora/releases/latest) 下载 `qqnt-anti-recall-0.3.0+snowlora.8.zip`，在 QQ 设置 → SnowLora → 插件管理 → 本地安装里选择它。
2. 或手动把本目录复制到 SnowLora 的 `assets/qqnt-anti-recall/`，确认 `snowlora-plugin.json` 的 `script` 指向 `load.js`，重启 QQ。
3. 本地生成 zip：`node tools/pack.cjs`。

## 使用

- **QQ 设置 → 防撤回**（内嵌选项卡，和琉璃同机制）；`Alt+Shift+R` 可打开独立面板。无右下角悬浮按钮。
- 设置项与上游一致：撤回主题色、阴影、「已撤回」提示、是否反撤回自己消息、内存缓存上限、批量清理条数、是否持久化已撤回消息、清空记录。
- 「导出诊断」下载 `anti-recall-diag.json`，含版本、配置、缓存量、最近日志（不含聊天内容）。
- 数据目录：`%APPDATA%\QQ\snowlora\qqnt-anti-recall\`（`config.json`、`recalled-messages.json`）。

## 调试日志（复核 / 修 bug）

- 落盘路径：`%APPDATA%/<QQ userData>/snowlora/qqnt-anti-recall/logs/anti-recall.log`（JSONL，每行一条）。超过 2 MB 自动轮转为 `anti-recall.1~3.log`。
- 默认只写 `info/warn/error`（启动、窗口挂载、拦截/还原、异常、退出）；在 **设置 → 防撤回 → 诊断日志** 打开「写 DEBUG 级日志」后，额外落盘：全部 IPC 命令名（需同时开 `debugIpc`）、宿主请求/回复耗时、窗口导航、缓存淘汰、逐次 `webContents.send`。
- 内存保留最近 800 条（含 debug），不重启也能在设置页「实时日志」里看；「读取磁盘」可翻上一次 QQ 会话；「复制」「打开日志文件夹」「清空日志」都在同一面板。
- 渲染端 `window.onerror` / `unhandledrejection`、宿主超时、上游 `render()` 异常也进日志；日志只记 msgId、命令名、参数个数、异常栈，不写消息正文与聊天内容。
- 「导出诊断」的 `anti-recall-diag.json` 同时带 `log`（结构化）、`diskLog`（上次会话）和 `logText`（可直接贴给人看的文本）。

复核一条撤回的推荐顺序：开 DEBUG → 复现 → 设置页「刷新」或看日志文件 → 按 `msgId` 串起 `[debug][ipc] onRecvMsg` → `[info][recall] intercepted` → `[info][recall] restored` → `[debug][recall] tip-list`；缺哪一段就定位到消息缓存、增量拦截、全量还原还是 DOM 标记。

## 与上游的差异

| 上游 LiteLoaderQQNT | 本适配版 |
|---|---|
| `manifest.json` v4 + `injects` | `snowlora-plugin.json` schema 1 + 单 `load.js` |
| `LiteLoader.path.data` | `app.getPath('userData')/snowlora/qqnt-anti-recall` |
| `level-party` LevelDB | `store.cjs` 单文件 JSON（原子替换写） |
| `contextBridge` + `ipcMain.handle` | `console-message` + `executeJavaScript` 请求/回复桥 |
| `onSettingWindowCreated(view)` 挂 LiteLoader 设置页 | 克隆 QQ 原生 `.nav-item` 挂「防撤回」选项卡（`#/setting`），复用上游设置 HTML + 日志面板；另保留 `<dialog>` 与 `Alt+Shift+R` 快捷键，无悬浮按钮 |
| `main.js` 模块级副作用 + `onBrowserWindowCreated` 导出 | 进程级单例 `globalThis.__snowloraAntiRecallManager`，跨多次 HWND 执行复用 |
| `imgDownloader.js` / `rkeyManager.js` | `img-downloader.cjs` / `rkey-manager.cjs`，重定向与超时补齐 |

防撤回核心逻辑（消息流缓存、撤回 IPC 拦截、全量列表还原、图片补下载、DOM 标记）来自上游 `renderer.js` / `main.js`，由 `tools/build-renderer.cjs` 做最小变换后落到 `renderer/upstream.js`。

## 已知边界（与上游一致）

- QQ 收到消息前已被撤回、离线期间被撤回，仍无法恢复。
- 消息流超过 `maxMsgSaveLimit` 后最早的记录会被淘汰。
- 图片依赖 `llob.linyuchen.net/rkey` 刷新 rkey；服务器不可用时新图可能补下载失败。
- 已在 Windows QQ 9.9.37 + SnowLora 0.3.0 实机验证（模板环境基于 9.9.36）；其它 QQ 版本选择器可能变化。

## 测试

```bash
node --test tests/*.test.cjs
node tools/build-renderer.cjs
node tools/pack.cjs
```

## 许可

MIT，沿用上游 `LICENSE`。
## 致谢

- [xh321/LiteLoaderQQNT-Anti-Recall](https://github.com/xh321/LiteLoaderQQNT-Anti-Recall) — 本插件的防撤回核心逻辑（消息流缓存、撤回 IPC 拦截、全量列表还原、图片补下载、DOM 标记与原生设置项）全部源自该项目（MIT）。
- [SnowLora](https://github.com/SnowLuma/SnowLora) — 由 MliKiowa 开发、SnowLuma 维护的 QQNT 插件加载器；窗口规则注入、多 HWND 执行与 `snowlora.script` / `snowlora.window` 契约是本适配的运行基础。
- [LilycleHeart/qqnt-liuli-theme](https://github.com/LilycleHeart/qqnt-liuli-theme) — SnowLora 适配版的设置页选项卡挂载方式、`console-message` 宿主桥与多窗口管理器是本移植的直接参考。
- [LLOneBot](https://github.com/LLOneBot/LLOneBot) — rkey 刷新思路来自其 `rkeyManager`，经上游 `imgDownloader.js` 传入。
