//! 自绘终端网格。
//!
//! 用 `alacritty_terminal` 解析 VT 序列，用我们自己的栅格化画像素。
//! 目标是拿回 xterm.js 拿不到的东西：字形定位、留白、行距、光标形态、与主题同源的配色。

pub mod font;
pub mod palette;
pub mod render;
pub mod theme;

pub use palette::{Palette, Rgba8};
pub use render::{Frame, GridSize, Look, Terminal, frame_size, render};
pub use theme::Theme;
