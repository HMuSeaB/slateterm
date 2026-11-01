//! 自绘终端网格的 Tauri 绑定层。
//!
//! 这里**只做序列化和命令转发**，真正的逻辑全在 `slateterm_grid::hub`：
//! 放在那个 crate 里才能被编译和测试验证（本机的 src-tauri 编译会被沙箱拦截）。
//!
//! 与 `pty.rs` 的关系：不改它。`pty.rs` 继续管进程与字节流，
//! 这里只把同一批字节再解析一份，所以 xterm.js 和自绘网格可以同时在场。

use std::sync::Arc;

pub use slateterm_grid::{GridHub, ScrollInfo, SearchInfo};

/// 发给前端的一帧。
///
/// 用 PNG + base64 而不是裸 RGBA：一屏 1600×900 的 RGBA 是 5.7MB，
/// JSON 序列化后更大；PNG 通常只有几十 KB，`createImageBitmap` 也直接吃 Blob。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePayload {
    pub width: u32,
    pub height: u32,
    pub cols: usize,
    pub rows: usize,
    pub cell_width: f32,
    pub cell_height: f32,
    pub padding: f32,
    /// 已向上滚了多少行，前端据此画滚动条
    pub display_offset: usize,
    pub history_size: usize,
    /// `data:image/png;base64,...`，前端可直接赋给 img
    pub data_url: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeEntry {
    pub id: String,
    pub name: String,
    pub light: bool,
}

/// 滚动状态。字段名和前端 `ScrollInfo` 对齐。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollPayload {
    pub offset: usize,
    pub history: usize,
    pub rows: usize,
}

impl From<ScrollInfo> for ScrollPayload {
    fn from(info: ScrollInfo) -> Self {
        Self { offset: info.offset, history: info.history, rows: info.rows }
    }
}

/// 搜索结果。`active` 为 `None` 表示没有命中。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPayload {
    pub count: usize,
    pub active: Option<usize>,
}

impl From<SearchInfo> for SearchPayload {
    fn from(info: SearchInfo) -> Self {
        Self { count: info.count, active: info.active }
    }
}

pub fn encode_png(frame: &slateterm_grid::GridFrame) -> Result<FramePayload, String> {
    let (data_url, _bytes) = slateterm_grid::encode_png(frame)?;
    Ok(FramePayload {
        width: frame.width,
        height: frame.height,
        cols: frame.cols,
        rows: frame.rows,
        cell_width: frame.cell_width,
        cell_height: frame.cell_height,
        padding: frame.padding,
        display_offset: frame.display_offset,
        history_size: frame.history_size,
        data_url,
    })
}

/// 全局单例，由 Tauri 的 managed state 持有。
pub type SharedGridHub = Arc<GridHub>;
