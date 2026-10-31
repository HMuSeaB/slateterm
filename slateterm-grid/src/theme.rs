//! 主题加载。
//!
//! 直接读 alacritty 的 TOML 主题格式（`palette = 0=#rrggbb` 这种）。
//! 这样做有两个好处：
//! 1. 社区现成的 alacritty 主题可以原样丢进来，不用手工转换；
//! 2. 用户想加一套自己的配色，改一个文本文件就行，不用碰代码。
//!
//! 但**第三方配色不能盲信**：Catppuccin、Nord 这些主题的 ANSI 0 常常就是背景色，
//! 程序一显式用黑色，字就消失了。所以加载后统一过一遍 `fix_visibility`。

use std::path::{Path, PathBuf};

use crate::palette::{Palette, Rgba8};

/// 主题元信息 + 配色。
#[derive(Clone, Debug)]
pub struct Theme {
    /// 内部标识，取文件名
    pub id: String,
    /// 显示名
    pub name: String,
    /// 是否为亮色主题（决定外壳配色跟随哪一套）
    pub light: bool,
    pub palette: Palette,
}

fn parse_hex(s: &str) -> Option<Rgba8> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some(Rgba8::opaque(r, g, b))
}

fn luma(c: Rgba8) -> f32 {
    (0.2126 * c.r as f32 + 0.7152 * c.g as f32 + 0.0722 * c.b as f32) / 255.0
}

