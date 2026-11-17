## 防撤回 · SnowLora 版 v0.3.0+snowlora.8

把 LiteLoaderQQNT-Anti-Recall v0.3.0 移植到 SnowLora 加载器的独立插件。

### 安装
QQ 设置 → SnowLora → 插件管理 → 本地安装，选择本 Release 附件 `qqnt-anti-recall-0.3.0+snowlora.8.zip`。

### 使用
- QQ 设置 → **防撤回**（内嵌选项卡）；`Alt+Shift+R` 打开独立面板。
- 首次建议在「诊断日志」里打开 DEBUG，方便复核撤回链路。

### 主要改动
- 零运行时依赖：JSON 文件替代 level-party；`console-message` + `executeJavaScript` 替代 LiteLoader 的 IPC/preload。
- QQ 设置页内嵌选项卡（与琉璃主题同机制），无右下角悬浮按钮。
- 结构化 JSONL 日志（2MB 轮转、DEBUG 开关、实时查看/导出）。
- 修复 `saveDb=true` 启动 TDZ 崩溃、规则名跨插件冲突、池窗口 in-page 路由拦截等关键问题。

### 致谢
- xh321/LiteLoaderQQNT-Anti-Recall（MIT）：防撤回核心逻辑来源。
- SnowLora / SnowLuma：QQNT 插件加载器与窗口注入契约。
- LilycleHeart/qqnt-liuli-theme：设置页挂载与宿主桥参考。
- LLOneBot：rkey 刷新思路。

完整说明见仓库 README 与 PORTING-NOTES.md。