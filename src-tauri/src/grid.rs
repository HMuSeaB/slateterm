//! 自绘终端网格的服务端。
//!
//! 与 `pty.rs` 的关系：**不改它**。`pty.rs` 继续管理 PTY 和字节流，
//! 这里只把同一批字节再喂一份给 `alacritty_terminal`，按需栅格化成位图交给前端。
//!
//! 为什么不在前端解析 VT：中文宽度、组合字符、光标形状这些都要靠终端库，
//! JS 侧没有等价实现；而且把解析放在 Rust，前后端都只有一份状态。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use slateterm_grid::font::FontPair;
use slateterm_grid::render::{Look, Terminal, frame_size, render};
use slateterm_grid::theme;

/// 一帧要发给前端的东西。
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

/// 字体与主题是全局共享的：换主题不该让每个会话重建字体。
pub struct GridHub {
    inner: Mutex<Inner>,
    fonts_path: FontPaths,
    themes_dir: PathBuf,
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

impl GridHub {
    pub fn new() -> Self {
        let win_fonts = PathBuf::from(r"C:\Windows\Fonts");
        Self {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                fonts: None,
                theme: None,
                look: Look::default(),
            }),
            fonts_path: FontPaths {
                mono: win_fonts.join("CascadiaMono.ttf"),
                fallback: win_fonts.join("msyh.ttc"),
            },
            themes_dir: default_themes_dir(),
        }
    }

    /// 新建一个网格会话，返回会话是否建立。
    pub fn create(&self, session_id: &str, cols: usize, rows: usize) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "锁被污染".to_string())?;
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

    /// 切换主题。主题目录里的 `.toml` 按 id 查找。
    pub fn set_theme(&self, id: &str) -> Result<(), String> {
        let themes = theme::load_dir(&self.themes_dir)?;
        let t = themes
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("找不到主题 {id}"))?;
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

    /// 列出可用主题，供设置面板选择。
    pub fn themes(&self) -> Result<Vec<(String, String, bool)>, String> {
        Ok(theme::load_dir(&self.themes_dir)?
            .into_iter()
            .map(|t| (t.id, t.name, t.light))
            .collect())
    }

    /// 渲染一帧。尺寸为 0 时按终端格数自动计算。
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
            let themes = theme::load_dir(&self.themes_dir)?;
            inner.theme = themes.into_iter().next();
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
            h = (h as f32 * k) as usize;
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

/// 主题目录：优先用 exe 旁边的，开发时回退到源码目录。
fn default_themes_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let candidate = dir.join("themes");
        if candidate.is_dir() {
            return candidate;
        }
    }
    // 开发期：从 src-tauri/target/... 回溯到仓库根
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.join("../slateterm-grid/themes").canonicalize().unwrap_or(here)
}

/// 全局单例，由 Tauri 的 managed state 持有。
pub type SharedGridHub = Arc<GridHub>;

/// 发给前端的一帧。用 PNG + base64 而不是裸 RGBA：
/// 一屏 1600×900 的 RGBA 是 5.7MB，JSON 序列化后更大；
/// PNG 通常只有几十 KB，`createImageBitmap` 也直接吃 Blob。
#[derive(serde::Serialize)]
pub struct FramePayload {
    pub width: u32,
    pub height: u32,
    pub cols: usize,
    pub rows: usize,
    pub cell_width: f32,
    pub cell_height: f32,
    pub padding: f32,
    /// `data:image/png;base64,...`，前端可直接赋给 img
    pub data_url: String,
}

#[derive(serde::Serialize)]
pub struct ThemeEntry {
    pub id: String,
    pub name: String,
    pub light: bool,
}

pub fn encode_png(frame: &GridFrame) -> Result<FramePayload, String> {
    use std::io::Cursor;

    let img: image::RgbaImage = image::ImageBuffer::from_raw(frame.width, frame.height, frame.pixels.clone())
        .ok_or_else(|| "缓冲区尺寸不匹配".to_string())?;
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;

    Ok(FramePayload {
        width: frame.width,
        height: frame.height,
        cols: frame.cols,
        rows: frame.rows,
        cell_width: frame.cell_width,
        cell_height: frame.cell_height,
        padding: frame.padding,
        data_url: format!("data:image/png;base64,{}", base64_encode(buf.get_ref())),
    })
}

fn base64_encode(data: &[u8]) -> String {
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
