//! 把全部主题样张拼成一张总览图。
//!
//! 单张样张适合细看，但比较十几个主题时来回翻太累。
//! 这里按行排列，每格左上角标主题名，一眼能看出整体调性。

use std::path::{Path, PathBuf};

use slateterm_grid::font::FontPair;
use slateterm_grid::palette::Rgba8;
use slateterm_grid::render::{Look, is_wide};
use slateterm_grid::theme;

const FONTS: &str = r"C:\Windows\Fonts";

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let themes_dir = args.get(1).cloned().unwrap_or_else(|| "themes".into());
    let shots_dir = args.get(2).cloned().unwrap_or_else(|| "out/themes".into());
    let out = args.get(3).cloned().unwrap_or_else(|| "out/overview.png".into());
    let per_row: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(4);

    let themes = theme::load_dir(Path::new(&themes_dir))?;
    let look = Look { font_size: 15.0, line_height_ratio: 1.4, padding: 0, ..Look::default() };
    let mut fonts = FontPair::load(
        &PathBuf::from(FONTS).join("CascadiaMono.ttf"),
        &PathBuf::from(FONTS).join("msyh.ttc"),
        look.font_size,
        look.line_height_ratio,
    )?;

    // 先读全部样张，按最大尺寸决定格子大小
    let mut loaded = Vec::new();
    for t in &themes {
        let p = PathBuf::from(&shots_dir).join(format!("{}.png", t.id));
        let img = image::open(&p).map_err(|e| format!("读图失败 {}: {e}", p.display()))?;
        loaded.push((t, img.to_rgba8()));
    }
    let cw = loaded.iter().map(|(_, i)| i.width()).max().unwrap_or(600) as usize;
    let chh = loaded.iter().map(|(_, i)| i.height()).max().unwrap_or(400) as usize;

    let label_h = 26usize;
    let pad = 14usize;
    let cols = per_row;
    let rows = loaded.len().div_ceil(cols);
    let cell_w = cw + pad * 2;
    let cell_h = chh + label_h + pad * 2;
    let w = cell_w * cols;
    let h = cell_h * rows;

    let mut buf = vec![0u8; w * h * 4];
    for px in buf.chunks_exact_mut(4) {
        px[0] = 0x12;
        px[1] = 0x0f;
        px[2] = 0x0c;
        px[3] = 255;
    }

    for (i, (t, img)) in loaded.iter().enumerate() {
        let cx = (i % cols) * cell_w + pad;
        let cy = (i / cols) * cell_h + pad;

        // 主题名：用该主题自己的前景色，便于感受调性
        let label = format!("{}  ·  {}", t.name, if t.light { "light" } else { "dark" });
        draw_text(&mut buf, w, h, cx as i32, (cy + 4) as i32, &label, &mut fonts, t.palette.foreground);

        // 样张本体
        let top = cy + label_h;
        for sy in 0..img.height() as usize {
            for sx in 0..img.width() as usize {
                let p = img.get_pixel(sx as u32, sy as u32);
                let di = ((top + sy) * w + cx + sx) * 4;
                buf[di] = p[0];
                buf[di + 1] = p[1];
                buf[di + 2] = p[2];
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
    println!("已生成 {out} ({w}×{h})，{rows} 行 × {cols} 列");
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
    for ch in text.chars() {
        let wide = is_wide(ch);
        let glyph = fonts.glyph(ch);
        slateterm_grid::font::blit_glyph(buf, bw, bh, pen, y, glyph, color);
        pen += if wide { fonts.advance.ceil() as i32 * 2 } else { fonts.advance.ceil() as i32 };
    }
}
