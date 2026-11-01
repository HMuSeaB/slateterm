//! 端到端验证：起一个真实 PowerShell，跑一串命令，把输出画成 PNG。
//!
//! 这一步才是真正的考验——预设文本好看不算数，
//! 真实 powerline 提示符、真实 ANSI 序列、真实中文路径都要能画对。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};

use slateterm_grid::font::FontPair;
use slateterm_grid::palette::Palette;
use slateterm_grid::render::{Look, Terminal, frame_size, render};

const WINDOWS_FONTS: &str = r"C:\Windows\Fonts";

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let out = args.get(1).cloned().unwrap_or_else(|| "out/live.png".into());
    let mode = args.get(2).cloned().unwrap_or_else(|| "dark".into());

    let look = Look { font_size: 13.0, line_height_ratio: 1.45, padding: 16, ..Look::default() };
    let palette = if mode == "light" { Palette::paper_light() } else { Palette::amber_dark() };
    let mut fonts = FontPair::load(
        &PathBuf::from(WINDOWS_FONTS).join("CascadiaMono.ttf"),
        &PathBuf::from(WINDOWS_FONTS).join("msyh.ttc"),
        look.font_size,
        look.line_height_ratio,
    )?;

    // 先按格数建终端，再让 PTY 用同样的行列，避免换行错位
    let cols = 100usize;
    let rows = 36usize;
    let mut term = Terminal::new(cols, rows);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows as u16,
            cols: cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty 失败: {e}"))?;

    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");
    cmd.arg("-NoProfile");
    cmd.arg("-NoExit");
    cmd.cwd("D:\\4rchive\\Code\\SlateTerm");
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("启动 shell 失败: {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("取 reader 失败: {e}"))?;
    let mut writer = pair.master.take_writer().map_err(|e| format!("取 writer 失败: {e}"))?;

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // 等提示符出来
    let deadline = Instant::now() + Duration::from_secs(12);
    let mut fed_any = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(chunk) => {
                term.feed(&chunk);
                fed_any = true;
                if fed_any {
                    break;
                }
            }
            Err(_) => {
                if fed_any {
                    break;
                }
            }
        }
    }

    let commands = [
        "Get-Location",
        "git status --short",
        "Get-ChildItem | Select-Object -First 6 Name, Length",
        "Write-Host '中文输出测试：终端渲染层 SlateTerm grid'",
        "",
    ];
    for c in commands {
        // Windows 的 PSReadLine 只认 \r，发 \r\n 会多出一个续行提示符 ">>"
        if !c.is_empty() {
            let _ = writer.write_all(c.as_bytes());
            let _ = writer.write_all(b"\r");
            let _ = writer.flush();
            let settle = Instant::now() + Duration::from_millis(1600);
            while Instant::now() < settle {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(120)) {
                    term.feed(&chunk);
                }
            }
            continue;
        }
        let _ = writer.write_all(b"\r");
    }

    // 收尾：把剩余输出排干净
    let tail = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < tail {
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(chunk) => term.feed(&chunk),
            Err(_) => {}
        }
    }

    let (w, h) = frame_size(term.cols(), term.rows(), &fonts, &look);
    let frame = render(term.inner(), &palette, &mut fonts, &look, w, h);

    let path = PathBuf::from(&out);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    frame.save_png(&path)?;
    println!("已生成 {out}  ({w}×{h})");

    let _ = child.kill();
    Ok(())
}
