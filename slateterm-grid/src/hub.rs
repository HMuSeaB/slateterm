//! 会话级网格管理器。
//!
//! 放在这个 crate 而不是 Tauri 层，是为了让核心逻辑能被编译和测试验证：
//! Tauri 命令只是对这里的薄封装，出错面收窄到 serde 序列化那一层。
//!
//! 与 PTY 的关系：不碰进程和字节流，只把同一批字节再解析一份。
//! 因此 xterm.js 与自绘网格可以同时在场，切换渲染器不影响会话本身。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::font::FontPair;
use crate::render::{Look, MatchSpan, Overlay, Terminal, frame_size, render};
use crate::theme;

/// 一帧的原始数据（尚未编码）。
pub struct GridFrame {
    pub width: u32,
    pub height: u32,
    /// RGBA8，长度 = width * height * 4
    pub pixels: Vec<u8>,
    pub cols: usize,
    pub rows: usize,
    /// 单元格尺寸，前端据此把鼠标坐标换算成格子
    pub cell_width: f32,
    pub cell_height: f32,
    pub padding: f32,
    /// 已在回滚区滚了多少行，0 表示贴底
    pub display_offset: usize,
    pub history_size: usize,
    /// 程序是否开启了括号粘贴，前端据此决定粘贴要不要包 `\x1b[200~`
    pub bracketed_paste: bool,
}

/// 滚动状态。前端据此画滚动条。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScrollInfo {
    pub offset: usize,
    pub history: usize,
    pub rows: usize,
}

/// 搜索结果。前端只需要数量与当前聚焦的序号。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchInfo {
    pub count: usize,
    pub active: Option<usize>,
}

pub struct HubOptions {
    pub mono_font: PathBuf,
    pub fallback_font: PathBuf,
    /// 初始主题 id，缺省 ely-dark
    pub theme_id: Option<String>,
    pub look: Look,
}

impl Default for HubOptions {
    fn default() -> Self {
        let win_fonts = PathBuf::from(r"C:\Windows\Fonts");
        Self {
            mono_font: win_fonts.join("CascadiaMono.ttf"),
            fallback_font: win_fonts.join("msyh.ttc"),
            theme_id: None,
            look: Look::default(),
        }
    }
}

/// 字体与主题是全局共享的：换主题不该让每个会话重建字体。
pub struct GridHub {
    inner: Mutex<Inner>,
    fonts_path: FontPaths,
}

struct FontPaths {
    mono: PathBuf,
    fallback: PathBuf,
}

/// 单个会话的网格状态。
///
/// 搜索命中放在这里而不是全局：两个标签页各自搜各自的词，
/// 切换标签时高亮不会串。
struct Session {
    term: Terminal,
    matches: Vec<MatchSpan>,
    active: Option<usize>,
}

struct Inner {
    sessions: HashMap<String, Session>,
    fonts: Option<FontPair>,
    theme: Option<theme::Theme>,
    look: Look,
}

impl Default for GridHub {
    fn default() -> Self {
        Self::new()
    }
}

impl GridHub {
    pub fn new() -> Self {
        Self::with_options(HubOptions::default())
    }

