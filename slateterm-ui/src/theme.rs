//! SlateTerm 的语义色板。
//!
//! 规则只有一条：**组件里不许出现字面色值**，颜色一律从这里取。
//! 这样换主题时不用扫全工程的 `#rrggbb`，也不会出现改了一处漏了三处的情况。
//!
//! 两个前提：
//! - dark 是暖琥珀系（沿用现有 SlateTerm 的辨识度），不是 GPUI 常见的冷蓝灰；
//! - paper 是暖纸白，和 dark 同源，不是简单反色。

use gpui::Rgba;

/// 一个主题的全部颜色。字段按"用途"命名，不按"颜色"命名——
/// `surface_raised` 换成绿色主题也还是这个名字。
#[derive(Clone, Debug)]
pub struct Palette {
    // 表面：从底到顶一共四层，层级关系必须保持
    pub base: Rgba,
    pub raised: Rgba,
    pub soft: Rgba,
    pub inset: Rgba,

    // 边界：高光描边与投影描边，拟物感的来源
    pub edge_light: Rgba,
    pub edge_dark: Rgba,

    // 文字：三级层次
    pub text: Rgba,
    pub text_muted: Rgba,
    pub text_faint: Rgba,

    // 强调色
    pub accent: Rgba,
    pub accent_soft: Rgba,
    pub accent_text: Rgba,

    // 终端区域专用：跑在 xterm/grid 里的底与前景
    pub term_bg: Rgba,
    pub term_fg: Rgba,
    pub term_cursor: Rgba,
    pub term_selection: Rgba,
}

impl Palette {
    /// 暖琥珀暗色。数值取自现有 `styles.css` 的 `:root`，
    /// 保证切到 GPUI 后视觉不跳。
    pub fn amber_dark() -> Self {
        Self {
            base: rgb(0x19, 0x14, 0x10),
            raised: rgba(0x26, 0x1f, 0x18, 0xe6),
            soft: rgba(0x1f, 0x19, 0x13, 0xc7),
            inset: rgba(0x14, 0x10, 0x0c, 0xbd),

            edge_light: rgba(0xff, 0xec, 0xcd, 0x13),
            edge_dark: rgba(0x00, 0x00, 0x00, 0x57),

            text: rgb(0xf3, 0xec, 0xe0),
            text_muted: rgb(0xcd, 0xc0, 0xaa),
            text_faint: rgb(0x6f, 0x64, 0x55),

            accent: rgb(0xf0, 0xa6, 0x3c),
            accent_soft: rgba(0xe0, 0x9a, 0x3e, 0x47),
            accent_text: rgb(0x19, 0x14, 0x10),

            term_bg: rgb(0x19, 0x14, 0x10),
            term_fg: rgb(0xec, 0xe2, 0xd0),
            term_cursor: rgb(0xf0, 0xa6, 0x3c),
            term_selection: rgba(0xe0, 0x9a, 0x3e, 0x47),
        }
    }

    /// 暖纸白。对应现有 `.theme-paper`。
    pub fn paper_light() -> Self {
        Self {
            base: rgb(0xee, 0xe7, 0xd9),
            raised: rgba(0xfa, 0xf5, 0xeb, 0xe6),
            soft: rgba(0xef, 0xe8, 0xda, 0xd1),
            inset: rgba(0xe0, 0xd7, 0xc7, 0xb8),

            edge_light: rgba(0xff, 0xff, 0xff, 0xc2),
            edge_dark: rgba(0x53, 0x47, 0x36, 0x29),

            text: rgb(0x2c, 0x26, 0x1d),
            text_muted: rgb(0x6d, 0x66, 0x57),
            text_faint: rgb(0x9a, 0x91, 0x82),

            accent: rgb(0x20, 0x7e, 0x7a),
            accent_soft: rgba(0x14, 0x5f, 0x5c, 0x38),
            accent_text: rgb(0xf7, 0xf3, 0xe8),

            term_bg: rgb(0xf7, 0xf3, 0xe8),
            term_fg: rgb(0x2f, 0x2b, 0x22),
            term_cursor: rgb(0x14, 0x5f, 0x5c),
            term_selection: rgba(0x14, 0x5f, 0x5c, 0x38),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Dark,
    Light,
}

impl Mode {
    pub fn palette(self) -> Palette {
        match self {
            Mode::Dark => Palette::amber_dark(),
            Mode::Light => Palette::paper_light(),
        }
    }
}

/// 一组具名主题。现在只有两个，但结构按多套来留。
#[derive(Clone, Debug)]
pub struct Theme {
    pub mode: Mode,
    pub palette: Palette,
}

impl Theme {
    pub fn new(mode: Mode) -> Self {
        Self { mode, palette: mode.palette() }
    }

    pub fn with_mode(self, mode: Mode) -> Self {
        Self::new(mode)
    }
}

const fn rgb(r: u8, g: u8, b: u8) -> Rgba {
    Rgba { r: r as f32 / 255.0, g: g as f32 / 255.0, b: b as f32 / 255.0, a: 1.0 }
}

const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Rgba {
    Rgba {
        r: r as f32 / 255.0,
        g: g as f32 / 255.0,
        b: b as f32 / 255.0,
        a: a as f32 / 255.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 层级必须严格递增，否则拟物感的"浮起/凹陷"会反。
    #[test]
    fn surfaces_stack_in_order() {
        for p in [Palette::amber_dark(), Palette::paper_light()] {
            let l = |c: Rgba| c.r + c.g + c.b;
            assert!(l(p.base) <= l(p.raised), "raised 应比 base 亮");
            assert!(l(p.inset) <= l(p.base), "inset 应比 base 暗");
        }
    }

    /// 文字与底色的对比度要够。这里只做粗糙的亮度差检查，
    /// 完整 WCAG 计算留给后续的 lint。
    #[test]
    fn text_contrasts_with_base() {
        for p in [Palette::amber_dark(), Palette::paper_light()] {
            let l = |c: Rgba| 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
            assert!((l(p.text) - l(p.base)).abs() > 0.45);
            assert!((l(p.term_fg) - l(p.term_bg)).abs() > 0.45);
        }
    }

    #[test]
    fn mode_maps_to_palette() {
        assert_eq!(Theme::new(Mode::Light).mode, Mode::Light);
        assert_ne!(
            Theme::new(Mode::Dark).palette.base,
            Theme::new(Mode::Light).palette.base
        );
    }
}
