# slateterm-ui（已停止，勿用）

这是 2026-10-31 **否决**的 GPUI 方案原型。它是一份历史存档，
**不参与 SlateTerm 的任何构建，也不会编进发布的 exe**。

## 为什么停止

- `gpui-pre 0.3.10` 依赖未稳定的 `slice_as_array`，必须 nightly 工具链。
- Windows 高 DPI 下渲染面卡死在约 1080×690，属于框架级限制，绕不过去。

上游 GPUI 后续怎么修都不影响本仓库：主程序 `src-tauri/Cargo.toml`
与 `Cargo.lock` 里没有任何 gpui 依赖，根目录也没有 Cargo workspace
把这个 crate 拉进构建。

## 现在终端区走哪条路

界面继续用 React（WebView），只把**终端渲染层**换成自绘网格
`slateterm-grid/`：`alacritty_terminal` 解析 VT 序列 + `fontdue`
栅格化字形 + 自写 PNG 编码，前端整帧贴到 canvas。
它和 GPUI 没有任何关系。

默认渲染器仍是 `xterm`，自绘网格是设置面板里的可选项，
不主动切换的话行为与旧版一致。

## 这个目录为什么还在

用户明确要求保留 GPUI 实验代码，不要删。从 `main` 移除它不会
影响任何构建；代码也会永久留在 `v1.2.0` tag 与 git 历史里。
当前只是留着没动 —— **不要把它当作仍在维护的组件**。
