//! SlateTerm 自绘组件集。
//!
//! 只放"骨架级"组件：主题、按钮、输入框、开关、面板壳、弹层。
//! 图库类、文档渲染、视频播放这些一律不做，等真的要用再补。
//!
//! 每个组件遵守三条约定：
//! 1. 颜色只从 `theme::Palette` 取，不写字面色值；
//! 2. 尺寸只从 `metrics` 取，不在组件里散落魔法数字；
//! 3. 组件本身不持有业务状态，状态一律由调用方传入。

pub mod metrics;
pub mod radius;
pub mod theme;

pub use theme::{Mode, Palette, Theme};

/// 依赖链自检：能调到这里，说明 gpui-pre 与 gpui-kit 已经链接成功。
pub fn probe() {
    let theme = Theme::new(Mode::Dark);
    println!(
        "theme ok: mode={:?} base=({:.3}, {:.3}, {:.3})",
        theme.mode, theme.palette.base.r, theme.palette.base.g, theme.palette.base.b
    );
    println!("titlebar height = {}px", metrics::height::TITLEBAR);
    println!("radius md = {}px", radius::MD);
}
