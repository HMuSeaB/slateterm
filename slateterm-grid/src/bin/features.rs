//! 三项交互功能的可视化验证：滚动回看、选中高亮、搜索命中。
//!
//! 刻意不用真实 PTY：内容固定，出图才能逐像素比对。
//! 真实 PTY 的验证在 `shell.rs` / `live.rs` 里做，两者分工不同。

use std::path::PathBuf;

use slateterm_grid::font::FontPair;
use slateterm_grid::render::{Look, MatchSpan, Overlay, Terminal, frame_size, render};
use slateterm_grid::theme;

const FONTS: &str = r"C:\Windows\Fonts";

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let out = args.get(1).cloned().unwrap_or_else(|| "out/features.png".into());

    let cols = 96usize;
    let rows = 22usize;
    let mut term = Terminal::new(cols, rows);

    // 构造一段像真实构建日志的内容，塞满到需要回滚
    let mut script = String::new();
    script.push_str("\x1b[38;5;109m❯\x1b[0m cargo build --release\r\n");
    script.push_str("\x1b[38;5;246m   Compiling\x1b[0m slateterm v1.2.0 (D:\\4rchive\\Code\\SlateTerm)\r\n");
    for i in 0..30 {
        let (tag, color) = match i % 7 {
            0 => ("warning", "33"),
            3 => ("error", "31"),
            _ => ("note", "36"),
        };
        script.push_str(&format!(
            "\x1b[1;{color}m{tag}\x1b[0m: unused variable `chunk_{i}` in function `render_frame`\r\n"
        ));
        script.push_str(&format!(
            "  \x1b[38;5;244m-->\x1b[0m src/lib/gridTerminal.ts:{}\r\n",
            120 + i * 7
        ));
        script.push_str("   \x1b[38;5;244m|\x1b[0m\r\n");
        script.push_str("   \x1b[38;5;244m|\x1b[0m \x1b[38;5;252mlet _ = chunk;\x1b[0m\r\n");
        script.push_str("   \x1b[38;5;244m|\x1b[0m     \x1b[1;32m^^^^^\x1b[0m \x1b[1;32mhelp: 加下划线前缀\x1b[0m\r\n");
        script.push_str("   \x1b[38;5;244m|\x1b[0m\r\n");
    }
    script.push_str("\x1b[1;32m    Finished\x1b[0m release [optimized] target(s) in 42.18s\r\n");
    script.push_str("\x1b[38;5;109m❯\x1b[0m ");
    term.feed(script.as_bytes());

    // 往上翻 8 行：这样既能看见回滚区内容，也能看见右侧的位置指示条
    term.scroll_lines(8);

    // 在一段警告正文上做选区，跨两行，验证折行/多行拼接
    let (top, _) = term.visible_lines();
    let sel_a = (top + 3, 3);
    let sel_b = (top + 4, 60);
    term.set_selection("simple", sel_a, sel_b);

    // 搜索 "warning"，命中的整段高亮，第一条更重
    let mut matches: Vec<MatchSpan> = term.search("warning", false, 200);
    // 把选区所在的两行从命中里剔除，避免两种高亮叠在同一处看不清
    matches.retain(|m| m.line != sel_a.0 && m.line != sel_b.0);

    let overlay = Overlay { matches, active: Some(0) };

    let look = Look { font_size: 13.0, line_height_ratio: 1.5, padding: 16, ..Look::default() };
    let mut fonts = FontPair::load(
        &PathBuf::from(FONTS).join("CascadiaMono.ttf"),
        &PathBuf::from(FONTS).join("msyh.ttc"),
        look.font_size,
        look.line_height_ratio,
    )?;

    let palette = theme::builtin_by_id("ely-dark").ok_or("缺少 ely-dark 主题")?.palette;
    let (w, h) = frame_size(term.cols(), term.rows(), &fonts, &look);
    let frame = render(term.inner(), &palette, &mut fonts, &look, w, h, &overlay);

    let path = PathBuf::from(&out);
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("建目录失败: {e}"))?;
    }
    frame.save_png(&path)?;

    let text = term.selection_text().unwrap_or_default();
    println!("已生成 {out}  ({w}×{h})");
    println!(
        "滚动偏移 {} / 历史 {} 行｜可见缓冲行 {:?}｜命中 {} 条",
        term.display_offset(),
        term.history_size(),
        term.visible_lines(),
        overlay.matches.len()
    );
    println!("选区文本（{} 字）：", text.chars().count());
    for line in text.lines() {
        println!("  |{line}|");
    }
    Ok(())
}
