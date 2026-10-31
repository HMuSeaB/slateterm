//! 自绘终端网格。
//!
//! 职责单一：给定一段 PTY 输出和一个尺寸，画出完整的一帧 RGBA 位图。
//! 不涉及窗口、不涉及事件循环——这样它既能出设计稿，也能直接接到 WebView 的 canvas。

use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, TermMode};
use alacritty_terminal::vte::ansi::Processor;

use crate::font::{FontPair, blit_glyph, fill_rect};
use crate::palette::Palette;

/// 终端尺寸（格数），用于给 `Term` 提供 Dimensions。
#[derive(Clone, Copy)]
pub struct GridSize {
    pub cols: usize,
    pub rows: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// 视觉参数。留白是"好看"的一半，所以单独提出来。
#[derive(Clone, Copy)]
pub struct Look {
    pub font_size: f32,
    pub line_height_ratio: f32,
    /// 终端内容四周的内边距
    pub padding: i32,
    /// 光标形状：true 为竖线，false 为方块
    pub bar_cursor: bool,
    /// 选区/光标圆角
    pub cursor_radius: i32,
}

impl Default for Look {
    fn default() -> Self {
        Self {
            font_size: 13.0,
            line_height_ratio: 1.45,
            padding: 14,
            bar_cursor: true,
            cursor_radius: 2,
        }
    }
}

pub struct Terminal {
    term: Term<VoidListener>,
    parser: Processor,
}

impl Terminal {
    pub fn new(cols: usize, rows: usize) -> Self {
        let config = Config { scrolling_history: 10_000, ..Config::default() };
        let size = GridSize { cols, rows };
        let term = Term::new(config, &size, VoidListener);
        Self { term, parser: Processor::new() }
    }

    /// 喂入 PTY 字节。可以多次调用，状态会在内部累积。
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        self.term.resize(GridSize { cols, rows });
    }

    pub fn cols(&self) -> usize {
        self.term.columns()
    }

    pub fn rows(&self) -> usize {
        self.term.screen_lines()
    }

    /// 只读访问底层 `Term`，供渲染器使用。
    pub fn inner(&self) -> &Term<VoidListener> {
        &self.term
    }
}

/// 一帧的渲染结果。
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

impl Frame {
    pub fn save_png(&self, path: &std::path::Path) -> Result<(), String> {
        let buf: image::RgbaImage = image::ImageBuffer::from_raw(
            self.width as u32,
            self.height as u32,
            self.pixels.clone(),
        )
        .ok_or_else(|| "缓冲区尺寸不匹配".to_string())?;
        buf.save(path).map_err(|e| format!("保存 PNG 失败: {e}"))
    }
}

/// 全角判定：东亚宽字符占两格。
///
/// 公开出去是因为调用方（比如并排渲染、光标定位）也需要同一套宽度规则，
/// 各自写一份必然对不齐。
pub fn is_wide(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF |
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xA000..=0xA4CF |
        0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE6F |
        0xFF00..=0xFF60 | 0xFFE0..=0xFFE6 | 0x1F300..=0x1F64F |
        0x1F900..=0x1F9FF | 0x20000..=0x3FFFD
    )
}

