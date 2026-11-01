//! 界面合成：把自绘的终端网格贴进 SlateTerm 现有的外壳里。
//!
//! 尺寸全部对齐现有 `styles.css`：标题栏 58px、会话栏 260px、右侧栏 320px、
//! 主区上下文条 48px。这样这张图就是"换成自绘终端之后的样子"，
//! 而不是另画一个界面。

use std::path::PathBuf;

use portable_pty::{CommandBuilder, PtySize, native_pty_system};

use slateterm_grid::font::FontPair;
use slateterm_grid::palette::{Palette, Rgba8};
use slateterm_grid::render::{Look, Terminal, frame_size, render};

const FONTS: &str = r"C:\Windows\Fonts";

/// 外壳配色，直接取自 `src/styles/styles.css` 的 `:root`。
struct Shell {
    base: Rgba8,
    raised: Rgba8,
    soft: Rgba8,
    edge_light: Rgba8,
    edge_dark: Rgba8,
    text: Rgba8,
    muted: Rgba8,
    faint: Rgba8,
    accent: Rgba8,
}

fn shell_dark() -> Shell {
    Shell {
        base: Rgba8::opaque(0x19, 0x14, 0x10),
        raised: Rgba8::opaque(0x26, 0x1f, 0x18),
        soft: Rgba8::opaque(0x1f, 0x19, 0x13),
        edge_light: Rgba8::new(0xff, 0xec, 0xcd, 0x1f),
        edge_dark: Rgba8::new(0x00, 0x00, 0x00, 0x88),
        text: Rgba8::opaque(0xf3, 0xec, 0xe0),
        muted: Rgba8::opaque(0xcd, 0xc0, 0xaa),
        faint: Rgba8::opaque(0x6f, 0x64, 0x55),
        accent: Rgba8::opaque(0xf0, 0xa6, 0x3c),
    }
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let out = args.get(1).cloned().unwrap_or_else(|| "out/shell.png".into());
    let mode = args.get(2).cloned().unwrap_or_else(|| "dark".into());
    let light = mode == "light";

    let palette = if light { Palette::paper_light() } else { Palette::amber_dark() };
    let sh = if light {
        Shell {
            base: Rgba8::opaque(0xee, 0xe7, 0xd9),
            raised: Rgba8::opaque(0xfa, 0xf5, 0xeb),
            soft: Rgba8::opaque(0xef, 0xe8, 0xda),
            edge_light: Rgba8::new(0xff, 0xff, 0xff, 0xcc),
            edge_dark: Rgba8::new(0x53, 0x47, 0x36, 0x44),
            text: Rgba8::opaque(0x2c, 0x26, 0x1d),
            muted: Rgba8::opaque(0x6d, 0x66, 0x57),
            faint: Rgba8::opaque(0x9a, 0x91, 0x82),
            accent: Rgba8::opaque(0x20, 0x7e, 0x7a),
        }
    } else {
        shell_dark()
    };

    // 画布。用 2 倍分辨率输出，文字才经得起放大细看。
    // 做法是：布局参数全部按逻辑像素写好，再由 `S` 统一放大，不必逐个乘。
    let scale = 2i32;
    let s = |v: i32| v * scale;
    let lw = 1280i32;
    let lh = 820i32;
    let cw = (lw * scale) as usize;
    let ch = (lh * scale) as usize;
    let mut buf = vec![0u8; cw * ch * 4];
    for px in buf.chunks_exact_mut(4) {
        px[0] = sh.base.r;
        px[1] = sh.base.g;
        px[2] = sh.base.b;
        px[3] = 255;
    }

    // 布局常量，与 styles.css 对齐
    let titlebar_h = s(58);
    let sidebar_w = s(260);
    let right_w = s(300);
    let gap = s(12);
    let ctxbar_h = s(48);

    // 标题栏
    fill(&mut buf, cw, ch, 0, 0, cw as i32, titlebar_h, sh.raised);
    fill(&mut buf, cw, ch, 0, titlebar_h - s(1), cw as i32, s(1), sh.edge_light);
    fill_circle(&mut buf, cw, ch, s(24), titlebar_h / 2, s(5), sh.accent);

    // 左侧会话栏
    let sb_y = titlebar_h + gap;
    let sb_h = ch as i32 - sb_y - gap;
    round_rect(&mut buf, cw, ch, gap, sb_y, sidebar_w, sb_h, sh.soft, sh.edge_dark, s(14));
    // 三行会话，第一行高亮
    let row_h = s(34);
    round_rect(
        &mut buf, cw, ch, gap + s(8), sb_y + s(44), sidebar_w - s(16), row_h,
        palette.selection, palette.selection, s(10),
    );

    // 中间区域
    let main_x = gap + sidebar_w + gap;
    let main_w = cw as i32 - main_x - right_w - gap * 2;
    // 上下文条
    round_rect(&mut buf, cw, ch, main_x, sb_y, main_w, ctxbar_h, sh.soft, sh.edge_dark, s(12));

    // 终端面板：这才是自绘的部分
    let term_y = sb_y + ctxbar_h + s(8);
    let term_h = ch as i32 - term_y - gap;

    // 字号也按缩放放大，这样字形是原生栅格化而不是位图拉伸
    let fs = 13.0 * scale as f32;
    let look = Look { font_size: fs, line_height_ratio: 1.5, padding: s(18), ..Look::default() };
    let mut fonts = FontPair::load(
        &PathBuf::from(FONTS).join("CascadiaMono.ttf"),
        &PathBuf::from(FONTS).join("msyh.ttc"),
        look.font_size,
        look.line_height_ratio,
    )?;

    let inner_w = main_w - s(2);
    let inner_h = term_h - s(2);
    let cols = ((inner_w as f32 - look.padding as f32 * 2.0) / fonts.advance).floor() as usize;
    let rows = ((inner_h as f32 - look.padding as f32 * 2.0) / fonts.line_height).floor() as usize;

    let mut term = Terminal::new(cols, rows);
    run_live_session(&mut term, cols, rows)?;

    let (tw, th) = frame_size(term.cols(), term.rows(), &fonts, &look);
    let frame = render(term.inner(), &palette, &mut fonts, &look, tw, th, &Default::default());
    blit(&mut buf, cw, ch, main_x, term_y, &frame.pixels, frame.width, frame.height);

    // 右侧面板
    let rp_x = cw as i32 - right_w - gap;
    round_rect(&mut buf, cw, ch, rp_x, sb_y, right_w, sb_h, sh.raised, sh.edge_light, s(14));
    // 文件树占位条
    for (i, w) in [96i32, 132, 116, 148, 104, 124].iter().enumerate() {
        let y = sb_y + s(44) + s(i as i32 * 26);
        fill_rect_solid(&mut buf, cw, ch, rp_x + s(18), y, s(*w), s(7), sh.faint.with_alpha(0x66));
    }

    // 上下文条里的标签页示意
    for (i, w) in [86i32, 72, 64].iter().enumerate() {
        let x = main_x + s(16) + s(i as i32 * 92);
        fill_rect_solid(&mut buf, cw, ch, x, sb_y + s(16), s(*w), s(7), sh.faint.with_alpha(0x88));
    }

    // 会话栏三行文字块示意
    for i in 0..3 {
        let y = sb_y + s(56) + s(i as i32 * 34);
        let w = [88i32, 104, 76][i];
        let c = if i == 0 { sh.text } else { sh.muted };
        fill_rect_solid(&mut buf, cw, ch, gap + s(22), y, s(w), s(7), c.with_alpha(0xcc));
    }
    // 会话栏分组标题
    fill_rect_solid(&mut buf, cw, ch, gap + s(16), sb_y + s(18), s(42), s(6), sh.faint.with_alpha(0x99));

    let path = PathBuf::from(&out);
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let img: image::RgbaImage =
        image::ImageBuffer::from_raw(cw as u32, ch as u32, buf).ok_or("缓冲区不匹配")?;
    img.save(&path).map_err(|e| format!("保存失败: {e}"))?;
    println!("已生成 {out}  ({cw}×{ch}) 终端 {cols}×{rows} 格");
    Ok(())
}

