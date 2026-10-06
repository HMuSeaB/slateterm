//! slateterm-attach：在另一个终端窗口（例如 UU 远程打开的终端）里
//! 连到 SlateTerm 正在运行的 Claude 会话，看得到输出，也能直接打字。
//!
//! 用法：
//!   slateterm-attach            只有一个会话时直接连，多个时列出来选
//!   slateterm-attach <序号|id>  直接连指定会话
//!   slateterm-attach --list     只列出会话
//! 连上后按 Ctrl+] 断开，SlateTerm 里的会话不受影响。

#[path = "../remote_protocol.rs"]
mod remote_protocol;

use std::{
    io::{self, BufRead, Read, Write},
    time::Duration,
};

use remote_protocol::*;
use tokio::{
    io::{AsyncWriteExt, WriteHalf},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    sync::mpsc,
};
use windows_sys::Win32::System::Console::{
    GetConsoleCP, GetConsoleMode, GetConsoleOutputCP, GetStdHandle, ReadConsoleW, SetConsoleCP,
    SetConsoleMode, SetConsoleOutputCP, CONSOLE_MODE, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT,
    ENABLE_PROCESSED_INPUT, ENABLE_PROCESSED_OUTPUT, ENABLE_VIRTUAL_TERMINAL_INPUT,
    ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WINDOW_INPUT, ENABLE_MOUSE_INPUT,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};

/// Ctrl+]，和 telnet 一样的断开键；Ctrl+C 要原样交给 Claude。
const DETACH_KEY: u8 = 0x1d;
const UTF8_CODE_PAGE: u32 = 65001;

enum Event {
    Input(Vec<u8>),
    Detach,
    Closed(String),
}

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(message) => {
            eprintln!("slateterm-attach: {message}");
            1
        }
    };
    std::process::exit(code);
}

fn run() -> Result<i32, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("用法：slateterm-attach [序号|会话id] [--list]\n连上后按 Ctrl+] 断开。");
        return Ok(0);
    }
    let list_only = args.iter().any(|arg| arg == "--list");
    let selector = args.iter().find(|arg| !arg.starts_with('-')).cloned();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|error| format!("无法启动运行时：{error}"))?;
    runtime.block_on(attach(selector, list_only))
}

async fn attach(selector: Option<String>, list_only: bool) -> Result<i32, String> {
    let info = read_connection_info()?;
    let pipe = open_pipe(&info.pipe).await?;
    let (mut reader, mut writer) = tokio::io::split(pipe);

    write_json(&mut writer, C2S_HELLO, &Hello { token: info.token, version: PROTOCOL_VERSION })
        .await
        .map_err(|error| format!("握手失败：{error}"))?;
    expect_frame(&mut reader, S2C_READY).await?;

    write_frame(&mut writer, C2S_LIST, b"").await.map_err(|error| error.to_string())?;
    let payload = expect_frame(&mut reader, S2C_LIST).await?;
    let sessions: Vec<RemoteSessionInfo> = parse_json(&payload).map_err(|error| error.to_string())?;

    if sessions.is_empty() {
        println!("SlateTerm 里现在没有可连接的 Claude 会话。");
        return Ok(1);
    }
    if list_only {
        print_sessions(&sessions);
        return Ok(0);
    }
    let Some(target) = choose_session(&sessions, selector.as_deref())? else {
        return Ok(0);
    };

    write_json(&mut writer, C2S_ATTACH, &AttachRequest { session_id: target.id.clone() })
        .await
        .map_err(|error| error.to_string())?;
    let payload = expect_frame(&mut reader, S2C_ATTACHED).await?;
    let attached: Attached = parse_json(&payload).map_err(|error| error.to_string())?;

    let console = ConsoleGuard::enter_raw()?;
    let mut stdout = io::stdout();
    let title = attached.title.as_deref().unwrap_or("Claude");
    // Claude Code 跑在备用屏上，Windows 控制台对备用屏没有回滚缓冲，所以这边
    // 往上滚不动——想看历史得回 SlateTerm 窗口。先说清楚，免得以为是自己卡了。
    let _ = write!(
        stdout,
        "\x1b]0;SlateTerm · {title}\x07\x1b[2m[slateterm] 已连接 {title}（{}x{}）· Ctrl+] 断开 · 可正常打字，但上滚不了，历史请回 SlateTerm\x1b[0m\r\n",
        attached.cols, attached.rows
    );
    let _ = stdout.flush();

    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<Event>();
    spawn_stdin_reader(events_tx.clone());

    let output_tx = events_tx.clone();
    tokio::spawn(async move {
        let mut stdout = io::stdout();
        loop {
            match read_frame(&mut reader).await {
                Ok(Some((S2C_OUTPUT, payload))) => {
                    if stdout.write_all(&payload).and_then(|_| stdout.flush()).is_err() {
                        let _ = output_tx.send(Event::Closed("本地输出失败".into()));
                        return;
                    }
                }
                Ok(Some((S2C_RESIZE, _))) => {}
                Ok(Some((S2C_ENDED, _))) => {
                    let _ = output_tx.send(Event::Closed("SlateTerm 里的会话已结束".into()));
                    return;
                }
                Ok(Some((S2C_ERROR, payload))) => {
                    let _ = output_tx.send(Event::Closed(error_message(&payload)));
                    return;
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    let _ = output_tx.send(Event::Closed("SlateTerm 断开了连接".into()));
                    return;
                }
                Err(error) => {
                    let _ = output_tx.send(Event::Closed(format!("连接出错：{error}")));
                    return;
                }
            }
        }
    });
    drop(events_tx);

    let reason = loop {
        match events_rx.recv().await {
            Some(Event::Input(data)) => {
                if send_input(&mut writer, &data).await.is_err() {
                    break "SlateTerm 断开了连接".to_string();
                }
            }
            Some(Event::Detach) => break "已断开，SlateTerm 里的会话继续运行".to_string(),
            Some(Event::Closed(reason)) => break reason,
            None => break "输入已关闭".to_string(),
        }
    };

    drop(console);
    let _ = writer.shutdown().await;
    println!("\r\n\x1b[0m[slateterm] {reason}");
    Ok(0)
}

