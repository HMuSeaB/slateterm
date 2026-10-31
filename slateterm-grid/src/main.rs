//! 生成设计稿：把一段典型的 PowerShell 会话画成 PNG。
//!
//! 用法：
//!   cargo run -- out/dark.png [dark|light]

use std::path::PathBuf;

use slateterm_grid::font::FontPair;
use slateterm_grid::palette::Palette;
use slateterm_grid::render::{Look, Terminal, frame_size, render};

const WINDOWS_FONTS: &str = r"C:\Windows\Fonts";

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let out = args.get(1).cloned().unwrap_or_else(|| "out/term.png".into());
    let mode = args.get(2).cloned().unwrap_or_else(|| "dark".into());

    let palette = if mode == "light" { Palette::paper_light() } else { Palette::amber_dark() };

    let look = Look { font_size: 13.0, line_height_ratio: 1.45, padding: 16, ..Look::default() };
    let mut fonts = FontPair::load(
        &PathBuf::from(WINDOWS_FONTS).join("CascadiaMono.ttf"),
        &PathBuf::from(WINDOWS_FONTS).join("msyh.ttc"),
        look.font_size,
        look.line_height_ratio,
    )?;

    let cols = 92;
    let rows = 38;
    let mut term = Terminal::new(cols, rows);
    term.feed(sample_session(&palette).as_bytes());
    let _ = &mut fonts;

    let (w, h) = frame_size(term.cols(), term.rows(), &fonts, &look);
    let frame = render(term.inner(), &palette, &mut fonts, &look, w, h);

    let path = PathBuf::from(&out);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    frame.save_png(&path)?;
    println!("已生成 {out}  ({w}×{h})");
    Ok(())
}

/// 一段有代表性的会话：提示符、彩色输出、中文、Git 状态、进度条。
/// 内容刻意覆盖常见的 ANSI 场景，用来检查配色是否成体系。
fn sample_session(p: &Palette) -> String {
    let fg = hex(p.foreground);
    let dim = hex(p.ansi[8]);
    let accent = hex(p.cursor);
    let ok = hex(p.ansi[2]);
    let warn = hex(p.ansi[3]);
    let err = hex(p.ansi[1]);
    let info = hex(p.ansi[4]);
    let mag = hex(p.ansi[5]);
    let _ = accent;

    format!(
        "{fg}PS {info}D:\\4rchive\\Code\\SlateTerm{fg}> {dim}git status{fg}\r\n\
         {dim}On branch gpui-rewrite{fg}\r\n\
         Your branch is up to date with '{info}origin/gpui-rewrite{fg}'.\r\n\
         \r\n\
         Changes not staged for commit:\r\n\
         {err}  modified:   src/components/TerminalPane.tsx{fg}\r\n\
         {err}  modified:   src/styles/styles.css{fg}\r\n\
         \r\n\
         Untracked files:\r\n\
         {err}  slateterm-grid/{fg}\r\n\
         \r\n\
         {fg}PS {info}D:\\4rchive\\Code\\SlateTerm{fg}> {dim}cargo run --release{fg}\r\n\
         {ok}   Compiling{fg} slateterm-grid v0.1.0\r\n\
         {ok}    Finished{fg} release [optimized] in 3.42s\r\n\
         \r\n\
         {fg}PS {info}D:\\4rchive\\Code\\SlateTerm{fg}> {dim}Get-ChildItem{fg}\r\n\
         \r\n\
         {dim}    Directory: D:\\4rchive\\Code\\SlateTerm{fg}\r\n\
         \r\n\
         {dim}Mode   LastWriteTime      Length Name{fg}\r\n\
         {dim}----   -------------      ------ ----{fg}\r\n\
         d----  2026/10/31  15:20            {info}src{fg}\r\n\
         d----  2026/10/31  15:20            {info}src-tauri{fg}\r\n\
         -a---  2026/10/31  15:18     3721   README.md\r\n\
         -a---  2026/10/31  15:22    10545   CHANGELOG.md\r\n\
         \r\n\
         {warn}警告:{fg} 终端渲染层正在迁移，xterm.js 仍是默认路径。\r\n\
         {err}错误:{fg} 未找到配置文件 settings.json（已使用默认值）。\r\n\
         {mag}[1/3]{fg} 解析 VT 序列 ............... {ok}完成{fg}\r\n\
         {mag}[2/3]{fg} 栅格化字形 ................. {ok}完成{fg}\r\n\
         {mag}[3/3]{fg} 合成帧 ..................... {warn}进行中{fg}\r\n\
         \r\n\
         {fg}中文混排测试：终端、选择、粘连、界面，一行里 abc 与汉字同宽。{fg}\r\n\
         {dim}ABC abc 123 - 「引号」 括号（）与方框 □ OK - x{fg}\r\n\
         \r\n\
         {fg}PS {info}D:\\4rchive\\Code\\SlateTerm{fg}> "
    )
}

fn hex(c: slateterm_grid::Rgba8) -> String {
    format!("\x1b[38;2;{};{};{}m", c.r, c.g, c.b)
}
