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
| `src/theme.rs` | 主题加载（alacritty TOML 格式）与可读性校正 |
| `src/font.rs` | 字形栅格化与缓存，中文回退到系统字体 |
| `src/render.rs` | 网格绘制：背景、文字、下划线、光标、选区 |
| `themes/*.toml` | 14 套配色，alacritty 格式，可直接替换 |
| `src/bin/live.rs` | 端到端验证：起真实 PowerShell 跑命令并出图 |
| `src/bin/shell.rs` | 界面合成：把网格贴进现有外壳尺寸，出完整对照图 |
| `src/bin/swatch.rs` | 单套主题的色卡样张 |
| `src/bin/compare.rs` | 多套主题并排对比（内容完全一致） |
| `src/bin/overview.rs` | 全部主题拼成一张总览图 |

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

## 接进 WebView 还差什么

这一版是 CPU 栅格化出 PNG，用来验证观感和字形，**不是最终形态**。
接进 SlateTerm 需要补三件事：

1. 把 `render()` 的输出改成往 canvas 的 `ImageData` 里写，而不是产出 PNG；
2. 加一个 `ResizeObserver` → `Terminal::resize()` 的回路；
3. 键盘/鼠标事件按 `(col, row)` 换算回字节，喂给 PTY——这部分可以直接复用
   `src-tauri/src/pty.rs` 现有的 `write_input`。

后两件都是常规工作，不涉及观感判断，可以等设计定稿后再做。