async fn send_input(writer: &mut WriteHalf<NamedPipeClient>, data: &[u8]) -> io::Result<()> {
    write_frame(writer, C2S_INPUT, data).await
}

fn read_connection_info() -> Result<ConnectionInfo, String> {
    let path = connection_info_path().map_err(|error| error.to_string())?;
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        "SlateTerm 没有开启远程连接。请在 SlateTerm 的设置或命令面板里打开 \"Remote attach\"。".to_string()
    })?;
    serde_json::from_str(&raw).map_err(|error| format!("{} 格式不对：{error}", path.display()))
}

async fn open_pipe(pipe: &str) -> Result<NamedPipeClient, String> {
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PIPE_BUSY: i32 = 231;
    for _ in 0..50 {
        match ClientOptions::new().open(pipe) {
            Ok(client) => return Ok(client),
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND) => {
                return Err("找不到 SlateTerm 的远程管道，SlateTerm 可能已经关闭或关掉了远程连接。".into());
            }
            Err(error) => return Err(format!("无法连接 SlateTerm：{error}")),
        }
    }
    Err("SlateTerm 的远程管道一直忙，稍后再试。".into())
}

async fn expect_frame(
    reader: &mut tokio::io::ReadHalf<NamedPipeClient>,
    expected: u8,
) -> Result<Vec<u8>, String> {
    match read_frame(reader).await {
        Ok(Some((kind, payload))) if kind == expected => Ok(payload),
        Ok(Some((S2C_ERROR, payload))) => Err(error_message(&payload)),
        Ok(Some((kind, _))) => Err(format!("SlateTerm 返回了意外的消息（{kind}）")),
        Ok(None) => Err("SlateTerm 断开了连接".into()),
        Err(error) => Err(format!("读取失败：{error}")),
    }
}

fn error_message(payload: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(payload)
        .ok()
        .and_then(|value| value.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(payload).into_owned())
}

fn session_label(session: &RemoteSessionInfo) -> String {
    let title = session.title.as_deref().unwrap_or("Claude");
    match session.cwd.as_deref() {
        Some(cwd) => format!("{title}  ·  {cwd}"),
        None => title.to_string(),
    }
}

fn print_sessions(sessions: &[RemoteSessionInfo]) {
    for (index, session) in sessions.iter().enumerate() {
        println!("  [{}] {}", index + 1, session_label(session));
    }
}

fn choose_session<'a>(
    sessions: &'a [RemoteSessionInfo],
    selector: Option<&str>,
) -> Result<Option<&'a RemoteSessionInfo>, String> {
    if let Some(selector) = selector {
        let by_index = selector
            .parse::<usize>()
            .ok()
            .and_then(|index| index.checked_sub(1))
            .and_then(|index| sessions.get(index));
        let by_id = || sessions.iter().find(|session| session.id.starts_with(selector));
        return by_index
            .or_else(by_id)
            .map(Some)
            .ok_or_else(|| format!("没有找到会话：{selector}"));
    }
    if sessions.len() == 1 {
        return Ok(sessions.first());
    }

    println!("SlateTerm 里有这些 Claude 会话：");
    print_sessions(sessions);
    print!("选择序号（回车取消）：");
    let _ = io::stdout().flush();
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line).map_err(|error| error.to_string())?;
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    line.parse::<usize>()
        .ok()
        .and_then(|index| index.checked_sub(1))
        .and_then(|index| sessions.get(index))
        .map(Some)
        .ok_or_else(|| format!("序号无效：{line}"))
}