/// 起一个真实 PowerShell，跑几条命令，输出进终端网格。
fn run_live_session(term: &mut Terminal, cols: usize, rows: usize) -> Result<(), String> {
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let pair = native_pty_system()
        .openpty(PtySize { rows: rows as u16, cols: cols as u16, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;
    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.args(["-NoLogo", "-NoProfile", "-NoExit"]);
    cmd.cwd("D:\\4rchive\\Code\\SlateTerm");
    cmd.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn: {e}"))?;
    drop(pair.slave);

    let mut rd = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
    let mut wr = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut b = [0u8; 8192];
        while let Ok(n) = rd.read(&mut b) {
            if n == 0 || tx.send(b[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let drain = |rx: &mpsc::Receiver<Vec<u8>>, term: &mut Terminal, ms: u64| {
        let end = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < end {
            if let Ok(c) = rx.recv_timeout(Duration::from_millis(100)) {
                term.feed(&c);
            }
        }
    };

    drain(&rx, term, 2500);
    for c in [
        "git status --short",
        "cargo build --release",
        "Write-Host '中文渲染正常：终端、选择、粘连'",
    ] {
        let _ = wr.write_all(c.as_bytes());
        let _ = wr.write_all(b"\r");
        let _ = wr.flush();
        drain(&rx, term, 1300);
    }
    let _ = child.kill();
    Ok(())
}

fn fill(buf: &mut [u8], w: usize, h: usize, x: i32, y: i32, rw: i32, rh: i32, c: Rgba8) {
    slateterm_grid::font::fill_rect(buf, w, h, x, y, rw, rh, c);
}

/// 不透明填充，用于占位色块（不做 alpha 混合，避免叠在暗底上发灰）。
fn fill_rect_solid(
    buf: &mut [u8], w: usize, h: usize,
    x: i32, y: i32, rw: i32, rh: i32, c: Rgba8,
) {
    for py in y.max(0)..(y + rh).min(h as i32) {
        for px in x.max(0)..(x + rw).min(w as i32) {
            let i = (py as usize * w + px as usize) * 4;
            buf[i] = c.r;
            buf[i + 1] = c.g;
            buf[i + 2] = c.b;
            buf[i + 3] = 255;
        }
    }
}

fn round_rect(
    buf: &mut [u8], w: usize, h: usize,
    x: i32, y: i32, rw: i32, rh: i32,
    fill_c: Rgba8, border: Rgba8, radius: i32,
) {
    for py in y..(y + rh) {
        if py < 0 || py as usize >= h { continue; }
        for px in x..(x + rw) {
            if px < 0 || px as usize >= w { continue; }
            // 圆角判定
            let dx = if px < x + radius { x + radius - px }
                else if px > x + rw - radius { px - (x + rw - radius) } else { 0 };
            let dy = if py < y + radius { y + radius - py }
                else if py > y + rh - radius { py - (y + rh - radius) } else { 0 };
            let outside = dx * dx + dy * dy > radius * radius;
            if outside { continue; }
            let on_border = px <= x + 1 || px >= x + rw - 2 || py <= y + 1 || py >= y + rh - 2;
            let c = if on_border { border } else { fill_c };
            let idx = (py as usize * w + px as usize) * 4;
            slateterm_grid::font::blend(buf, idx, c, c.a);
        }
    }
}

fn fill_circle(buf: &mut [u8], w: usize, h: usize, cx: i32, cy: i32, r: i32, c: Rgba8) {
    for py in (cy - r)..=(cy + r) {
        for px in (cx - r)..=(cx + r) {
            if px < 0 || py < 0 || px as usize >= w || py as usize >= h { continue; }
            let dx = px - cx;
            let dy = py - cy;
            if dx * dx + dy * dy <= r * r {
                let idx = (py as usize * w + px as usize) * 4;
                slateterm_grid::font::blend(buf, idx, c, 255);
            }
        }
    }
}

fn blit(
    dst: &mut [u8], dw: usize, dh: usize,
    x: i32, y: i32,
    src: &[u8], sw: usize, sh: usize,
) {
    for sy in 0..sh {
        let dy = y + sy as i32;
        if dy < 0 || dy as usize >= dh { continue; }
        for sx in 0..sw {
            let dx = x + sx as i32;
            if dx < 0 || dx as usize >= dw { continue; }
            let si = (sy * sw + sx) * 4;
            let di = (dy as usize * dw + dx as usize) * 4;
            dst[di] = src[si];
            dst[di + 1] = src[si + 1];
            dst[di + 2] = src[si + 2];
            dst[di + 3] = 255;
        }
    }
}