/// WCAG 相对亮度。这才是判断可读性的正确度量。
///
/// 只看亮度差会漏判：One Light 的黄 `#d2b67c` 配 `#f9f9f9` 背景，
/// 亮度差 0.14 看着"还行"，实际对比度只有 1.96，警告行几乎读不出来。
fn rel_lum(c: Rgba8) -> f32 {
    let f = |v: u8| {
        let s = v as f32 / 255.0;
        if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

/// WCAG 对比度，范围 1.0 ~ 21.0。
pub fn contrast(a: Rgba8, b: Rgba8) -> f32 {
    let (la, lb) = (rel_lum(a), rel_lum(b));
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// 终端里文字的最低对比度。WCAG 正文要求 4.5，
/// 但终端配色（尤其 Solarized 这类故意的低对比方案）达不到，
/// 取 3.0 作为"能读"的下限：明显偏弱，但仍可辨认。
pub const MIN_CONTRAST: f32 = 3.0;

/// 解析一份 alacritty 主题文本。
pub fn parse(id: &str, name: &str, text: &str) -> Result<Theme, String> {
    let mut ansi: [Option<Rgba8>; 16] = [None; 16];
    let mut bg = None;
    let mut fg = None;
    let mut cursor = None;
    let mut selection = None;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        let value = value.trim();

        if let Some(idx) = key.strip_prefix("palette") {
            // 形如 `palette = 3=#f9e2af`，等号右边还有一层
            let Some((i, color)) = value.split_once('=') else { continue };
            let Ok(i) = i.trim().parse::<usize>() else { continue };
            if i < 16
                && let Some(c) = parse_hex(color)
            {
                ansi[i] = Some(c);
            }
            continue;
        }

        match key {
            "background" => bg = parse_hex(value),
            "foreground" => fg = parse_hex(value),
            "cursor-color" | "cursor" => cursor = parse_hex(value),
            "selection-background" => selection = parse_hex(value),
            _ => {}
        }
    }

    let background = bg.ok_or("主题缺少 background")?;
    let foreground = fg.ok_or("主题缺少 foreground")?;
    // 缺的 ANSI 色用前景/背景兜底，避免整块黑
    let mut resolved = [foreground; 16];
    for (i, slot) in ansi.iter().enumerate() {
        if let Some(c) = slot {
            resolved[i] = *c;
        }
    }

    let palette = Palette {
        background,
        foreground,
        cursor: cursor.unwrap_or(foreground),
        selection: selection
            .map(|c| c.with_alpha(0x71))
            .unwrap_or_else(|| foreground.with_alpha(0x44)),
        ansi: resolved,
    };

    let light = luma(background) > 0.5;
    Ok(Theme { id: id.to_string(), name: name.to_string(), light, palette: palette.fix_visibility() })
}

impl Palette {
    /// 把可读性不足的 ANSI 色推到勉强能读。
    ///
    /// 这不是审美偏好，是可用性要求：暗色主题里 ANSI 0 常等于背景色，
    /// 亮色主题里 ANSI 15 常等于背景色，程序一旦显式指定就成了隐形文字。
    /// 处理方式是保持色相，只调明度。
    pub fn fix_visibility(mut self) -> Self {
        let bg = self.background;
        for c in self.ansi.iter_mut() {
            if contrast(*c, bg) < MIN_CONTRAST {
                *c = push_away(*c, bg, MIN_CONTRAST);
            }
        }
        // 前景要求更高一点：它是绝大多数文字的颜色
        if contrast(self.foreground, bg) < 4.5 {
            self.foreground = push_away(self.foreground, bg, 4.5);
        }
        self
    }
}

/// 把 `c` 推到满足目标对比度为止。
///
/// 保持色相的做法是**按比例缩放 RGB**，而不是等量加减：
/// 等量加减会先把暗通道抬起来，颜色会发灰、偏色。
/// 缩放才能让 `#21222c` 这种深蓝紫变成浅蓝紫，仍然是"蓝紫"那一档。
fn push_away(c: Rgba8, bg: Rgba8, target: f32) -> Rgba8 {
    // 先试"往远离背景的方向"，如果被端点卡住，就换反方向
    for &brighter in &[luma(c) >= luma(bg), luma(c) < luma(bg)] {
        let mut cur = c;
        for _ in 0..120 {
            if contrast(cur, bg) >= target {
                return cur;
            }
            let next = scale_toward(cur, brighter, 0.04);
            if next == cur {
                break;
            }
            cur = next;
        }
        if contrast(cur, bg) >= target {
            return cur;
        }
    }
    // 两个方向都不行（极少见），退化成纯黑或纯白
    if contrast(Rgba8::opaque(255, 255, 255), bg) > contrast(Rgba8::opaque(0, 0, 0), bg) {
        Rgba8::opaque(255, 255, 255)
    } else {
        Rgba8::opaque(0, 0, 0)
    }
}

/// 按比例把颜色推向更亮或更暗。
///
/// 变亮的公式是"向白色插值"，变暗是"向黑色插值"——
/// 两者都保持 RGB 三通道的相对比例，所以色相不变。
fn scale_toward(c: Rgba8, brighter: bool, amount: f32) -> Rgba8 {
    let f = |v: u8| {
        let s = v as f32;
        let out = if brighter { s + (255.0 - s) * amount } else { s * (1.0 - amount) };
        out.round().clamp(0.0, 255.0) as u8
    };
    Rgba8::opaque(f(c.r), f(c.g), f(c.b))
}

/// 从目录加载全部 `.toml` 主题，按文件名排序。
pub fn load_dir(dir: &Path) -> Result<Vec<Theme>, String> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("读取主题目录失败 {}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "toml"))
        .collect();
    entries.sort();

    let mut out = Vec::new();
    for path in entries {
        let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("theme").to_string();
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取主题失败 {}: {e}", path.display()))?;
        let name = display_name(&id);
        out.push(parse(&id, &name, &text)?);
    }
    Ok(out)
}

/// 文件名 → 显示名：`catppuccin-mocha` → `Catppuccin Mocha`
fn display_name(id: &str) -> String {
    id.split(['-', '_'])
        .map(|w| {
            let mut ch = w.chars();
            match ch.next() {
                Some(f) => f.to_uppercase().collect::<String>() + ch.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_alacritty_format() {
        let text = "\
palette = 0=#45475a
palette = 1=#f38ba8
background = #1e1e2e
foreground = #cdd6f4
cursor-color = #f5e0dc
";
        let t = parse("t", "T", text).unwrap();
        assert!(!t.light);
        assert_eq!(t.palette.background, Rgba8::opaque(0x1e, 0x1e, 0x2e));
        assert_eq!(t.palette.ansi[1], Rgba8::opaque(0xf3, 0x8b, 0xa8));
        assert_eq!(t.palette.cursor, Rgba8::opaque(0xf5, 0xe0, 0xdc));
    }

    #[test]
    fn detects_light_theme() {
        let text = "background = #fdf6e3\nforeground = #657b83\n";
        let t = parse("solarized-light", "Solarized Light", text).unwrap();
        assert!(t.light);
    }

    #[test]
    fn pushes_invisible_colors_away_from_background() {
        // ANSI 0 与背景完全相同，这是真实主题里常见的写法
        let text = "background = #1e1e2e\nforeground = #cdd6f4\npalette = 0=#1e1e2e\n";
        let t = parse("t", "T", text).unwrap();
        assert!(
            contrast(t.palette.ansi[0], t.palette.background) >= MIN_CONTRAST,
            "仍未推开"
        );
    }

    /// 真实存在的坑：One Light 的 ANSI 3 是 `#d2b67c`，
    /// 配 `#f9f9f9` 背景对比度只有 1.96，警告行几乎看不见。
    #[test]
    fn fixes_low_contrast_yellow_on_light() {
        let text = "background = #f9f9f9\nforeground = #2a2c33\npalette = 3=#d2b67c\npalette = 11=#d2b67c\n";
        let t = parse("one-light", "One Light", text).unwrap();
        for i in [3, 11] {
            let r = contrast(t.palette.ansi[i], t.palette.background);
            assert!(r >= MIN_CONTRAST, "ANSI {i} 对比度仍不足: {r:.2}");
        }
    }

    #[test]
    fn every_shipped_theme_is_readable() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("themes");
        let themes = load_dir(&dir).unwrap();
        assert!(themes.len() >= 14, "主题数量不足: {}", themes.len());
        for t in &themes {
            for (i, c) in t.palette.ansi.iter().enumerate() {
                let r = contrast(*c, t.palette.background);
                assert!(r >= MIN_CONTRAST - 0.01, "{} 的 ANSI {i} 对比度 {r:.2}", t.id);
            }
            assert!(
                contrast(t.palette.foreground, t.palette.background) >= 4.4,
                "{} 前景对比度不足",
                t.id
            );
        }
    }
}
