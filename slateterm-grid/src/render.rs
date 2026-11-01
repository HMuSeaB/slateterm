//! 自绘终端网格。
//!
//! 职责单一：给定一段 PTY 输出和一个尺寸，画出完整的一帧 RGBA 位图。
//! 不涉及窗口、不涉及事件循环——这样它既能出设计稿，也能直接接到 WebView 的 canvas。

use std::collections::HashMap;

use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::cell::{Flags, LineLength};
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

/// 一次搜索命中。[`MatchSpan::start`, `MatchSpan::end`) 为列区间，`end` 不含。
///
/// `line` 是**缓冲坐标**而不是屏幕行：滚动之后命中位置不能跟着漂。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MatchSpan {
    pub line: i32,
    pub start: u32,
    pub end: u32,
}

/// 渲染叠加层。选区不在这里——它由 `alacritty_terminal` 自己维护，
/// 走 `Term::selection`，这样宽字符与折行处理直接复用库里的实现。
#[derive(Clone, Default)]
pub struct Overlay {
    pub matches: Vec<MatchSpan>,
    /// 当前聚焦的命中序号，画得更重一些
    pub active: Option<usize>,
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

    // ---- 滚动 ----

    /// 正数向上翻（看更早的内容），负数向下。库内部已做边界钳制。
    pub fn scroll_lines(&mut self, delta: i32) {
        self.term.scroll_display(Scroll::Delta(delta));
    }

    pub fn scroll_page(&mut self, up: bool) {
        self.term
            .scroll_display(if up { Scroll::PageUp } else { Scroll::PageDown });
    }

    pub fn scroll_to_bottom(&mut self) {
        self.term.scroll_display(Scroll::Bottom);
    }

    pub fn scroll_to_top(&mut self) {
        self.term.scroll_display(Scroll::Top);
    }

    /// 当前向上滚了多少行。0 表示贴底（跟随输出）。
    pub fn display_offset(&self) -> usize {
        self.term.grid().display_offset()
    }

    /// 可回看的总行数（不含当前屏）。
    pub fn history_size(&self) -> usize {
        self.term.grid().history_size()
    }

    /// 可见区对应的缓冲行号范围，闭区间且恒为升序。
    pub fn visible_lines(&self) -> (i32, i32) {
        let offset = self.display_offset() as i32;
        (-offset, self.rows() as i32 - 1 - offset)
    }

    /// 把某个缓冲行滚到可见区域中间。找不到就贴到最近的一端。
    pub fn scroll_to_line(&mut self, line: i32) {
        let (top, bottom) = self.visible_lines();
        if line < top {
            self.scroll_lines(top - line);
        } else if line > bottom {
            self.scroll_lines(bottom - line);
        }
    }

    // ---- 选区 ----

