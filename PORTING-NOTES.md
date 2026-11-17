# 防撤回 → SnowLora 移植说明

> 上游基线：`xh321/LiteLoaderQQNT-Anti-Recall` `master` @ `402b0066b62ba7bd290b3a0493f7f1bb840269f8`（v0.3.0）
> 适配基线：[LilycleHeart/qqnt-liuli-theme](https://github.com/LilycleHeart/qqnt-liuli-theme) SnowLora 版（`snowlora-plugin.json` + `load.js` 多窗口管理器 + `console-message` 宿主桥）

## 1. 加载器运行时契约

SnowLora 是 QQNT 的插件加载器：按插件清单的窗口标题规则，对每个匹配的 HWND 执行一次 `script`（主进程上下文）。因此：

- `load.js` 顶层用 `createRequire(snowlora.script)` 建模块解析根，`snowlora.script` / `snowlora.window` 由加载器注入；
- 全部状态挂 `globalThis.__snowloraAntiRecall*`：`windows` Map、`ring` 日志、`ctx`（config/store/interceptor）、`manager`；
- `app.on('browser-window-created')` + `BrowserWindow.getAllWindows()` 只注册一次，之后每次执行只 attach 当前 `snowlora.window` 并 `await state.ready`；
- 窗口筛选复用琉璃主题的 `eligible(url)`：`app:` + `/renderer/index.html` + 非空 hash，排除 `blank/tray-menu/av/screen/share`；
- **规则名命名空间**：SnowLora 对规则名做全局唯一校验（`Rule names must be nonempty and unique`）。照抄琉璃主题的 `qq-main` / `qq-main-settings` / `qq-main-settings-qq` 会在两个插件共存时启动失败，因此本插件统一用 `qqnt-anti-recall-` 前缀；`tests/packaging.test.cjs` 会读取同目录的 `snowlora-plugin.json` 做交集回归。
- 渲染端不靠 preload：`wc.executeJavaScript()` 注入 `host.js` + `upstream.js` + `settings.js`，宿主请求走 `console.debug(token + JSON)`，主进程 `console-message` 收到后 `executeJavaScript('window.AntiRecall.reply(...)')` 回包。

## 2. 主进程逻辑迁移

| 上游 | 适配 |
|---|---|
| `onLoad()` 里注册 3 个 `ipcMain.handle` | `methods` 对象 + `onConsole()` 解析 `token + JSON` 并回包 |
| `sendChatWindowsMessage()` 广播 | `notifyAll()` 遍历 `windows`，未注入时进 `state.pending` 队列 |
| `onBrowserWindowCreated(window)` 挂 `did-stop-loading` 后 patch `webContents.send` | `RecallInterceptor.install(win)` 按 `WeakSet<wc>` 去重，兼容 `__qqntim_original_object`；额外挂 `did-navigate-in-page`，覆盖 SnowLora 池窗口从 `#/blank` 切到 `#/main/message` 的路径 |
| 拦截体 300+ 行闭包 | 拆成 `RecallInterceptor._inspect()` 的 A（全量 msgList 还原）/ B（增量 IPC）两段，保留 `msgFlow`、`recalledMsg`、特殊字段保留与 `msgAttrs/msgMeta/generalFlags` 合并语义 |
| `Level(pluginDataDir/qq-recalled-db)` | `RecalledStore`：Map + `recalled-messages.json`，`put/get/clear/flush`，原子 tmp+rename |
| `app.on('quit', () => db.close())` | `app.on('quit', () => ctx.store.flush())` |
| `dialog.showMessageBox` 清空确认 | 保留，移到 `methods.clearDb` |

额外修复：`imgDownloader.request` 上游不处理 HTTP 4xx、相对 `Location` 与超时；适配版补齐重定向上限、状态码检查与 15s 超时。`getImageUrl` 新图 rkey 用 `URL.searchParams` 拼接，不再手工字符串相加。

## 3. 渲染端迁移

`renderer/upstream.js` 由 `tools/build-renderer.cjs` 从 `upstream/renderer.js` 生成，四处最小变换（外加生成标记注释）：

1. `export async function onSettingWindowCreated(view)` → 普通函数声明（注入脚本是普通 async IIFE，不是 ESM）；
2. 在 `render()` 的 `elements` 之后加 `if (!elements) return;`，避免启动早期 `recallTipList` 到达但 `.chat-msg-area__vlist` 还不存在时抛错；
3. 末尾追加 `window.AntiRecall.onSettingWindowCreated = onSettingWindowCreated;`，让独立 IIFE 的 `settings.js` 能拿到上游设置构建函数；
4. 追加生成标记注释。

其余 685 行（设置 HTML/CSS、开关绑定、`patchCss()`、`recallTip`/`recallTipList` 回调、`MutationObserver`、`.message-content-recalled` 标记）原样保留。

`renderer/host.js` 提供 `window.anti_recall` 兼容面，把上游的 `getNowConfig/saveConfig/clearDb/repatchCss/recallTip/recallTipList` 映射到 SnowLora 宿主桥；`renderer/settings.js` 用自持 `<dialog>` 接住 `view.appendChild(node2)`，并加入快捷键、诊断导出（无悬浮按钮）；`renderer/settings-page.js` 按琉璃主题实测的 `.setting-tab → .nav-bar → .nav-item` / `.setting-main` 结构克隆原生导航项，在 `#/setting` 挂「防撤回」选项卡，点击时隐藏原生 `.q-scroll-view`、渲染同一套上游设置 + 日志面板，切走时还原标题与选中态。

重复注入保护：`load.js` 生成的脚本先检查 `window.__snowloraAntiRecallInjected`，已注入时只 `setToken()` + `applyConfig()` 并 return，不会重复注册 observer / 重复 `onLoad()`。

## 4. 设置与持久化

- `config.cjs` 做类型收敛与范围钳制（颜色必须是 `#rrggbb`，两个数量字段 1..上限），避免上游 `parseFloat` 越界值写坏配置。
- `saveDb` 由 `methods.saveConfig` 同步到 `store.setEnabled()`；关闭后已有记录不删除，与上游 README 行为一致。
- `clearDb` 同时清 `interceptor.recalledMsg` 并广播空 `recallTipList`。

## 5. 调试日志

`logger.cjs` 是零依赖的 JSONL 记录器：`write(level, scope, event, data)` 同时写内存 ring（800 条）与 `logs/anti-recall.log`，2 MB 轮转最多 3 份。`debug` 级由 `config.debugLog` 控制是否落盘，ring 始终全收，所以导出诊断无需先开开关。`safe()` 做 3 层深度限制、40 键上限、1000 字符裁剪与 Error 展开，避免把消息对象整棵写进文件。

`load.js` 的 `output()` 兼容旧字符串调用与 `[level][scope] event` 结构化调用；关键埋点：`boot/plugin-load`、`window/attached|destroyed`、`inject/window-ready|window-failed|window-skip|did-*`、`host/request|response|config-saved|store-cleared`、`[intercept] patched|send|inspect-exception`、`[recall] intercepted|restored|tip-list|miss`、`[cache] trimmed`、`boot/quit`。

渲染端 `renderer/host.js` 的 `log()` 先缓冲到 `flushLogBuffer()`（合并进同一个注入脚本，不依赖第二次 `executeJavaScript`），再经 `method: log` 送主进程；`build-renderer.cjs` 把上游 4 处 `console.log("[Anti-Recall]", …)` 同时接到日志桥，异常对象带 `message/stack`。`renderer/settings.js` 追加「诊断日志」分区：开关、实时查看、磁盘回读、复制、打开文件夹、清空。

## 6. 验证

- `node --test tests/*.test.cjs`：配置、存储、rkey、图片 URL、拦截核心、清单、生成物、语法、打包。
- `node tools/build-renderer.cjs`：重新生成 `renderer/upstream.js`。
- `node tools/pack.cjs`：产出可直接本地安装的 zip。
- 实机验收需在 QQ 9.9.36 + SnowLora 0.3.0 完成：撤回文本 / 图片 / 自己消息，检查红框、「已撤回」提示、重进会话仍可见、重启 QQ 后（开启 `saveDb`）仍可见。
## 7. 实机修复记录

- `saveDb=true` 时 `store.setEnabled()` 在 `ctx` 的 IIFE 内同步触发 `_load() → output()`，而 `output()` 旧实现引用了尚未初始化的 `const logger = ctx.logger`（TDZ），SnowLora 的 `execute.js` 把异常吞成 `[script]` 错误，表现为「插件不加载」。现 `output()` / `redactArgument()` 一律从 `globalThis.__snowloraAntiRecallLogger` 取启动期日志器，`tests/startup.test.cjs` 用完整 `load.js` 在 `saveDb=true/false` 两种配置下跑启动回归。
## 8. 日志与 UI 收窄

- 删除右下角 `#anti-recall-settings-entry` 悬浮按钮及其 CSS；保留 QQ 设置页选项卡、`Alt+Shift+R` 与 `anti-recall-open-settings` 事件入口。
- `host.js` 的全局 `error` / `unhandledrejection` 监听只把带 `Anti-Recall` 标记的错误记为 `error`，QQ 自身的 `cancel` 拒绝与 `ResizeObserver loop` 噪声直接忽略，其它外部异常降级为 `debug`（默认不落盘），避免日志被 50+ 条无关 error 淹没。
- v7 收窄监听时误删了 `renderer-ready` 启动日志，v8 恢复；这条日志是复核「注入是否完成」的锚点，与 `settings-page-script-loaded` / `window-ready` 一起构成启动证据。