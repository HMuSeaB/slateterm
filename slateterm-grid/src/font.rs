//! 字形栅格化。
//!
//! 终端对字体的要求和普通 UI 不同，这里按终端的方式处理：
//! - **只用等宽字体的水平步进**，整格宽度 = 步进 × 2（中文占两格）；
//! - **中文回退到系统字体**。Cascadia Mono 没有汉字，不回退就是一片豆腐块；
//! - 字形按 (字符, 字号) 缓存成位图，不做逐帧栅格化。
//!
//! 现在的实现走 CPU（fontdue）。它够输出设计稿，也够验证观感；
//! 真要接进 WebView，把这层换成带 subpixel 的 GPU 路径即可，接口不用动。

use std::collections::HashMap;

use fontdue::{Font, FontSettings};

use crate::palette::Rgba8;

/// 字形位图：单通道覆盖率，alpha 由绘制时上色。
pub struct Glyph {
    pub width: usize,
    pub height: usize,
    /// 相对当前笔的位置偏移（左上角）
    pub left: i32,
    pub top: i32,
    pub coverage: Vec<u8>,
}

pub struct FontPair {
    mono: Font,
    fallback: Font,
    /// 字号（逻辑像素）
    size: f32,
    /// 单字符步进宽度
    pub advance: f32,
    /// 行高
    pub line_height: f32,
    /// 基线相对行顶的偏移
    pub ascent: f32,
    cache: HashMap<(char, bool), Glyph>,
    has_glyph_cache: HashMap<char, bool>,
}

impl FontPair {
    /// 从字体文件构造。`fallback_path` 用来兜中文。
    pub fn load(
        mono_path: &std::path::Path,
        fallback_path: &std::path::Path,
        size: f32,
        line_height_ratio: f32,
    ) -> Result<Self, String> {
        let read = |p: &std::path::Path| -> Result<Vec<u8>, String> {
            std::fs::read(p).map_err(|e| format!("读取字体失败 {}: {e}", p.display()))
        };
        let mono = Font::from_bytes(read(mono_path)?, FontSettings::default())
            .map_err(|e| format!("解析字体失败 {}: {e}", mono_path.display()))?;
        let fallback = Font::from_bytes(read(fallback_path)?, FontSettings::default())
            .map_err(|e| format!("解析字体失败 {}: {e}", fallback_path.display()))?;

        let advance = mono.metrics('M', size).advance_width;
        let line_height = (size * line_height_ratio).round();
        // fontdue 的 ascent 是相对基线的正向量
        let ascent = advance * 0.0 + size * 0.82;

        Ok(Self {
            mono,
            fallback,
            size,
            advance,
            line_height,
            ascent,
            cache: HashMap::new(),
            has_glyph_cache: HashMap::new(),
        })
    }

    /// 该字符是否由等宽字体本身提供（决定它是占一格还是两格）。
    pub fn is_single_width(&mut self, ch: char) -> bool {
        if let Some(&v) = self.has_glyph_cache.get(&ch) {
            return v;
        }
        let has = self.mono.lookup_glyph_index(ch) != 0;
        self.has_glyph_cache.insert(ch, has);
        has
    }

    pub fn glyph(&mut self, ch: char) -> &Glyph {
        self.glyph_styled(ch, false)
    }

    /// `bold` 目前用"加粗渲染 + 轻微横向偏移叠印"近似，避免再加载一套字体。
    pub fn glyph_styled(&mut self, ch: char, bold: bool) -> &Glyph {
        let key = (ch, bold);
        if !self.cache.contains_key(&key) {
            let g = self.rasterize(ch, bold);
            self.cache.insert(key, g);
        }
        self.cache.get(&key).unwrap()
    }

    fn rasterize(&self, ch: char, bold: bool) -> Glyph {
        let ch = if ch == '\0' { ' ' } else { ch };
        let font = if self.mono.lookup_glyph_index(ch) != 0 { &self.mono } else { &self.fallback };
        let (metrics, bitmap) = font.rasterize(ch, self.size);

        // fontdue 的 ymin 相对基线向上为正，终端按行顶定位，需要换算。
        let top = (self.ascent - (metrics.ymin + metrics.height as i32) as f32).round() as i32;

        let mut coverage = bitmap;
        if bold {
            // 简单的水平膨胀，当作伪粗体
            let (w, h) = (metrics.width, metrics.height);
            let mut thick = vec![0u8; w * h];
            for row in 0..h {
                for col in 0..w {
                    let cur = coverage[row * w + col];
                    let prev = if col > 0 { coverage[row * w + col - 1] } else { 0 };
                    thick[row * w + col] = cur.max(prev / 2);
                }
            }
            coverage = thick;
        }

        Glyph {
            width: metrics.width,
            height: metrics.height,
            left: metrics.xmin,
            top,
            coverage,
        }
    }
}

/// 在 RGBA 缓冲上合成一个字形。
pub fn blit_glyph(
    buf: &mut [u8],
    buf_w: usize,
    buf_h: usize,
    x: i32,
    y: i32,
    glyph: &Glyph,
    color: Rgba8,
) {
    for gy in 0..glyph.height {
        let py = y + glyph.top + gy as i32;
        if py < 0 || py as usize >= buf_h {
            continue;
        }
        for gx in 0..glyph.width {
            let px = x + glyph.left + gx as i32;
            if px < 0 || px as usize >= buf_w {
                continue;
            }
            let a = glyph.coverage[gy * glyph.width + gx];
            if a == 0 {
                continue;
            }
            let idx = (py as usize * buf_w + px as usize) * 4;
            let alpha = (a as u32 * color.a as u32 / 255) as u8;
            blend(buf, idx, color, alpha);
        }
    }
}

/// 把 `color` 以 `alpha` 叠到 `buf[idx..idx+4]` 上。
pub fn blend(buf: &mut [u8], idx: usize, color: Rgba8, alpha: u8) {
    if alpha == 0 {
        return;
    }
    let a = alpha as f32 / 255.0;
    for (i, c) in [color.r, color.g, color.b].into_iter().enumerate() {
        let dst = buf[idx + i] as f32;
        buf[idx + i] = (c as f32 * a + dst * (1.0 - a)).round() as u8;
    }
    buf[idx + 3] = 255;
}

/// 填充矩形（含 alpha 混合）。
pub fn fill_rect(
    buf: &mut [u8],
    buf_w: usize,
    buf_h: usize,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    color: Rgba8,
) {
    for py in y.max(0)..(y + h).min(buf_h as i32) {
        for px in x.max(0)..(x + w).min(buf_w as i32) {
            let idx = (py as usize * buf_w + px as usize) * 4;
            blend(buf, idx, color, color.a);
        }
    }
}