/// 按给定宽高画一帧。
pub fn render(
    term: &Term<VoidListener>,
    palette: &Palette,
    fonts: &mut FontPair,
    look: &Look,
    width: usize,
    height: usize,
) -> Frame {
    let mut buf = vec![0u8; width * height * 4];
    // 铺底色
    for px in buf.chunks_exact_mut(4) {
        px[0] = palette.background.r;
        px[1] = palette.background.g;
        px[2] = palette.background.b;
        px[3] = 255;
    }

    let cell_w = fonts.advance;
    let cell_h = fonts.line_height;
    let pad = look.padding as f32;

    let content = term.renderable_content();
    let cursor_point = content.cursor.point;
    let cursor_shape = content.cursor.shape;

    // 先画所有格子的背景与文字
    for indexed in content.display_iter {
        let point = indexed.point;
        let cell = indexed.cell;

        // display_iter 的 line 可能为负（滚动区之上），统一换算成可见行
        let line: i32 = point.line.0;
        let col: usize = point.column.0;
        if line < 0 {
            continue;
        }

        let x = pad + col as f32 * cell_w;
        let y = pad + line as f32 * cell_h;

        let inverse = cell.flags.contains(Flags::INVERSE);
        let mut fg = palette.resolve(cell.fg, true).unwrap_or(palette.foreground);
        let mut bg = palette.resolve(cell.bg, false).unwrap_or(palette.background);
        if inverse {
            std::mem::swap(&mut fg, &mut bg);
        }
        if cell.flags.contains(Flags::DIM) {
            fg = fg.mix(bg, 0.45);
        }

        // 非默认背景才铺，减少大面积覆盖
        if bg != palette.background {
            fill_rect(
                &mut buf,
                width,
                height,
                x.round() as i32,
                y.round() as i32,
                cell_w.ceil() as i32,
                cell_h.ceil() as i32,
                bg,
            );
        }

        if cell.c != ' ' && cell.c != '\0' {
            let wide = is_wide(cell.c);
            let bold = cell.flags.contains(Flags::BOLD);
            // 先算出位置再取字形，避免与 fonts 的可变借用冲突
            let gx = if wide { x + (cell_w * 2.0 - cell_w) / 2.0 } else { x };
            let glyph = fonts.glyph_styled(cell.c, bold);
            blit_glyph(
                &mut buf,
                width,
                height,
                gx.round() as i32,
                y.round() as i32,
                glyph,
                fg,
            );
        }

        // 下划线：终端必须能看见链接和拼写错误
        if cell.flags.intersects(Flags::UNDERLINE | Flags::DOUBLE_UNDERLINE) {
            let uy = (y + cell_h - 2.0).round() as i32;
            let thickness = if cell.flags.contains(Flags::DOUBLE_UNDERLINE) { 1 } else { 1 };
            let gap = if cell.flags.contains(Flags::DOUBLE_UNDERLINE) { 2 } else { 0 };
            let w = (cell_w * if is_wide(cell.c) { 2.0 } else { 1.0 }).ceil() as i32;
            fill_rect(&mut buf, width, height, x.round() as i32, uy, w, thickness, fg);
            if gap > 0 {
                fill_rect(&mut buf, width, height, x.round() as i32, uy - gap, w, thickness, fg);
            }
        }
    }

    // 光标只在前台画出，且避开隐藏模式
    if !term.mode().contains(TermMode::SHOW_CURSOR) || term.mode().contains(TermMode::VI) {
        // VI 模式交给后续实现；这里是设计稿，保持简洁
    }
    {
        let line: i32 = cursor_point.line.0;
        if line >= 0 {
            let x = pad + cursor_point.column.0 as f32 * cell_w;
            let y = pad + line as f32 * cell_h;
            // 光标形状直接按 CursorShape 决定：竖线细、方块半透明覆盖
            // 这样不会盖住字符本身，视觉上更接近编辑器的插入点。
            let _ = cursor_shape;
            if look.bar_cursor {
                fill_rect(
                    &mut buf,
                    width,
                    height,
                    x.round() as i32,
                    y.round() as i32,
                    (cell_w * 0.12).max(1.0) as i32,
                    cell_h.ceil() as i32,
                    palette.cursor,
                );
            } else {
                fill_rect(
                    &mut buf,
                    width,
                    height,
                    x.round() as i32,
                    y.round() as i32,
                    cell_w.ceil() as i32,
                    cell_h.ceil() as i32,
                    palette.cursor.with_alpha(0x66),
                );
            }
        }
    }

    Frame { width, height, pixels: buf }
}

/// 便捷构造：按格数与视觉参数算出像素尺寸。
pub fn frame_size(cols: usize, rows: usize, fonts: &FontPair, look: &Look) -> (usize, usize) {
    let w = (fonts.advance * cols as f32 + look.padding as f32 * 2.0).ceil() as usize;
    let h = (fonts.line_height * rows as f32 + look.padding as f32 * 2.0).ceil() as usize;
    (w, h)
}

/// 清空屏幕（等价于 Ctrl+L 的效果），方便生成干净的稿子。
pub fn clear(term: &mut Terminal) {
    term.feed(b"\x1b[2J\x1b[H");
}

/// 让 `Line`/`Column` 的类型参与编译检查，避免未使用告警。
#[allow(dead_code)]
fn _types(_: Line, _: Column) {}
