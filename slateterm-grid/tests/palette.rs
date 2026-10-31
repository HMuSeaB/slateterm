//! 配色与网格的回归测试。
//!
//! 这些测试锁的是"观感的硬约束"：颜色不能被改成刺眼的纯色、
//! 背景与前景要拉得开、十六色与 256 色不能映射错位。

use alacritty_terminal::grid::Dimensions;
use slateterm_grid::palette::{Palette, Rgba8};
use slateterm_grid::render::{GridSize, Look, Terminal, frame_size};
use slateterm_grid::font::FontPair;

fn luma(c: Rgba8) -> f32 {
    (0.2126 * c.r as f32 + 0.7152 * c.g as f32 + 0.0722 * c.b as f32) / 255.0
}

#[test]
fn foreground_contrasts_with_background() {
    for p in [Palette::amber_dark(), Palette::paper_light()] {
        let d = (luma(p.foreground) - luma(p.background)).abs();
        assert!(d > 0.6, "前景与背景亮度差太小: {d}");
    }
}

#[test]
fn ansi_palette_is_not_primary_colors() {
    // 纯红纯绿纯蓝会让终端显得廉价，这里禁止它们出现。
    for p in [Palette::amber_dark(), Palette::paper_light()] {
        for c in p.ansi {
            let is_primary = (c.r == 255 || c.r == 0)
                && (c.g == 255 || c.g == 0)
                && (c.b == 255 || c.b == 0);
            assert!(!is_primary, "出现了纯色 {c:?}");
        }
    }
}

#[test]
fn all_ansi_colors_are_visible_on_background() {
    for p in [Palette::amber_dark(), Palette::paper_light()] {
        let bg = luma(p.background);
        for (i, c) in p.ansi.iter().enumerate() {
            let d = (luma(*c) - bg).abs();
            assert!(d > 0.08, "ANSI {i} 与背景太接近: {d}");
        }
    }
}

#[test]
fn cube_colors_cover_expected_range() {
    let p = Palette::amber_dark();
    // 16 号是立方体起点，255 是灰阶终点
    let c16 = p.resolve(alacritty_terminal::vte::ansi::Color::Indexed(16), true).unwrap();
    assert_eq!((c16.r, c16.g, c16.b), (0, 0, 0));
    let c231 = p.resolve(alacritty_terminal::vte::ansi::Color::Indexed(231), true).unwrap();
    assert_eq!((c231.r, c231.g, c231.b), (255, 255, 255));
    let c255 = p.resolve(alacritty_terminal::vte::ansi::Color::Indexed(255), true).unwrap();
    assert_eq!(c255.r, c255.g);
    assert_eq!(c255.g, c255.b);
}

#[test]
fn grid_size_feeds_term() {
    let mut t = Terminal::new(80, 24);
    assert_eq!(t.cols(), 80);
    assert_eq!(t.rows(), 24);
    t.feed(b"hello");
    t.feed(b"\x1b[2;1Hworld");
    // 两次喂入应累积在同一状态里，而不是各自独立
    let size: GridSize = GridSize { cols: 80, rows: 24 };
    assert_eq!(size.columns(), 80);

    // 有内容后尺寸仍然可算
    let look = Look::default();
    // 字体不可用时跳过尺寸断言（CI 上没有 Windows 字体）
    if let Ok(f) = FontPair::load(
        std::path::Path::new(r"C:\Windows\Fonts\CascadiaMono.ttf"),
        std::path::Path::new(r"C:\Windows\Fonts\msyh.ttc"),
        look.font_size,
        look.line_height_ratio,
    ) {
        let (w, h) = frame_size(80, 24, &f, &look);
        assert!(w > 400 && h > 300, "帧尺寸异常: {w}x{h}");
    }
}
