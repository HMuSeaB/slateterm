# Changelog

## v1.1.4 - 2026-10-08

### 界面与交互优化

- **TabBar 支持鼠标中键一键关闭标签页**：中键点击任意标签即可秒关，对齐主流现代终端与浏览器直觉操作。
- **TabBar 新增「+ 新建标签页」按钮**：在标签栏末尾提供轻量快速的新建入口，配合平滑悬停与微动效反馈。
- **TabBar 右键菜单增强**：补充「关闭标签」、「关闭其他标签」、「关闭右侧所有标签」等完整操作，并与后台 PTY 会话安全回收深度协同。
- **双栏拖拽分屏 (Splitter) 交互升级**：拖拽激活时动态设置 `user-select: none` 与 `cursor: col-resize` 避免划选终端文本；引入 `requestAnimationFrame` 节流调度；新增精致的居中微型握柄指示条与悬停变亮动画。

### 缺陷修复与内存优化

- **修复 Command Blocks 抽屉渲染卡顿与正则内存暴涨**：将字符上限由 100 万调整为健康的 10 万字符；将 Block 拆分为独立的 `memo` 组件 `CommandBlockItem`，仅在展开查看或复制时通过 `useMemo` 延迟计算 ANSI 正则清洗，折叠时彻底跳过计算。
- **修复 WebGL 显存与 GPU Context 释放滞留**：显式追踪 `webglAddon` 实例并在组件卸载时彻底调用 `dispose()`，杜绝显存泄漏与多标签切换时的 GPU Context 耗尽。
- **修复系统临时目录旧临时图片累积膨胀**：新增后台异步清理机制，应用启动时静默清理超过 24 小时的历史临时图片文件。
- **修复剪贴板 DIB 解码潜在 panic 与句柄锁泄漏**：引入 `GlobalLockGuard` RAII 守卫保证全局锁一定释放，移除潜在 panic 的 `.unwrap()` 并做严格边界检查。

## v1.1.3 - 2026-10-07

修复：

- 修复 v1.1.1 里 Remote attach 完全不可用：发布版的主程序里其实没有内嵌 slateterm-attach，打开开关只会提示「没找到客户端」。根因是 `pnpm build:attach` 没带 `--release`，客户端编进了 `target/debug/`，而 `build.rs` 只按当前 profile 取 `target/release/` 下的那一份，两次内嵌都静默落空。
- `build:attach` 补上 `--release`，使客户端与主程序同一 profile；`build.rs` 的注释同步说明它只认当前 profile、不做「release 找不到就退回 debug」的降级，避免把 profile 不匹配藏起来。

改进：

- 发布工作流新增一步验证：构建主程序后扫 `slateterm.exe` 是否含客户端的 `--help` 文本（`用法：slateterm-attach`），搜不到就直接让 CI 失败。此前内嵌落空只发一条 cargo warning，产物照样出，问题会一路带进发布版。
- 补写本机验证：本地构建 release 客户端 + release 主程序后确认内嵌真的生效（主程序 10275328 → 11090944 字节，多出 815616，与客户端 800768 相符），并正反两方向验证 CI 断言——对坏产物报错、对好产物通过。
- 修正设置面板与「Remote attach 使用说明」里关于客户端的指引：此前写的「重开一次开关」和「重跑一次 `pnpm tauri dev`」都不解决问题，改为说明释放路径、可写性检查，以及 dev 下应在对应 profile 构建客户端。

发布说明：

- v1.1.2 这个 tag 打在了工作流仍有问题的提交上，CI 失败、没有产出任何 release；本版是修正后的产物，版本号直接顺延到 v1.1.3。

## Unreleased

- Refine the file drop overlay: show the dragged file names and count while hovering, soften the backdrop so terminal content stays readable, localize drop and attachment hints to Chinese, and quote dropped paths conservatively for both PowerShell and cmd.
- Fix pane hit-testing for native file drops after moving the window across monitors with different scale factors by reading the live device pixel ratio.
- Extend path completion from `cd` only to any command whose last argument contains a path separator, listing files and directories with folders first.
- Enable PSReadLine Tab menu completion and restructure the frontend around extracted path utilities, image byte helpers, a `useNativeFileDrop` hook, and dedicated drop overlay / attachment chip components.

## v1.1.1 - 2026-10-06

- 附加客户端改为内嵌进主程序，发布版只需下载一个文件。首次打开 Remote attach 开关时主程序把它释放到 `%LOCALAPPDATA%\SlateTerm\slateterm-attach-<版本号>.exe`，不用再保证两个 exe 在同一目录。
- 发布产物相应改为只上传主程序与 SHA256SUMS；CI 先单独构建客户端再构建主程序，保证内嵌一定拿到二进制。
- 修正 README 中 Remote Attach 一节的示例路径与重复段落。

## v1.1.0 - 2026-10-06

新增功能：