    pub fn with_options(options: HubOptions) -> Self {
        let theme = options
            .theme_id
            .as_deref()
            .and_then(theme::builtin_by_id)
            .or_else(|| theme::builtin_by_id("ely-dark"));
        Self {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                fonts: None,
                theme,
                look: options.look,
            }),
            fonts_path: FontPaths {
                mono: options.mono_font,
                fallback: options.fallback_font,
            },
        }
    }

    pub fn create(&self, session_id: &str, cols: usize, rows: usize) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "锁被污染".to_string())?;
        inner.sessions.insert(session_id.to_string(), new_session(cols, rows));
        Ok(())
    }

    /// 会话已存在则复用，不重建——前端可能因为重渲染重复调用 create。
    pub fn ensure(&self, session_id: &str, cols: usize, rows: usize) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "锁被污染".to_string())?;
        if let Some(s) = inner.sessions.get_mut(session_id) {
            s.term.resize(cols, rows);
            return Ok(());
        }
        inner.sessions.insert(session_id.to_string(), new_session(cols, rows));
        Ok(())
    }

    pub fn feed(&self, session_id: &str, bytes: &[u8]) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(s) = inner.sessions.get_mut(session_id)
        {
            s.term.feed(bytes);
            // 新输出进来，旧的命中位置已经失效，直接清掉比留着错位高亮好
            if !s.matches.is_empty() {
                s.matches.clear();
                s.active = None;
            }
        }
    }

    pub fn resize(&self, session_id: &str, cols: usize, rows: usize) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(s) = inner.sessions.get_mut(session_id)
        {
            s.term.resize(cols, rows);
            s.matches.clear();
            s.active = None;
        }
    }

    pub fn close(&self, session_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.sessions.remove(session_id);
        }
    }

    pub fn has(&self, session_id: &str) -> bool {
        self.inner
            .lock()
            .map(|i| i.sessions.contains_key(session_id))
            .unwrap_or(false)
    }

    /// 切换主题。主题已内嵌进二进制，不依赖磁盘目录。
    pub fn set_theme(&self, id: &str) -> Result<(), String> {
        let t = theme::builtin_by_id(id).ok_or_else(|| format!("找不到主题 {id}"))?;
        let mut inner = self.inner.lock().map_err(|_| "锁被污染".to_string())?;
        inner.theme = Some(t);
        Ok(())
    }

    pub fn set_look(&self, font_size: f32, line_height: f32, padding: i32) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.look.font_size = font_size;
            inner.look.line_height_ratio = line_height;
            inner.look.padding = padding;
            // 字号变了，字体缓存必须重建
            inner.fonts = None;
        }
    }

    /// 列出内置主题，(id, 显示名, 是否亮色)。
    pub fn themes(&self) -> Vec<(String, String, bool)> {
        theme::builtin()
            .into_iter()
            .map(|t| (t.id, t.name, t.light))
            .collect()
    }

    // ---- 滚动 ----

    /// `delta` 正数向上翻。返回滚动后的状态。
    pub fn scroll(&self, session_id: &str, delta: i32) -> Result<ScrollInfo, String> {
        self.with_session(session_id, |s| {
            s.term.scroll_lines(delta);
            scroll_info(&s.term)
        })
    }

    pub fn scroll_page(&self, session_id: &str, up: bool) -> Result<ScrollInfo, String> {
        self.with_session(session_id, |s| {
            s.term.scroll_page(up);
            scroll_info(&s.term)
        })
    }

    pub fn scroll_to(&self, session_id: &str, edge: &str) -> Result<ScrollInfo, String> {
        self.with_session(session_id, |s| {
            match edge {
                "top" => s.term.scroll_to_top(),
                _ => s.term.scroll_to_bottom(),
            }
            scroll_info(&s.term)
        })
    }

    pub fn scroll_info(&self, session_id: &str) -> Result<ScrollInfo, String> {
        self.with_session(session_id, |s| scroll_info(&s.term))
    }

    // ---- 选区 ----

    /// 设置选区。坐标是缓冲坐标（行可负），`kind` 为 simple/block/semantic/lines。
    pub fn select(
        &self,
        session_id: &str,
        kind: &str,
        start: (i32, i32),
        end: (i32, i32),
    ) -> Result<(), String> {
        self.with_session(session_id, |s| s.term.set_selection(kind, start, end))
    }

    pub fn clear_selection(&self, session_id: &str) -> Result<(), String> {
        self.with_session(session_id, |s| s.term.clear_selection())
    }

    /// 选区文本。没有选区时返回 `None`（而不是空串），前端据此决定是否发 Ctrl+C。
    pub fn selection_text(&self, session_id: &str) -> Result<Option<String>, String> {
        self.with_session(session_id, |s| s.term.selection_text())
    }

    // ---- 搜索 ----

    /// 从新搜索。命中后自动滚到第一条。
    pub fn search(
        &self,
        session_id: &str,
        needle: &str,
        case_sensitive: bool,
        limit: usize,
    ) -> Result<SearchInfo, String> {
        self.with_session(session_id, |s| {
            s.matches = s.term.search(needle, case_sensitive, limit);
            s.active = if s.matches.is_empty() { None } else { Some(0) };
            reveal_active(s);
            SearchInfo { count: s.matches.len(), active: s.active }
        })
    }

    /// 在已有命中之间前后跳，并把它滚进视野。
    pub fn search_step(&self, session_id: &str, forward: bool) -> Result<SearchInfo, String> {
        self.with_session(session_id, |s| {
            if s.matches.is_empty() {
                return SearchInfo { count: 0, active: None };
            }
            let count = s.matches.len();
            let next = match s.active {
                None => 0,
                Some(i) if forward => (i + 1) % count,
                Some(i) => (i + count - 1) % count,
            };
            s.active = Some(next);
            reveal_active(s);
            SearchInfo { count, active: s.active }
        })
    }

    pub fn clear_search(&self, session_id: &str) -> Result<(), String> {
        self.with_session(session_id, |s| {
            s.matches.clear();
            s.active = None;
        })
    }

    // ---- 渲染 ----

    /// 渲染一帧。`max_width` 为 0 表示按终端格数自然尺寸输出。
    pub fn frame(&self, session_id: &str, max_width: u32) -> Result<GridFrame, String> {
        let mut inner = self.inner.lock().map_err(|_| "锁被污染".to_string())?;

        // 字体惰性加载：只有真的要出图才读字体文件
        if inner.fonts.is_none() {
            let look = inner.look;
            inner.fonts = Some(FontPair::load(
                &self.fonts_path.mono,
                &self.fonts_path.fallback,
                look.font_size,
                look.line_height_ratio,
            )?);
        }
        if inner.theme.is_none() {
            inner.theme = theme::builtin_by_id("ely-dark");
        }

        let Inner { sessions, fonts, theme, look } = &mut *inner;
        let session = sessions.get(session_id).ok_or_else(|| format!("会话 {session_id} 不存在"))?;
        let fonts = fonts.as_mut().ok_or("字体未就绪")?;
        let theme = theme.as_ref().ok_or("主题未就绪")?;
        let term = &session.term;

        let (mut w, mut h) = frame_size(term.cols(), term.rows(), fonts, look);
        // 前端传了可用宽度时按比例缩，保证不横向溢出
        if max_width > 0 && w as u32 > max_width {
            let k = max_width as f32 / w as f32;
            w = max_width as usize;
            h = (h as f32 * k).max(1.0) as usize;
        }

        let overlay = Overlay { matches: session.matches.clone(), active: session.active };
        let frame = render(term.inner(), &theme.palette, fonts, look, w, h, &overlay);
        Ok(GridFrame {
            width: frame.width as u32,
            height: frame.height as u32,
            pixels: frame.pixels,
            cols: term.cols(),
            rows: term.rows(),
            cell_width: fonts.advance,
            cell_height: fonts.line_height,
            padding: look.padding as f32,
            display_offset: term.display_offset(),
            history_size: term.history_size(),
            bracketed_paste: term.bracketed_paste(),
        })
    }

    fn with_session<T>(
        &self,
        session_id: &str,
        f: impl FnOnce(&mut Session) -> T,
    ) -> Result<T, String> {
        let mut inner = self.inner.lock().map_err(|_| "锁被污染".to_string())?;
        let session = inner
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("会话 {session_id} 不存在"))?;
        Ok(f(session))
    }
}

