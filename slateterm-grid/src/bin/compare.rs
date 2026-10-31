//! 同一段内容 × 多套主题并排对比。
//!
//! 和 `overview` 的区别：那边每格是完整色卡，这边每格只有一段真实会话，
//! 而且内容完全一致。比较主题时，变量越少越容易判断。

use std::path::{Path, PathBuf};

use slateterm_grid::font::FontPair;
use slateterm_grid::palette::Rgba8;
use slateterm_grid::render::{Look, Terminal, frame_size, is_wide, render};
use slateterm_grid::Theme;
use slateterm_grid::theme;

const FONTS: &str = r"C:\Windows\Fonts";

/// 一段短会话：提示符、Git、编译警告、中文。够判断调性又不啰嗦。
fn script(p: &slateterm_grid::Palette) -> String {
    let fg = hex(p.foreground);
    let dim = hex(p.ansi[8]);
    let red = hex(p.ansi[1]);
    let green = hex(p.ansi[2]);
    let yellow = hex(p.ansi[3]);
    let blue = hex(p.ansi[4]);
    let mag = hex(p.ansi[5]);
    format!(
        "{fg}PS {blue}D:\\Code\\SlateTerm{fg}> {dim}git status{fg}\r\n\
         {red}  modified:   TerminalPane.tsx{fg}\r\n\
         {green}  new file:   theme.rs{fg}\r\n\
         {fg}PS {blue}D:\\Code\\SlateTerm{fg}> {dim}cargo build{fg}\r\n\
         {yellow}warning:{fg} unused import\r\n\
         {green}    Finished{fg} in 3.42s\r\n\
         {fg}PS {blue}D:\\Code\\SlateTerm{fg}> {dim}ls{fg}\r\n\
         {blue}src{fg}  {blue}src-tauri{fg}  README.md\r\n\
         {mag}[2/3]{fg} 中文渲染测试：终端、选择、粘连\r\n\
         {dim}ABC abc 123 - 「引号」 括号（）\r\n\
         {fg}PS {blue}D:\\Code\\SlateTerm{fg}> "
    )
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let themes_dir = args.get(1).cloned().unwrap_or_else(|| "themes".into());
    let out = args.get(2).cloned().unwrap_or_else(|| "out/compare.png".into());
    // 由调用方指定要比较哪几套，逗号分隔
    let picked: Vec<String> = args
        .get(3)
        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
        .unwrap_or_default();

    let all = theme::load_dir(Path::new(&themes_dir))?;
    let themes: Vec<&Theme> = if picked.is_empty() {
        all.iter().collect()
    } else {
        picked
            .iter()
            .filter_map(|id| all.iter().find(|t| &t.id == id))
            .collect()
    };
    if themes.is_empty() {
        return Err("没有匹配的主题".into());
    }

    let look = Look { font_size: 14.0, line_height_ratio: 1.5, padding: 14, ..Look::default() };
    let mut fonts = FontPair::load(
        &PathBuf::from(FONTS).join("CascadiaMono.ttf"),
        &PathBuf::from(FONTS).join("msyh.ttc"),
        look.font_size,
        look.line_height_ratio,
    )?;

    let cols = 62;
    let rows = 12;

    // 逐套渲染
    let mut panels = Vec::new();
    for t in &themes {
        let mut term = Terminal::new(cols, rows);
        term.feed(script(&t.palette).as_bytes());
        let (w, h) = frame_size(term.cols(), term.rows(), &fonts, &look);
        let frame = render(term.inner(), &t.palette, &mut fonts, &look, w, h);

        // 标题条：用该主题自己的背景色 + 前景色
        let mut panel = Vec::with_capacity((w * (h + 24)) * 4);
        let label = format!("{} {}", t.name, if t.light { "· light" } else { "· dark" });
        let mut header = vec![0u8; w * 24 * 4];
        for px in header.chunks_exact_mut(4) {
            px[0] = t.palette.background.r;
            px[1] = t.palette.background.g;
            px[2] = t.palette.background.b;
            px[3] = 255;
        }
        draw_text(&mut header, w, 24, 8, 4, &label, &mut fonts, t.palette.foreground);
        panel.extend_from_slice(&header);
        panel.extend_from_slice(&frame.pixels);
        panels.push((w, h + 24, panel));
    }

    // 拼成一行（最多 3 列，多了换行）
    let per_row = 3usize;
    let pw = panels.iter().map(|p| p.0).max().unwrap_or(1);
    let ph = panels.iter().map(|p| p.1).max().unwrap_or(1);
    let gap = 16usize;
    let prow = panels.len().div_ceil(per_row);
    let w = per_row * pw + (per_row + 1) * gap;
    let h = prow * ph + (prow + 1) * gap;

    let mut buf = vec![0u8; w * h * 4];
    for px in buf.chunks_exact_mut(4) {
        px[0] = 0x0b;
        px[1] = 0x0a;
        px[2] = 0x09;
        px[3] = 255;
    }
    for (i, (pwid, phei, data)) in panels.iter().enumerate() {
        let ox = gap + (i % per_row) * (pw + gap);
        let oy = gap + (i / per_row) * (ph + gap);
        for y in 0..*phei {
            for x in 0..*pwid {
                let si = (y * pwid + x) * 4;
                let di = ((oy + y) * w + ox + x) * 4;
                buf[di] = data[si];
                buf[di + 1] = data[si + 1];
                buf[di + 2] = data[si + 2];
                buf[di + 3] = 255;
            }
        }
    }

    let path = PathBuf::from(&out);
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let img: image::RgbaImage =
        image::ImageBuffer::from_raw(w as u32, h as u32, buf).ok_or("缓冲区不匹配")?;
    img.save(&path).map_err(|e| format!("保存失败: {e}"))?;
    println!("已生成 {out} ({w}×{h})，{} 套主题", panels.len());
    Ok(())
}

fn draw_text(
    buf: &mut [u8],
    bw: usize,
    bh: usize,
    x: i32,
    y: i32,
    text: &str,
    fonts: &mut FontPair,
    color: Rgba8,
) {
    let mut pen = x;
    let adv = fonts.advance.ceil() as i32;
    for ch in text.chars() {
        let wide = is_wide(ch);
        if ch != ' ' {
            let glyph = fonts.glyph(ch);
            slateterm_grid::font::blit_glyph(buf, bw, bh, pen, y, glyph, color);
        }
        pen += if wide { adv * 2 } else { adv };
    }
}

fn hex(c: Rgba8) -> String {
    format!("\x1b[38;2;{};{};{}m", c.r, c.g, c.b)
}
