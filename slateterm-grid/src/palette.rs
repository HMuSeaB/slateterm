//! 终端配色。
//!
//! 这里的原则和 UI 层一致：**颜色由主题决定，不由终端自己决定**。
//! ANSI 16 色也一并映射成品牌的暖色系，而不是原封不动照搬标准的纯红纯绿——
//! 那套颜色在深色底上会显得刺眼，也是"终端看着廉价"的主因之一。

use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba8 {
    pub const fn new(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }

    pub const fn opaque(r: u8, g: u8, b: u8) -> Self {
        Self::new(r, g, b, 255)
    }

    /// 按比例向另一色靠拢，用于 dim 属性。
    pub fn mix(self, other: Rgba8, t: f32) -> Self {
        let f = |a: u8, b: u8| (a as f32 * (1.0 - t) + b as f32 * t).round() as u8;
        Self::new(f(self.r, other.r), f(self.g, other.g), f(self.b, other.b), self.a)
    }

    pub fn with_alpha(self, a: u8) -> Self {
        Self::new(self.r, self.g, self.b, a)
    }
}

/// 一套完整的终端配色。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Palette {
    pub background: Rgba8,
    pub foreground: Rgba8,
    pub cursor: Rgba8,
    pub selection: Rgba8,
    /// 16 个 ANSI 色：0-7 常规，8-15 亮色。
    pub ansi: [Rgba8; 16],
}

impl Palette {
    /// 暖琥珀暗色：与 SlateTerm 现有 `:root` 和 xterm 主题数值一致。
    pub fn amber_dark() -> Self {
        Self {
            background: Rgba8::opaque(0x19, 0x14, 0x10),
            foreground: Rgba8::opaque(0xec, 0xe2, 0xd0),
            cursor: Rgba8::opaque(0xf0, 0xa6, 0x3c),
            selection: Rgba8::new(0xe0, 0x9a, 0x3e, 0x71),
            ansi: [
                // ANSI 0 不能取真正的黑：暗色底上会彻底看不见。
                // 提到比背景亮一档，程序显式用黑色时仍可读，语义上还是"暗的那一档"。
                Rgba8::opaque(0x46, 0x3b, 0x2e),
                Rgba8::opaque(0xd9, 0x69, 0x4f),
                Rgba8::opaque(0x9a, 0xa8, 0x61),
                Rgba8::opaque(0xdd, 0xa0, 0x3f),
                Rgba8::opaque(0x7e, 0x9d, 0xc4),
                Rgba8::opaque(0xc1, 0x76, 0xa8),
                Rgba8::opaque(0xc9, 0x8a, 0x4e),
                Rgba8::opaque(0xcd, 0xc0, 0xaa),
                Rgba8::opaque(0x6f, 0x64, 0x55),
                Rgba8::opaque(0xef, 0x82, 0x70),
                Rgba8::opaque(0xb8, 0xc4, 0x7c),
                Rgba8::opaque(0xf0, 0xbc, 0x5e),
                Rgba8::opaque(0x9a, 0xb8, 0xde),
                Rgba8::opaque(0xdc, 0x94, 0xc2),
                Rgba8::opaque(0xe5, 0xa8, 0x69),
                Rgba8::opaque(0xfd, 0xf6, 0xe9),
            ],
        }
    }

    /// 暖纸白：对应现有 `.theme-paper`。
    pub fn paper_light() -> Self {
        Self {
            background: Rgba8::opaque(0xf7, 0xf3, 0xe8),
            foreground: Rgba8::opaque(0x2f, 0x2b, 0x22),
            cursor: Rgba8::opaque(0x14, 0x5f, 0x5c),
            selection: Rgba8::new(0x14, 0x5f, 0x5c, 0x38),
            ansi: [
                Rgba8::opaque(0x26, 0x21, 0x1d),
                Rgba8::opaque(0xa0, 0x42, 0x37),
                Rgba8::opaque(0x4c, 0x7a, 0x53),
                Rgba8::opaque(0x92, 0x66, 0x2b),
                Rgba8::opaque(0x3f, 0x63, 0x92),
                Rgba8::opaque(0x87, 0x46, 0x67),
                Rgba8::opaque(0x1c, 0x6a, 0x67),
                Rgba8::opaque(0xd7, 0xcf, 0xbc),
                Rgba8::opaque(0x6d, 0x66, 0x57),
                Rgba8::opaque(0xd5, 0x5b, 0x4e),
                Rgba8::opaque(0x5f, 0x96, 0x67),
                Rgba8::opaque(0xb7, 0x85, 0x36),
                Rgba8::opaque(0x59, 0x83, 0xbe),
                Rgba8::opaque(0xad, 0x5b, 0x87),
                Rgba8::opaque(0x2d, 0x91, 0x8c),
                // 亮白同理：纸白背景上要压暗一档，否则白字看不见。
                Rgba8::opaque(0x6f, 0x69, 0x5c),
            ],
        }
    }

    /// 把 `alacritty_terminal` 的颜色解析成实际像素色。
    ///
    /// 返回 `None` 表示"用默认前景/背景"，调用方据此区分。
    pub fn resolve(&self, color: Color, is_fg: bool) -> Option<Rgba8> {
        let pick = |c: NamedColor| match c {
            NamedColor::Foreground | NamedColor::BrightForeground => Some(self.foreground),
            NamedColor::Background => Some(self.background),
            NamedColor::Cursor => Some(self.cursor),
            other => {
                let idx = other as usize;
                if idx < 16 { Some(self.ansi[idx]) } else { None }
            }
        };

        match color {
            Color::Spec(rgb) => Some(Rgba8::opaque(rgb.r, rgb.g, rgb.b)),
            Color::Named(name) => pick(name),
            Color::Indexed(i) => {
                if (i as usize) < 16 {
                    Some(self.ansi[i as usize])
                } else if is_fg {
                    Some(cube_color(i))
                } else {
                    Some(cube_color(i))
                }
            }
        }
    }
}

/// 256 色的 16-255 部分按标准立方体与灰阶生成。
fn cube_color(i: u8) -> Rgba8 {
    if i >= 232 {
        // 灰阶：232..=255 映射到 8..=238
        let v = 8 + (i - 232) * 10;
        return Rgba8::opaque(v, v, v);
    }
    let i = i - 16;
    let steps = [0u8, 95, 135, 175, 215, 255];
    Rgba8::opaque(
        steps[(i / 36) as usize],
        steps[((i % 36) / 6) as usize],
        steps[(i % 6) as usize],
    )
}

impl Rgba8 {
    pub fn to_rgb(&self) -> Rgb {
        Rgb { r: self.r, g: self.g, b: self.b }
    }
}