fn new_session(cols: usize, rows: usize) -> Session {
    Session { term: Terminal::new(cols, rows), matches: Vec::new(), active: None }
}

fn scroll_info(term: &Terminal) -> ScrollInfo {
    ScrollInfo { offset: term.display_offset(), history: term.history_size(), rows: term.rows() }
}

/// 把当前聚焦的命中滚进视野，并让它尽量居中——只滚到边缘的话，
/// 前后两条上下文都看不见，用户还得再手动找。
fn reveal_active(session: &mut Session) {
    let Some(index) = session.active else { return };
    let Some(m) = session.matches.get(index).copied() else { return };
    // 居中：先滚到目标行，再往回带半个屏高
    session.term.scroll_to_line(m.line);
    let half = (session.term.rows() / 2) as i32;
    session.term.scroll_lines(-half.min(session.term.display_offset() as i32));
}

/// 全局单例，由宿主（Tauri 的 managed state）持有。
pub type SharedGridHub = Arc<GridHub>;

/// PNG 编码 + base64。
///
/// 用 PNG 而不是裸 RGBA：一屏 1600×900 的 RGBA 是 5.7MB，
/// PNG 通常只有几十 KB，前端 `createImageBitmap` 也直接吃 Blob。
pub fn encode_png(frame: &GridFrame) -> Result<(String, Vec<u8>), String> {
    use std::io::Cursor;

    let img: image::RgbaImage =
        image::ImageBuffer::from_raw(frame.width, frame.height, frame.pixels.clone())
            .ok_or_else(|| "缓冲区尺寸不匹配".to_string())?;
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;

    let encoded = buf.into_inner();
    Ok((format!("data:image/png;base64,{}", base64_encode(&encoded)), encoded))
}

pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 标准 base64 解码，省一个依赖。前端把输出 base64 后发回来用这个还原。
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        rev[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for b in input.bytes() {
        if b == b'=' || b == b'\n' || b == b'\r' {
            continue;
        }
        let v = rev[b as usize];
        if v == 255 {
            return Err(format!("非法 base64 字符: {}", b as char));
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_covers_edge_cases() {
        let big = vec![0xFFu8; 1000];
        let cases: Vec<&[u8]> = vec![
            b"",
            b"a",
            b"ab",
            b"abc",
            b"abcd",
            "中文测试".as_bytes(),
            b"\x1b[31mred\x1b[0m",
            &big,
        ];
        for c in &cases {
            let e = base64_encode(c);
            let d = base64_decode(&e).expect("decode failed");
            assert_eq!(d.as_slice(), *c, "往返失败");
        }
        assert!(base64_decode("!!!").is_err(), "非法字符应报错");
    }

    #[test]
    fn hub_lifecycle_does_not_leak_sessions() {
        let hub = GridHub::new();
        hub.create("s1", 80, 24).unwrap();
        assert!(hub.has("s1"));
        // 重复 create 应该重建而不是报错
        hub.create("s1", 100, 30).unwrap();
        hub.feed("s1", b"hello");
        hub.resize("s1", 120, 40);
        hub.close("s1");
        assert!(!hub.has("s1"));
        // 未知会话的 feed 不应该 panic
        hub.feed("missing", b"ignored");
    }

    #[test]
    fn ensure_reuses_existing_session() {
        let hub = GridHub::new();
        hub.ensure("s1", 80, 24).unwrap();
        hub.feed("s1", b"first");
        // 第二次 ensure 应保留已有内容（仅 resize），不是清空重来
        hub.ensure("s1", 90, 26).unwrap();
        assert!(hub.has("s1"));
    }

    #[test]
    fn themes_are_available_without_disk() {
        let hub = GridHub::new();
        let themes = hub.themes();
        assert!(themes.len() >= 14, "内置主题不足: {}", themes.len());
        assert!(hub.set_theme("ely-light").is_ok());
        assert!(hub.set_theme("nonexistent").is_err());
    }

    #[test]
    fn frame_requires_existing_session() {
        let hub = GridHub::new();
        // 会话不存在时应返回错误而不是 panic
        assert!(hub.frame("missing", 800).is_err());
    }

    #[test]
    fn scrollback_keeps_history_and_clamps_at_bottom() {
        let hub = GridHub::new();
        hub.create("s1", 20, 4).unwrap();
        // 输出 20 行，屏幕只有 4 行，剩下的应进回滚区
        let mut out = Vec::new();
        for i in 0..20 {
            out.extend_from_slice(format!("line{i}\r\n").as_bytes());
        }
        hub.feed("s1", &out);

        let info = hub.scroll_info("s1").unwrap();
        assert_eq!(info.offset, 0, "刚输出完应该贴在底部");
        assert_eq!(info.rows, 4);
        assert!(info.history >= 15, "回滚区太少: {}", info.history);

        let up = hub.scroll("s1", 5).unwrap();
        assert_eq!(up.offset, 5);
        let down = hub.scroll("s1", -100).unwrap();
        assert_eq!(down.offset, 0, "向下越界必须钳到 0，不能变负数");
    }

    #[test]
    fn selection_returns_text_of_selected_cells() {
        let hub = GridHub::new();
        hub.create("s1", 20, 4).unwrap();
        hub.feed("s1", b"hello world\r\nsecond line\r\n");

        hub.select("s1", "simple", (0, 0), (0, 4)).unwrap();
        let text = hub.selection_text("s1").unwrap().unwrap_or_default();
        assert_eq!(text, "hello");

        hub.clear_selection("s1").unwrap();
        assert!(hub.selection_text("s1").unwrap().is_none());
    }

    #[test]
    fn search_finds_matches_across_history_and_wraps() {
        let hub = GridHub::new();
        hub.create("s1", 20, 4).unwrap();
        let mut out = Vec::new();
        for i in 0..10 {
            out.extend_from_slice(format!("needle {i}\r\n").as_bytes());
        }
        hub.feed("s1", &out);

        let found = hub.search("s1", "needle", true, 100).unwrap();
        assert_eq!(found.count, 10);
        assert_eq!(found.active, Some(0));

        // 往后跳到底再回绕，不能越界 panic
        for _ in 0..10 {
            hub.search_step("s1", true).unwrap();
        }
        let back = hub.search_step("s1", true).unwrap();
        assert_eq!(back.active, Some(1));

        // 搜不到时不应留下 active
        let none = hub.search("s1", "absent", true, 100).unwrap();
        assert_eq!(none.count, 0);
        assert_eq!(none.active, None);

        hub.clear_search("s1").unwrap();
    }

    #[test]
    fn search_is_case_insensitive_by_default() {
        let hub = GridHub::new();
        hub.create("s1", 20, 4).unwrap();
        hub.feed("s1", b"HeLLo\r\n");

        assert_eq!(hub.search("s1", "hello", false, 10).unwrap().count, 1);
        assert_eq!(hub.search("s1", "hello", true, 10).unwrap().count, 0);
    }

    #[test]
    fn new_output_invalidates_stale_search_hits() {
        let hub = GridHub::new();
        hub.create("s1", 20, 4).unwrap();
        hub.feed("s1", b"alpha\r\n");
        assert_eq!(hub.search("s1", "alpha", true, 10).unwrap().count, 1);
        // 后续输出会移动已有内容，旧列号不再可信
        hub.feed("s1", b"beta\r\n");
        assert_eq!(hub.search_info_len("s1"), 0);
    }

    impl GridHub {
        fn search_info_len(&self, id: &str) -> usize {
            self.with_session(id, |s| s.matches.len()).unwrap()
        }
    }
}
