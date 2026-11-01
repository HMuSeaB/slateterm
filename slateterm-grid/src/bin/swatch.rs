//! 把一个主题画成一张样张。
//!
//! 内容刻意做成一页"终端色卡"：前 16 行是 ANSI 色条，后面是真实场景片段
//! （提示符、Git、编译输出、中文、256 色条）。
//! 这样一眼就能看出这套主题在实际使用里是什么样子，而不是只看色块。

use std::path::{Path, PathBuf};

use slateterm_grid::font::FontPair;
use slateterm_grid::palette::Rgba8;
use slateterm_grid::render::{Look, Terminal, frame_size, render};
use slateterm_grid::theme;

const FONTS: &str = r"C:\Windows\Fonts";

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let themes_dir = args.get(1).cloned().unwrap_or_else(|| "themes".into());
    let out_dir = args.get(2).cloned().unwrap_or_else(|| "out/themes".into());
    // 只出一套时用来调试
    let only = args.get(3).cloned();

    let themes = theme::load_dir(Path::new(&themes_dir))?;
    println!("载入 {} 套主题", themes.len());

    let look = Look { font_size: 13.0, line_height_ratio: 1.5, padding: 16, ..Look::default() };
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("建目录失败: {e}"))?;

    for t in &themes {
        if let Some(only) = &only
            && &t.id != only
        {
            continue;
        }

        let mut fonts = FontPair::load(
            &PathBuf::from(FONTS).join("CascadiaMono.ttf"),
            &PathBuf::from(FONTS).join("msyh.ttc"),
            look.font_size,
            look.line_height_ratio,
        )?;

        let cols = 84;
        let rows = 26;
        let mut term = Terminal::new(cols, rows);
        let sheet = color_sheet(&t.palette, cols);
        term.feed(sheet.as_bytes());

        let (w, h) = frame_size(term.cols(), term.rows(), &fonts, &look);
        let frame = render(term.inner(), &t.palette, &mut fonts, &look, w, h, &Default::default());
        let path = PathBuf::from(&out_dir).join(format!("{}.png", t.id));
        frame.save_png(&path)?;
        println!("  {} ({}) -> {}", t.name, if t.light { "亮" } else { "暗" }, path.display());
    }

    Ok(())
}

/// 一页色卡。
fn color_sheet(p: &slateterm_grid::Palette, _cols: usize) -> String {
    let mut s = String::new();
    let fg = hex(p.foreground);
    let dim = hex(p.ansi[8]);
    let red = hex(p.ansi[1]);
    let green = hex(p.ansi[2]);
    let yellow = hex(p.ansi[3]);
    let blue = hex(p.ansi[4]);
    let magenta = hex(p.ansi[5]);
    let cyan = hex(p.ansi[6]);

    // 标题
    s.push_str(&format!("{fg}ANSI 16 (normal / bright)        256-color ramp        grayscale\r\n"));
    s.push_str(&format!("{dim}─────────────────────────────     ───────────────       ─────────\r\n"));

    // 两列并排：左边 16 色，右边 256 色立方体抽样 + 灰阶
    for row in 0..8u8 {
        // 左：normal + bright 成对
        let a = row;
        let b = row + 8;
        s.push_str(&hex(p.ansi[a as usize]));
        s.push_str(&format!("██{a:<2} "));
        s.push_str(&hex(p.ansi[b as usize]));
        s.push_str(&format!("██{b:<2}   "));
        // 右：立方体按"红通道递增"采样，行间用绿通道区分，看得出梯度
        for step in 0..5u8 {
            let idx = 16 + row * 6 + step;
            s.push_str(&rgb_escape(cube(idx)));
            s.push_str("██");
        }
        s.push_str(&format!("{dim}        "));
        // 灰阶：每行三个，连续铺满 24 档
        for step in 0..3u8 {
            let idx = 232 + row * 3 + step;
            s.push_str(&rgb_escape(gray(idx)));
            s.push_str("██");
        }
        s.push_str("\r\n");
    }

    // 分隔
    s.push_str(&format!("{dim}──────────────────────────────────────────────────────────────\r\n"));

    // 真实场景
    s.push_str(&format!("{fg}PS {blue}D:\\4rchive\\Code\\SlateTerm{fg}> {dim}git status{fg}\r\n"));
    s.push_str(&format!("{red}  modified:   src/components/TerminalPane.tsx{fg}\r\n"));
    s.push_str(&format!("{green}  new file:   slateterm-grid/src/theme.rs{fg}\r\n"));
    s.push_str(&format!("{dim}On branch {fg}main{dim}, up to date with {fg}origin/main{dim}.{fg}\r\n"));
    s.push_str(&format!("{fg}PS {blue}D:\\4rchive\\Code\\SlateTerm{fg}> {dim}cargo build --release{fg}\r\n"));
    s.push_str(&format!("{green}   Compiling{fg} slateterm-grid v0.1.0\r\n"));
    s.push_str(&format!("{yellow}warning:{fg} unused import (2 occurrences)\r\n"));
    s.push_str(&format!("{green}    Finished{fg} release in 3.42s\r\n"));
    s.push_str(&format!("{fg}PS {blue}D:\\4rchive\\Code\\SlateTerm{fg}> {dim}Write-Host '中文渲染测试：终端、选择、粘连'{fg}\r\n"));
    s.push_str(&format!("{fg}中文渲染测试：终端、选择、粘连\r\n"));
    s.push_str(&format!("{magenta}[1/3]{fg} 解析 VT ......... {green}完成{fg}  {cyan}[2/3]{fg} 栅格化 ....... {yellow}进行中{fg}\r\n"));
    s.push_str(&format!("{dim}ABC abc 123 - 「引号」 括号（） □ OK\r\n"));
    s.push_str(&format!("{fg}PS {blue}D:\\4rchive\\Code\\SlateTerm{fg}> "));

    s
}

fn hex(c: Rgba8) -> String {
    format!("\x1b[38;2;{};{};{}m", c.r, c.g, c.b)
}

fn rgb_escape(c: Rgba8) -> String {
    format!("\x1b[38;2;{};{};{}m", c.r, c.g, c.b)
}

/// 256 色立方体
fn cube(i: u8) -> Rgba8 {
    let steps = [0u8, 95, 135, 175, 215, 255];
    let i = i.saturating_sub(16);
    Rgba8::opaque(
        steps[(i / 36) as usize % 6],
        steps[((i % 36) / 6) as usize % 6],
        steps[(i % 6) as usize],
    )
}

fn gray(i: u8) -> Rgba8 {
    let v = 8u16.saturating_add((i.saturating_sub(232) as u16) * 10).min(255) as u8;
    Rgba8::opaque(v, v, v)
}