/// 标准输入单独开线程读：控制台读取是阻塞调用。
fn spawn_stdin_reader(events: mpsc::UnboundedSender<Event>) {
    std::thread::spawn(move || {
        let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        let mut mode: CONSOLE_MODE = 0;
        let is_console = unsafe { GetConsoleMode(handle, &mut mode) } != 0;
        let mut pending_surrogate: Option<u16> = None;
        let mut stdin = io::stdin();
        let mut wide = [0u16; 1024];
        let mut bytes = [0u8; 4096];

        loop {
            let data: Vec<u8> = if is_console {
                // ReadConsoleW 直接拿 UTF-16，中文输入法上屏的字不会被代码页弄乱
                let mut read = 0u32;
                let ok = unsafe {
                    ReadConsoleW(handle, wide.as_mut_ptr().cast(), wide.len() as u32, &mut read, std::ptr::null())
                };
                if ok == 0 || read == 0 {
                    let _ = events.send(Event::Closed("输入已关闭".into()));
                    return;
                }
                let mut units: Vec<u16> = pending_surrogate.take().into_iter().collect();
                units.extend_from_slice(&wide[..read as usize]);
                // 代理对被拆在两次读取之间时，留半个到下一轮
                if let Some(&last) = units.last() {
                    if (0xD800..0xDC00).contains(&last) {
                        pending_surrogate = units.pop();
                    }
                }
                String::from_utf16_lossy(&units).into_bytes()
            } else {
                match stdin.read(&mut bytes) {
                    Ok(0) | Err(_) => {
                        let _ = events.send(Event::Closed("输入已关闭".into()));
                        return;
                    }
                    Ok(read) => bytes[..read].to_vec(),
                }
            };

            if let Some(position) = data.iter().position(|byte| *byte == DETACH_KEY) {
                if position > 0 {
                    let _ = events.send(Event::Input(data[..position].to_vec()));
                }
                let _ = events.send(Event::Detach);
                return;
            }
            if !data.is_empty() && events.send(Event::Input(data)).is_err() {
                return;
            }
        }
    });
}

/// 把控制台切成原始 VT 模式，退出时还原（包括出错退出）。
struct ConsoleGuard {
    input: Option<(windows_sys::Win32::Foundation::HANDLE, CONSOLE_MODE)>,
    output: Option<(windows_sys::Win32::Foundation::HANDLE, CONSOLE_MODE)>,
    code_pages: (u32, u32),
}

impl ConsoleGuard {
    fn enter_raw() -> Result<Self, String> {
        unsafe {
            let input_handle = GetStdHandle(STD_INPUT_HANDLE);
            let output_handle = GetStdHandle(STD_OUTPUT_HANDLE);
            let code_pages = (GetConsoleCP(), GetConsoleOutputCP());
            let mut guard = Self { input: None, output: None, code_pages };

            let mut mode: CONSOLE_MODE = 0;
            if GetConsoleMode(input_handle, &mut mode) != 0 {
                // 关掉行缓冲、回显和 Ctrl+C 处理，方向键等按 VT 序列送出
                let raw = (mode
                    & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT | ENABLE_WINDOW_INPUT | ENABLE_MOUSE_INPUT))
                    | ENABLE_VIRTUAL_TERMINAL_INPUT;
                if SetConsoleMode(input_handle, raw) == 0 {
                    return Err("这个终端不支持 VT 输入（需要 Windows 10 1809 以上）".into());
                }
                guard.input = Some((input_handle, mode));
            }

            let mut mode: CONSOLE_MODE = 0;
            if GetConsoleMode(output_handle, &mut mode) != 0 {
                SetConsoleMode(output_handle, mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
                guard.output = Some((output_handle, mode));
            }

            SetConsoleCP(UTF8_CODE_PAGE);
            SetConsoleOutputCP(UTF8_CODE_PAGE);
            Ok(guard)
        }
    }
}

impl Drop for ConsoleGuard {
    fn drop(&mut self) {
        unsafe {
            if let Some((handle, mode)) = self.input {
                SetConsoleMode(handle, mode);
            }
            if let Some((handle, mode)) = self.output {
                SetConsoleMode(handle, mode);
            }
            SetConsoleCP(self.code_pages.0);
            SetConsoleOutputCP(self.code_pages.1);
        }
        // Claude 可能开着备用屏、隐藏了光标，把它们还原
        let mut stdout = io::stdout();
        let _ = stdout.write_all(b"\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1004l\x1b[0m");
        let _ = stdout.flush();
    }
}
