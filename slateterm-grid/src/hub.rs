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
use crate::render::{Look, Terminal, frame_size, render};
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

struct Inner {
    sessions: HashMap<String, Terminal>,
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
        inner.sessions.insert(session_id.to_string(), Terminal::new(cols, rows));
        Ok(())
    }

    /// 会话已存在则复用，不重建——前端可能因为重渲染重复调用 create。
    pub fn ensure(&self, session_id: &str, cols: usize, rows: usize) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "锁被污染".to_string())?;
        if inner.sessions.contains_key(session_id) {
            if let Some(t) = inner.sessions.get_mut(session_id) {
                t.resize(cols, rows);
            }
            return Ok(());
        }
        inner.sessions.insert(session_id.to_string(), Terminal::new(cols, rows));
        Ok(())
    }

    pub fn feed(&self, session_id: &str, bytes: &[u8]) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(t) = inner.sessions.get_mut(session_id)
        {
            t.feed(bytes);
        }
    }

    pub fn resize(&self, session_id: &str, cols: usize, rows: usize) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(t) = inner.sessions.get_mut(session_id)
        {
            t.resize(cols, rows);
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
        let term = sessions.get(session_id).ok_or_else(|| format!("会话 {session_id} 不存在"))?;
        let fonts = fonts.as_mut().ok_or("字体未就绪")?;
        let theme = theme.as_ref().ok_or("主题未就绪")?;

        let (mut w, mut h) = frame_size(term.cols(), term.rows(), fonts, look);
        // 前端传了可用宽度时按比例缩，保证不横向溢出
        if max_width > 0 && w as u32 > max_width {
            let k = max_width as f32 / w as f32;
            w = max_width as usize;
            h = (h as f32 * k).max(1.0) as usize;
        }

        let frame = render(term.inner(), &theme.palette, fonts, look, w, h);
        Ok(GridFrame {
            width: frame.width as u32,
            height: frame.height as u32,
            pixels: frame.pixels,
            cols: term.cols(),
            rows: term.rows(),
            cell_width: fonts.advance,
            cell_height: fonts.line_height,
            padding: look.padding as f32,
        })
    }
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
}
