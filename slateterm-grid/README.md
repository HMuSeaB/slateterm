# slateterm-grid

自绘终端网格。用 `alacritty_terminal` 解析 VT 序列，用自己的栅格化出像素。

## 为什么单独一个 crate

现有终端区跑在 `@xterm/xterm` 上，能用的都用了（WebGL、fit、search），
但它把字形、行距、光标形态、选区绘制全都收在自己内部，我们能调的只有配色表。
观感的天花板因此被锁住——外壳做得再细，终端区还是"xterm 的样子"。

这一层拿回的是那部分控制权，**不换框架**：
界面仍是 React，只是在终端区域换成一块自己绘制的 canvas。

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/palette.rs` | 配色数据结构，含 ANSI 16 色与 256 色映射、WCAG 对比度计算 |
| `src/theme.rs` | 主题加载（alacritty TOML 格式）与可读性校正，主题编译期内嵌 |
| `src/hub.rs` | **会话级管理器**：多会话、主题切换、按需出帧、base64 与 PNG 编码 |
| `src/font.rs` | 字形栅格化与缓存，中文回退到系统字体 |
| `src/render.rs` | 网格绘制：背景、文字、下划线、光标、选区 |
| `themes/*.toml` | 14 套配色，alacritty 格式，可直接替换 |
| `src/bin/live.rs` | 端到端验证：起真实 PowerShell 跑命令并出图 |
| `src/bin/shell.rs` | 界面合成：把网格贴进现有外壳尺寸，出完整对照图 |
| `src/bin/swatch.rs` | 单套主题的色卡样张 |
| `src/bin/compare.rs` | 多套主题并排对比（内容完全一致） |
| `src/bin/overview.rs` | 全部主题拼成一张总览图 |

## 为什么 hub 在这个 crate，不在 src-tauri

`GridHub` 是本 crate 的核心业务逻辑，不是 Tauri 的附属物。放这里有两个实际好处：

1. **能被编译和测试**。本机 `src-tauri` 的 cargo 编译会被沙箱拦截
   （`.temp-archive` 无法删除，os error 5），放在那里等于这段代码永远无法验证。
2. **宿主可换**。`src-tauri/src/grid.rs` 现在只剩 serde 结构和命令转发，
   逻辑改动不会散落在两个地方。

对应地，`src-tauri` 侧的 8 个命令都只是薄封装，出错面收窄到序列化那一层。

## 主题内嵌，不读磁盘

SlateTerm 直接分发 exe（`src-tauri/tauri.conf.json` 里 `bundle.active = false`），
用户机器上不一定有 `themes/` 目录。所以主题用 `include_str!` 编译进二进制：

- 二进制自包含，不受工作目录、安装路径影响
- 加主题只需在 `theme.rs` 的 `BUILTIN` 里补一行，`include_str!` 会在编译期校验文件存在
- `load_dir()` 保留给出图工具用（`swatch` / `compare` / `overview` 仍从磁盘读，方便临时改配色试效果）

## 主题

`themes/` 里 14 套，**alacritty 的 TOML 格式**，社区现成主题可以原样丢进来：

```
ely-dark / ely-light                              自有配色，与 styles.css 同源
catppuccin-mocha / macchiato / frappe / latte
tokyo-night / dracula / nord / gruvbox-dark
kanagawa-wave / rose-pine / solarized-light / one-light
```

加载时会过一遍 `Palette::fix_visibility`，把对比度不足的 ANSI 色推到可读。
**这不是可选项**：Dracula 的 ANSI 0 是 `#21222c`，与背景 `#282a36` 的对比度只有 1.47；
One Light 的 ANSI 3 是 `#d2b67c`，配 `#f9f9f9` 只有 1.96。
这类颜色由程序显式指定时（警告行、黑底文字），实际是隐形的。

校正只改明度、按比例缩放 RGB 保持色相，不会把蓝紫变成灰。
`tests` 里有一条 `every_shipped_theme_is_readable` 会校验全部 14 套。

## 两个关键决定

**中文走回退字体。** `Cascadia Mono` 没有汉字，不回退就是一片豆腐块。
`FontPair` 按字符逐个判断：等宽字体有就用自己的，没有就用 `msyh.ttc`。
宽度判定独立于字体——`is_wide()` 按码位区间判断，中文占两格，不看字形的实际宽度。

**配色由主题决定，不照搬 ANSI 标准色。** 标准色里的纯红纯绿在暖色底上很刺眼，
也是"终端看着廉价"的主因之一。自有主题把 ANSI 16 色映射到品牌的暖色系，
`git status` 的红、`cargo` 的绿都还在，但不再抢眼。
其余 12 套是社区经典配色，原样保留调性，只校正可读性。

## 跑法

```bash
# 出终端区特写（预设会话，覆盖常见 ANSI 场景）
cargo run -- out/dark.png dark

# 起真实 PowerShell，验证真实 PTY 输出
cargo run --bin live -- out/live.png dark

# 贴进现有外壳（标题栏 58 / 侧栏 260 / 右栏 300 / 上下文条 48）
cargo run --bin shell -- out/shell-dark.png dark
cargo run --bin shell -- out/shell-light.png light

# 主题相关
cargo run --bin swatch   -- themes out/themes              # 14 套各出一张色卡
cargo run --bin swatch   -- themes out/themes nord         # 只出一套
cargo run --bin compare  -- themes out/cmp.png ely-dark,dracula,nord
cargo run --bin overview -- themes out/themes out/all.png 5
```

依赖走 rsproxy 镜像（`.cargo/config.toml`），因为本机 `cargo` 直连
`index.crates.io` 会挂住不动。

## 接进 SlateTerm 的现状

已经完成（`src-tauri/src/grid.rs` + `src/lib/gridTerminal.ts`）：

- 8 个 Tauri 命令：`grid_create_session` / `feed` / `resize` / `close` /
  `frame` / `list_themes` / `set_theme` / `set_look`
- `GridTerminal` 伪装成 xterm 的 `Terminal` 接口
  （`write` / `open` / `dispose` / `onData` / `element` / `focus`），
  `TerminalPane` 的输入处理、路径附件、命令记录都通过**同一个**
  `handleTerminalInput` 走，两条渲染路径不会有功能分叉
- 设置面板有 `Terminal Renderer` 下拉，默认仍是 `xterm`
- `ResizeObserver` → `grid_resize` 回路已接
- 主题随界面明暗模式映射：`graphite` → `ely-dark`，`paper` → `ely-light`

还没做：

1. **搜索**。`xterm-addon-search` 绑死在 xterm 内部，grid 路径下不可用，
   界面上会明确提示而不是静默失效。需要 Rust 侧提供 `search(query)` 接口。
2. **选中与复制**。目前只能整屏重绘，选区和右键菜单还没接。
   需要 `GridHub` 暴露单元格坐标 → 字符的映射。
3. **滚动回看**。`alacritty_terminal` 有 scrollback（已设 10000 行），
   但前端还没有滚轮→`display_offset` 的通路。

这三件都不影响"看"和"输入"，属于可用性补全。

## 依赖

`cargo` 走 rsproxy 镜像（`.cargo/config.toml`），因为本机直连 `index.crates.io` 会挂住不动。