- 新增 Claude Code 完成提示音：Claude 回复结束时播放两声短音，依据终端标题字形判断工作/空闲状态，并监听 terminal bell 作为第二路触发。只在 Claude 会话响，普通 shell 不响，可在设置或命令面板关闭。
- 新增远程 attach：通过本机命名管道把正在运行的 Claude 会话共享给本机另一个终端（例如 UU 远程开出的窗口），对方能看到输出也能直接打字，`Ctrl+]` 断开且 SlateTerm 侧会话不受影响，`Ctrl+C` 原样交给 Claude。仅共享 Claude 会话，管道 DACL 限当前 Windows 用户并拒绝网络客户端，握手带一次性随机 token，默认关闭。
- 新增远程引导浮层：命令面板里可搜到「Remote attach 使用说明」，内含步骤说明与可复制的连接命令；设置面板只保留开关与命令本体。
- 新增 `pnpm build:attach` 脚本；发布产物改为随主程序一起分发 `slateterm-attach.exe`，用户拿到两个文件放在同一目录即可使用。
- 新增 Rust 依赖刷新工作流，默认试跑只打印版本表与 diff，确认后再落盘。
- 新增工作区快速切换、PSReadLine 原生补全（预测改 InlineView 并用 try/catch 兜底）与代理一键开关。

修复：

- 修复多行粘贴倒序：此前粘贴把剪贴板文本带原始 `\r\n` 直接写进 pty，ConPTY 将裸 `\n` 视为 Ctrl+Enter，而 PSReadLine 把 Ctrl+Enter 绑为 InsertLineAbove，于是每行都插到前一行上方。改为统一走 `terminal.paste()`，由它把换行归一成 `\r` 并在应用开启 bracketed paste 时整段包裹。
- 修复滑块开关在 WebView2 下勾选了但不动的显示问题：原实现依赖 input 的 `::after` 伪元素做 transform，改为 `ToggleSwitch` 组件用真实 DOM 承担视觉，checked 状态由 class 切换。
- 修正滑块位移计算错误：轨道内槽 36px、滑块 16px、两侧留白各 1px，位移应为 18px，原先写 16px 导致滑块贴死右壁、看似只滑一半。
- 修复跨屏缩放场景下原生拖放的命中错位（改为读取实时 device pixel ratio）。
- 修复 PSReadLine 预测配置在某些环境报错导致 shell 集成中断的问题。

改进：

- 暗色主题从冷蓝灰配 teal 改为暖深棕配琥珀，与 paper 主题同源；品牌标渐变恢复原配色，终端 ANSI 16 色随之调整为暖底协调。
- 重设计设置面板：自定义滚动条（12px 轨道加圆角滑块）、单列表单（标签置于输入上方）、iOS 风格滑块开关、统一的分段标题层级与纵向节奏；面板改为 flex 布局，头部固定不滚、内容区内部滚动，不再溢出屏幕。
- Tauri 命令改为异步执行，pty 输出改为增量 UTF-8 解码并合并事件，终端渲染与输入路径优化，修复 WebGL 渲染器拆除崩溃。
- 路径补全从仅 `cd` 扩展到任意命令的路径参数，目录与文件均可补全。
- 依赖升级：tauri 与 @tauri-apps 到 2.12.1，xterm 到 6.0 成套，vite 到 6.4.3；修复 source-map-js 漏洞（1.2.1 → 1.2.2）。
- 校正远程 attach 的构建说明：dev 下无需手动编译客户端，`cargo build` 默认即编译 crate 内所有 target。
- 发布工作流产物名改为跟随 tag，不再硬编码版本号。

## v1.0.0 - 2026-08-04

- Add Claude path attachment chips that collect dropped files and folders for the next prompt while ordinary shells continue to receive quoted paths directly.
- Add persistent terminal tab reordering with Windows-friendly pointer capture, clear insertion feedback, and saved workspace ordering.
- Refine the workspace file tree with SVG file-type icons, animated directory chevrons, hierarchy guides, keyboard-only focus rings, cached empty folders, and retryable loading states.
- Keep reliable Shell and Claude profile restoration, pane-aware native file drops, clipboard image attachments, command history, command palette, PowerShell command blocks, and named workspaces from the 0.1 series.
- Publish SlateTerm under the MIT License and add a reproducible GitHub Actions Windows release workflow.
- Remove personal workstation identifiers from repository history and use a GitHub noreply identity for published commits and tags.

## v0.1.2 - 2026-08-03

- Add folder-first workspaces, named workspace restore, verified session CWD creation, command palette/history, PowerShell command blocks, and responsive split-pane controls.
- Restore complete Shell and Claude Code profiles, active panes, and runtime state after restarting or reopening a saved workspace.
- Route native Windows file drops to the pane under the pointer; insert Explorer files and folders as quoted absolute paths while keeping clipboard images available as Claude Code attachments.
- Add file-tree context actions for opening or revealing items in Windows File Explorer and starting a terminal from the selected directory.
- Add interactive `cd` directory suggestions for ordinary shell sessions with keyboard and pointer selection.
- Refine Graphite and Paper themes with softer tactile surfaces, rounded controls, improved scrollbars, responsive drawers, and consistent dialogs.
- Fix Windows taskbar identity and icon rendering with a stable AppUserModelID, explicit window icon assignment, and a multi-size ICO.
- Improve startup diagnostics and frontend resource tracking to avoid stale or empty embedded assets.
- Stabilize frontend build filenames to avoid accumulating stale hashed assets between builds.
- Standardize dependency installation, frontend builds, and Tauri build hooks on pnpm.

## v0.1.1 - 2026-03-29

- Finalized the SlateTerm rename release.
- Bumped the app version to `0.1.1` across the main release manifests.
- Verified the frontend build and Rust checks for the release.
- Published tag `v0.1.1` and the matching GitHub Release.