    /// 设置选区。坐标是缓冲坐标 `(行, 列)`，两端顺序无所谓。
    ///
    /// `kind` 取 `simple` / `block` / `semantic` / `lines`，与工具栏上的
    /// 双击选中词、三击选中行一一对应。
    pub fn set_selection(&mut self, kind: &str, start: (i32, i32), end: (i32, i32)) {
        let a = Point::new(Line(start.0), Column(start.1.max(0) as usize));
        let b = Point::new(Line(end.0), Column(end.1.max(0) as usize));
        let (start_pt, end_pt) = if a <= b { (a, b) } else { (b, a) };
        let ty = match kind {
            "block" => SelectionType::Block,
            "semantic" => SelectionType::Semantic,
            "lines" => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        let mut sel = Selection::new(ty, start_pt, Side::Left);
        sel.update(end_pt, Side::Right);
        self.term.selection = Some(sel);
    }

    pub fn clear_selection(&mut self) {
        self.term.selection = None;
    }

    pub fn has_selection(&self) -> bool {
        self.term.selection.is_some()
    }

    /// 选区内容。折行会被接回去，行尾空白也会去掉——
    /// 直接按格取字符会把复制出来的命令粘坏。
    pub fn selection_text(&self) -> Option<String> {
        self.term.selection_to_string()
    }

    // ---- 文本与搜索 ----

    /// 取一整行文本（缓冲坐标）。行不存在时返回空串。
    pub fn line_text(&self, line: i32) -> String {
        let grid = self.term.grid();
        if line < grid.topmost_line().0 || line > grid.bottommost_line().0 {
            return String::new();
        }
        let row = &grid[Line(line)];
        let mut out = String::new();
        for col in 0..row.line_length().0 {
            let cell = &row[Column(col)];
            // 宽字符的右半格是占位符，跳过，否则中文会被输出两遍
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            out.push(cell.c);
        }
        out
    }

    /// 在整段回滚缓冲里找 `needle`。
    ///
    /// 逐字符比对而不是按字节：大小写折叠会改变字节长度（比如 `İ`），
    /// 按字节推进会让列号错位，而列号必须准，否则高亮框会画歪。
    pub fn search(&self, needle: &str, case_sensitive: bool, limit: usize) -> Vec<MatchSpan> {
        if needle.is_empty() || limit == 0 {
            return Vec::new();
        }
        let fold = |c: char| if case_sensitive { c } else { c.to_lowercase().next().unwrap_or(c) };
        let needle_chars: Vec<char> = needle.chars().map(fold).collect();

        let mut out = Vec::new();
        let (top, bottom) = (self.term.topmost_line().0, self.term.bottommost_line().0);

        for line in top..=bottom {
            let grid_row = &self.term.grid()[Line(line)];
            // 同时收集每个字符对应的起始列，用来把字符下标换回列号
            let mut chars = Vec::with_capacity(grid_row.line_length().0);
            let mut cols = Vec::with_capacity(grid_row.line_length().0);
            for col in 0..grid_row.line_length().0 {
                let cell = &grid_row[Column(col)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                chars.push(fold(cell.c));
                cols.push(col as u32);
            }
            if chars.len() < needle_chars.len() {
                continue;
            }

            for start in 0..=(chars.len() - needle_chars.len()) {
                if chars[start..start + needle_chars.len()] != needle_chars[..] {
                    continue;
                }
                let start_col = cols[start];
                // 命中的最后一格要包含宽字符的占位格，否则高亮缺一半
                let last_col = cols[start + needle_chars.len() - 1];
                let end_col = last_col
                    + if is_wide(chars[start + needle_chars.len() - 1]) { 2 } else { 1 };
                out.push(MatchSpan { line, start: start_col, end: end_col });
                if out.len() >= limit {
                    return out;
                }
            }
        }
        out
    }

    /// 光标当前所在的缓冲行，用于"跳回底部并保持输入可见"。
    pub fn cursor_line(&self) -> i32 {
        self.term.grid().cursor.point.line.0
    }

    /// 程序是否开启了括号粘贴（`\x1b[?2004h`）。
    ///
    /// 前端据此决定粘贴时要不要包 `\x1b[200~`：不看这个的话，
    /// 在没开启的应用里粘贴会插进去一串可见的转义字符。
    pub fn bracketed_paste(&self) -> bool {
        self.term.mode().contains(TermMode::BRACKETED_PASTE)
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
    overlay: &Overlay,
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
    let selection = content.selection;
    // `display_iter` 吐的是缓冲坐标（滚动后首行是负数），
    // 加上偏移才是屏幕行。之前这里直接跳过负数行，等于回看区永远空白。
    let offset = content.display_offset as i32;
    let screen_rows = term.screen_lines() as i32;
    let selection_alpha = palette.selection.a as f32 / 255.0;

    // 搜索命中按行分组，避免每个格子都去遍历全部命中
    let mut spans: HashMap<i32, Vec<(u32, u32, bool)>> = HashMap::new();
    for (index, m) in overlay.matches.iter().enumerate() {
        let active = overlay.active == Some(index);
        spans.entry(m.line).or_default().push((m.start, m.end, active));
    }

    // 先画所有格子的背景与文字
    for indexed in content.display_iter {
        let point = indexed.point;
        let cell = indexed.cell;

        let row = point.line.0 + offset;
        if row < 0 || row >= screen_rows {
            continue;
        }
        let col = point.column.0 as u32;

        let x = pad + point.column.0 as f32 * cell_w;
        let y = pad + row as f32 * cell_h;

        let inverse = cell.flags.contains(Flags::INVERSE);
        let mut fg = palette.resolve(cell.fg, true).unwrap_or(palette.foreground);
        let mut bg = palette.resolve(cell.bg, false).unwrap_or(palette.background);
        if inverse {
            std::mem::swap(&mut fg, &mut bg);
        }
        if cell.flags.contains(Flags::DIM) {
            fg = fg.mix(bg, 0.45);
        }

        // 选中优先于搜索命中：选中的那段是用户要复制的，不能看不清
        if selection.is_some_and(|range| range.contains(point)) {
            bg = bg.mix(palette.selection, selection_alpha);
        } else if let Some(list) = spans.get(&point.line.0) {
            let mut hit: Option<bool> = None;
            for &(start, end, active) in list {
                if col >= start && col < end {
                    // 聚焦的那一条要盖过普通命中，所以单独抬优先级
                    hit = Some(active || hit == Some(true));
                    if hit == Some(true) {
                        break;
                    }
                }
            }
            if let Some(active) = hit {
                bg = bg.mix(palette.cursor, if active { 0.55 } else { 0.28 });
            }
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
            let thickness = 1;
            let gap = if cell.flags.contains(Flags::DOUBLE_UNDERLINE) { 2 } else { 0 };
            let w = (cell_w * if is_wide(cell.c) { 2.0 } else { 1.0 }).ceil() as i32;
            fill_rect(&mut buf, width, height, x.round() as i32, uy, w, thickness, fg);
            if gap > 0 {
                fill_rect(&mut buf, width, height, x.round() as i32, uy - gap, w, thickness, fg);
            }
        }
    }

    // 光标只在前台画出，且避开隐藏模式。
    // 滚动回看时光标会随内容一起往下移，移出屏幕就自然不画了——这正是终端该有的行为。
    {
        let _ = cursor_shape;
        let row = cursor_point.line.0 + offset;
        if row >= 0 && row < screen_rows && term.mode().contains(TermMode::SHOW_CURSOR) {
            let x = pad + cursor_point.column.0 as f32 * cell_w;
            let y = pad + row as f32 * cell_h;
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

    // 回看位置指示。只在真的滚上去了才画：
    // 贴底时也留一条会一直占着右边缘，反而干扰阅读。
    if offset > 0 {
        let history = term.grid().history_size();
        let total = history + screen_rows as usize;
        if history > 0 && total > screen_rows as usize {
            let track_top = pad;
            let track_h = screen_rows as f32 * cell_h;
            let thumb_h = ((screen_rows as f32 / total as f32) * track_h).max(24.0);
            let ratio = 1.0 - (offset as f32 / history as f32).clamp(0.0, 1.0);
            let thumb_y = track_top + ratio * (track_h - thumb_h).max(0.0);
            fill_rect(
                &mut buf,
                width,
                height,
                (width as f32 - 6.0).round() as i32,
                thumb_y.round() as i32,
                3,
                thumb_h.round() as i32,
                palette.foreground.with_alpha(0x55),
            );
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
