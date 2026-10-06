use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0},
    System::Threading::{
        GetExitCodeProcess, OpenProcess, TerminateProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    },
};

use crate::models::{
    default_profiles, CommandBlockEvent, CreateSessionResponse, CwdEvent, ErrorEvent, ExitEvent,
    OutputEvent, ProxyConfig, TitleEvent,
};
use crate::remote::RemoteHub;

/// Block-output events are merged on this interval instead of being emitted per
/// reader chunk; the terminal itself still receives every byte immediately.
const BLOCK_FLUSH_INTERVAL: Duration = Duration::from_millis(100);

pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    remote: Arc<RemoteHub>,
}

struct Session {
    pid: u32,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    stop_monitor: Arc<AtomicBool>,
}

impl SessionManager {
    pub fn new(remote: Arc<RemoteHub>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            remote,
        }
    }

    pub fn create_session(
        &self,
        app: AppHandle,
        profile_id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        proxy: Option<ProxyConfig>,
    ) -> Result<CreateSessionResponse, String> {
        let profile = default_profiles()
            .into_iter()
            .find(|candidate| candidate.id == profile_id)
            .ok_or_else(|| format!("Unknown profile: {profile_id}"))?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| err.to_string())?;

        let mut command = CommandBuilder::new(profile.command);
        for arg in profile.args {
            command.arg(arg);
        }
        if let Some(config) = proxy.filter(|candidate| candidate.enabled) {
            for (key, value) in config.env_pairs() {
                command.env(key, value);
            }
        }
        let resolved_cwd = if let Some(ref custom_cwd) = cwd {
            let path = Path::new(custom_cwd);
            if !path.is_dir() {
                return Err(format!(
                    "Terminal working directory is not a directory: {custom_cwd}"
                ));
            }
            command.cwd(custom_cwd);
            Some(custom_cwd.clone())
        } else if let Some(profile_cwd) = profile.cwd {
            command.cwd(&profile_cwd);
            Some(profile_cwd)
        } else {
            None
        };

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| err.to_string())?;
        let pid = child.process_id().unwrap_or_default();
        drop(child);
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| err.to_string())?;
        let writer = pair.master.take_writer().map_err(|err| err.to_string())?;

        let session_id = Uuid::new_v4().to_string();
        let stop_monitor = Arc::new(AtomicBool::new(false));
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(writer));
        // 远程镜像与本地共用同一个 writer 锁，两边的按键按到达顺序写入
        self.remote.register(
            &session_id,
            Arc::clone(&writer),
            cols,
            rows,
            resolved_cwd.clone(),
        );

        // Register before the reader/monitor threads start so no event can be
        // emitted for a session that is not in the map yet.
        if let Err(error) = self.sessions.lock().map(|mut sessions| {
            sessions.insert(
                session_id.clone(),
                Session {
                    pid,
                    master: pair.master,
                    writer,
                    stop_monitor: Arc::clone(&stop_monitor),
                },
            );
        }) {
            self.remote.unregister(&session_id);
            drop(reader);
            if pid != 0 {
                let _ = terminate_pid(pid);
            }
            let _ = error;
            return Err("Session manager lock poisoned".to_string());
        }

        let reader_session_id = session_id.clone();
        let app_for_reader = app.clone();
        let remote_for_reader = Arc::clone(&self.remote);

        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut byte_pending: Vec<u8> = Vec::with_capacity(16 * 1024);
            let mut parser = TerminalStreamParser::default();
            let mut block_buffer: Vec<TerminalSignal> = Vec::new();
            let mut last_block_flush = Instant::now();
            let remote = remote_for_reader;

            fn feed_text(
                app: &AppHandle,
                remote: &RemoteHub,
                session_id: &str,
                parser: &mut TerminalStreamParser,
                block_buffer: &mut Vec<TerminalSignal>,
                text: &str,
            ) {
                let parsed = parser.push(text);
                if !parsed.visible.is_empty() {
                    remote.record_output(session_id, &parsed.visible);
                    emit_terminal_output(app, session_id, parsed.visible);
                }
                for signal in parsed.signals {
                    match &signal {
                        TerminalSignal::Title(title) => remote.record_title(session_id, title),
                        TerminalSignal::Cwd(cwd) => remote.record_cwd(session_id, cwd),
                        _ => {}
                    }
                    if matches!(signal, TerminalSignal::BlockOutput { .. }) {
                        block_buffer.push(signal);
                    } else {
                        flush_block_outputs(app, session_id, block_buffer);
                        emit_terminal_signal(app, session_id, signal);
                    }
                }
            }

            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        if !byte_pending.is_empty() {
                            let text = String::from_utf8_lossy(&byte_pending).into_owned();
                            byte_pending.clear();
                            feed_text(
                                &app_for_reader,
                                &remote,
                                &reader_session_id,
                                &mut parser,
                                &mut block_buffer,
                                &text,
                            );
                        }
                        flush_block_outputs(&app_for_reader, &reader_session_id, &mut block_buffer);
                        if let Some(visible) = parser.finish() {
                            remote.record_output(&reader_session_id, &visible);
                            emit_terminal_output(&app_for_reader, &reader_session_id, visible);
                        }
                        break;
                    }
                    Ok(read) => {
                        byte_pending.extend_from_slice(&buffer[..read]);
                        // Incremental UTF-8 decoding: only complete characters are
                        // forwarded, so multi-byte characters split across reads
                        // survive instead of turning into U+FFFD garbage.
                        loop {
                            match std::str::from_utf8(&byte_pending) {
                                Ok(text) => {
                                    feed_text(
                                        &app_for_reader,
                                        &remote,
                                        &reader_session_id,
                                        &mut parser,
                                        &mut block_buffer,
                                        text,
                                    );
                                    byte_pending.clear();
                                    break;
                                }
                                Err(error) => {
                                    let valid = error.valid_up_to();
                                    if valid > 0 {
                                        let text = std::str::from_utf8(&byte_pending[..valid])
                                            .expect("prefix validated by from_utf8");
                                        feed_text(
                                            &app_for_reader,
                                            &remote,
                                            &reader_session_id,
                                            &mut parser,
                                            &mut block_buffer,
                                            text,
                                        );
                                        byte_pending.drain(..valid);
                                    }
                                    if let Some(invalid_len) = error.error_len() {
                                        feed_text(
                                            &app_for_reader,
                                            &remote,
                                            &reader_session_id,
                                            &mut parser,
                                            &mut block_buffer,
                                            "\u{FFFD}",
                                        );
                                        byte_pending.drain(..invalid_len);
                                        continue;
                                    }
                                    // Incomplete trailing sequence: keep the bytes and
                                    // wait for the next read.
                                    break;
                                }
                            }
                        }
                        if !block_buffer.is_empty()
                            && last_block_flush.elapsed() >= BLOCK_FLUSH_INTERVAL
                        {
                            flush_block_outputs(
                                &app_for_reader,
                                &reader_session_id,
                                &mut block_buffer,
                            );
                            last_block_flush = Instant::now();
                        }
                    }
                    Err(err) => {
                        flush_block_outputs(&app_for_reader, &reader_session_id, &mut block_buffer);
                        let _ = app_for_reader.emit(
                            &format!("terminal/error/{reader_session_id}"),
                            ErrorEvent {
                                session_id: reader_session_id.clone(),
                                message: format!("Terminal reader error: {err}"),
                            },
                        );
                        break;
                    }
                }
            }
        });

        if pid != 0 {
            let app_for_exit = app.clone();
            let sessions_for_exit = Arc::clone(&self.sessions);
            let remote_for_exit = Arc::clone(&self.remote);
            let monitor_session_id = session_id.clone();
            let stop_for_monitor = Arc::clone(&stop_monitor);
            thread::spawn(move || match wait_for_exit(pid, &stop_for_monitor) {
                Ok(Some(code)) => {
                    if let Ok(mut sessions) = sessions_for_exit.lock() {
                        sessions.remove(&monitor_session_id);
                    }
                    remote_for_exit.unregister(&monitor_session_id);
                    let _ = app_for_exit.emit(
                        &format!("terminal/exit/{monitor_session_id}"),
                        ExitEvent {
                            session_id: monitor_session_id.clone(),
                            exit_code: code,
                        },
                    );
                }
                // Session was closed explicitly; the monitor stops quietly.
                Ok(None) => {}
                Err(err) => {
                    let _ = app_for_exit.emit(
                        &format!("terminal/error/{monitor_session_id}"),
                        ErrorEvent {
                            session_id: monitor_session_id.clone(),
                            message: err,
                        },
                    );
                }
            });
        }

        Ok(CreateSessionResponse {
            session_id,
            cwd: resolved_cwd,
        })
    }

    pub fn write_input(&self, session_id: &str, data: &str) -> Result<(), String> {
        // Only the map lookup happens under the shared lock; the write itself
        // takes the per-session writer lock so one stalled child cannot freeze
        // resize/close or any other session's keystrokes.
        let writer = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Session manager lock poisoned".to_string())?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| "Session not found".to_string())?;
            Arc::clone(&session.writer)
        };

        let mut writer = writer
            .lock()
            .map_err(|_| "Session writer lock poisoned".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|err| err.to_string())?;
        writer.flush().map_err(|err| err.to_string())
    }

    pub fn resize_session(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned".to_string())?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| err.to_string())?;
        drop(sessions);
        self.remote.record_resize(session_id, cols, rows);
        Ok(())
    }

    pub fn close_session(&self, session_id: &str) -> Result<(), String> {
        let Some(session) = self
            .sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned".to_string())?
            .remove(session_id)
        else {
            return Ok(());
        };
        self.remote.unregister(session_id);

        // Stop the exit monitor before killing the child so it does not linger
        // in an infinite wait for a session the user already dismissed.
        session.stop_monitor.store(true, Ordering::Relaxed);
        if session.pid != 0 {
            terminate_pid(session.pid)?;
        }
        Ok(())
    }
}

fn flush_block_outputs(app: &AppHandle, session_id: &str, buffer: &mut Vec<TerminalSignal>) {
    if buffer.is_empty() {
        return;
    }

    let mut merged: Vec<TerminalSignal> = Vec::new();
    for signal in buffer.drain(..) {
        match merged.last_mut() {
            Some(TerminalSignal::BlockOutput {
                block_id: previous_id,
                chunk: previous_chunk,
            }) if matches!(&signal, TerminalSignal::BlockOutput { block_id, .. } if block_id == previous_id) =>
            {
                if let TerminalSignal::BlockOutput { chunk, .. } = signal {
                    previous_chunk.push_str(&chunk);
                }
            }
            _ => merged.push(signal),
        }
    }

    for signal in merged {
        emit_terminal_signal(app, session_id, signal);
    }
}

#[derive(Debug, PartialEq)]
enum TerminalSignal {
    Title(String),
    Cwd(String),
    BlockStarted {
        block_id: String,
        command: String,
        cwd: Option<String>,
    },
    BlockOutput {
        block_id: String,
        chunk: String,
    },
    BlockFinished {
        block_id: String,
        exit_code: Option<i32>,
    },
}

#[derive(Debug, Default, PartialEq)]
struct ParsedTerminalChunk {
    visible: String,
    signals: Vec<TerminalSignal>,
}

#[derive(Debug, Default)]
struct TerminalStreamParser {
    pending: String,
    current_cwd: Option<String>,
    active_block_id: Option<String>,
}

impl TerminalStreamParser {
    fn push(&mut self, chunk: &str) -> ParsedTerminalChunk {
        self.pending.push_str(chunk);
        let mut parsed = ParsedTerminalChunk::default();

        loop {
            let Some(start) = self.pending.find("\x1b]") else {
                let keep = if self.pending.ends_with('\x1b') { 1 } else { 0 };
                let emit_len = self.pending.len().saturating_sub(keep);
                if emit_len > 0 {
                    let visible = self.pending[..emit_len].to_string();
                    self.record_visible(&visible, &mut parsed);
                    self.pending.drain(..emit_len);
                }
                break;
            };

            if start > 0 {
                let visible = self.pending[..start].to_string();
                self.record_visible(&visible, &mut parsed);
                self.pending.drain(..start);
            }

            let Some((content_end, sequence_end)) = find_osc_terminator(&self.pending, 2) else {
                break;
            };

            let sequence = self.pending[..sequence_end].to_string();
            let content = self.pending[2..content_end].to_string();
            self.pending.drain(..sequence_end);

            if !self.handle_osc(&content, &mut parsed) {
                self.record_visible(&sequence, &mut parsed);
            }
        }

        parsed
    }

    fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }

    fn record_visible(&self, visible: &str, parsed: &mut ParsedTerminalChunk) {
        parsed.visible.push_str(visible);
        if let Some(block_id) = self.active_block_id.as_ref() {
            parsed.signals.push(TerminalSignal::BlockOutput {
                block_id: block_id.clone(),
                chunk: visible.to_string(),
            });
        }
    }

    fn handle_osc(&mut self, content: &str, parsed: &mut ParsedTerminalChunk) -> bool {
        if let Some(title) = content
            .strip_prefix("0;")
            .or_else(|| content.strip_prefix("2;"))
        {
            let title = title.trim();
            if !title.is_empty() {
                parsed
                    .signals
                    .push(TerminalSignal::Title(title.to_string()));
            }
            return false;
        }

        if let Some(uri) = content.strip_prefix("7;") {
            if let Some(cwd) = cwd_from_osc_uri(uri) {
                self.current_cwd = Some(cwd.clone());
                parsed.signals.push(TerminalSignal::Cwd(cwd));
            }
            return false;
        }

        let Some(marker) = content.strip_prefix("133;") else {
            return false;
        };

        if marker == "A" || marker == "B" {
            return true;
        }

        if let Some(command) = marker
            .strip_prefix("C;")
            .or_else(|| (marker == "C").then_some(""))
        {
            if let Some(block_id) = self.active_block_id.take() {
                parsed.signals.push(TerminalSignal::BlockFinished {
                    block_id,
                    exit_code: None,
                });
            }
            let block_id = Uuid::new_v4().to_string();
            self.active_block_id = Some(block_id.clone());
            parsed.signals.push(TerminalSignal::BlockStarted {
                block_id,
                command: command.to_string(),
                cwd: self.current_cwd.clone(),
            });
            return true;
        }

        if let Some(exit_code) = marker
            .strip_prefix("D;")
            .or_else(|| (marker == "D").then_some(""))
        {
            if let Some(block_id) = self.active_block_id.take() {
                parsed.signals.push(TerminalSignal::BlockFinished {
                    block_id,
                    exit_code: exit_code.parse::<i32>().ok(),
                });
            }
            return true;
        }

        true
    }
}

fn find_osc_terminator(input: &str, content_start: usize) -> Option<(usize, usize)> {
    let bytes = input.as_bytes();
    let mut index = content_start;
    while index < bytes.len() {
        if bytes[index] == 0x07 {
            return Some((index, index + 1));
        }
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
            return Some((index, index + 2));
        }
        index += 1;
    }
    None
}

fn cwd_from_osc_uri(uri: &str) -> Option<String> {
    let value = uri.trim();
    let path = if let Some(without_scheme) = value.strip_prefix("file://") {
        let slash = without_scheme.find('/');
        match slash {
            Some(index) => &without_scheme[index..],
            None => without_scheme,
        }
    } else {
        value
    };
    let path = if path.starts_with('/') && path.as_bytes().get(2) == Some(&b':') {
        &path[1..]
    } else {
        path
    };
    let path = path.replace('/', "\\");
    (!path.trim().is_empty()).then_some(path)
}

fn emit_terminal_output(app: &AppHandle, session_id: &str, chunk: String) {
    // Per-session event names: the frontend subscribes per pane, so output is
    // never fanned out to every other pane just to be filtered there.
    let _ = app.emit(
        &format!("terminal/output/{session_id}"),
        OutputEvent {
            session_id: session_id.to_string(),
            chunk,
        },
    );
}

fn emit_terminal_signal(app: &AppHandle, session_id: &str, signal: TerminalSignal) {
    match signal {
        TerminalSignal::Title(title) => {
            let _ = app.emit(
                &format!("terminal/title/{session_id}"),
                TitleEvent {
                    session_id: session_id.to_string(),
                    title: Some(title),
                },
            );
        }
        TerminalSignal::Cwd(cwd) => {
            let _ = app.emit(
                &format!("terminal/cwd/{session_id}"),
                CwdEvent {
                    session_id: session_id.to_string(),
                    cwd,
                },
            );
        }
        TerminalSignal::BlockStarted {
            block_id,
            command,
            cwd,
        } => {
            let _ = app.emit(
                &format!("terminal/block/{session_id}"),
                CommandBlockEvent {
                    session_id: session_id.to_string(),
                    block_id,
                    phase: "started".into(),
                    command: Some(command),
                    output: None,
                    cwd,
                    exit_code: None,
                },
            );
        }
        TerminalSignal::BlockOutput { block_id, chunk } => {
            let _ = app.emit(
                &format!("terminal/block/{session_id}"),
                CommandBlockEvent {
                    session_id: session_id.to_string(),
                    block_id,
                    phase: "output".into(),
                    command: None,
                    output: Some(chunk),
                    cwd: None,
                    exit_code: None,
                },
            );
        }
        TerminalSignal::BlockFinished {
            block_id,
            exit_code,
        } => {
            let _ = app.emit(
                &format!("terminal/block/{session_id}"),
                CommandBlockEvent {
                    session_id: session_id.to_string(),
                    block_id,
                    phase: "finished".into(),
                    command: None,
                    output: None,
                    cwd: None,
                    exit_code,
                },
            );
        }
    }
}

fn wait_for_exit(pid: u32, stop: &AtomicBool) -> Result<Option<i32>, String> {
    unsafe {
        const SYNCHRONIZE_ACCESS: u32 = 0x00100000;
        let handle: HANDLE = OpenProcess(
            SYNCHRONIZE_ACCESS | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if handle.is_null() {
            return Err(format!("Failed to monitor process {pid}"));
        }

        loop {
            if stop.load(Ordering::Relaxed) {
                CloseHandle(handle);
                return Ok(None);
            }
            let wait_result = WaitForSingleObject(handle, 200);
            if wait_result == WAIT_OBJECT_0 {
                break;
            }
            if wait_result == WAIT_FAILED {
                CloseHandle(handle);
                return Err(format!("Failed while waiting on process {pid}"));
            }
            // WAIT_TIMEOUT: poll the stop flag again.
        }

        let mut exit_code = 0u32;
        if GetExitCodeProcess(handle, &mut exit_code) == 0 {
            CloseHandle(handle);
            return Err(format!("Failed to get exit code for process {pid}"));
        }

        CloseHandle(handle);
        Ok(Some(exit_code as i32))
    }
}

fn terminate_pid(pid: u32) -> Result<(), String> {
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Ok(());
        }

        let result = TerminateProcess(handle, 1);
        CloseHandle(handle);
        if result == 0 {
            return Err(format!("Failed to terminate process {pid}"));
        }
    }
    Ok(())
}

#[cfg(test)]
fn strip_ansi(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut in_escape = false;
    for c in input.chars() {
        if c == '\x1b' {
            in_escape = true;
        } else if in_escape {
            if c.is_ascii_alphabetic() || c == '~' {
                in_escape = false;
            }
        } else {
            result.push(c);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{strip_ansi, TerminalSignal, TerminalStreamParser};

    #[test]
    fn strips_common_ansi_sequences() {
        assert_eq!(strip_ansi("\x1b[31merror\x1b[0m ready"), "error ready");
    }

    #[test]
    fn parses_shell_integration_across_chunks() {
        let mut parser = TerminalStreamParser::default();
        let first = parser.push("\x1b]7;file://localhost/C:/work\x07PS C:\\work> \x1b]133;B\x07");
        assert_eq!(
            first.visible,
            "\x1b]7;file://localhost/C:/work\x07PS C:\\work> "
        );
        assert_eq!(first.signals, vec![TerminalSignal::Cwd("C:\\work".into())]);

        let second = parser.push("\x1b]133;C;pnpm run dev");
        assert!(second.visible.is_empty());
        assert!(second.signals.is_empty());

        let third = parser.push("\x07\r\nready\r\n\x1b]133;D;0\x07");
        let block_id = match &third.signals[0] {
            TerminalSignal::BlockStarted {
                block_id,
                command,
                cwd,
            } => {
                assert_eq!(command, "pnpm run dev");
                assert_eq!(cwd.as_deref(), Some("C:\\work"));
                block_id.clone()
            }
            signal => panic!("unexpected signal: {signal:?}"),
        };
        assert_eq!(third.visible, "\r\nready\r\n");
        assert_eq!(
            third.signals[1],
            TerminalSignal::BlockOutput {
                block_id: block_id.clone(),
                chunk: "\r\nready\r\n".into(),
            }
        );
        assert_eq!(
            third.signals[2],
            TerminalSignal::BlockFinished {
                block_id,
                exit_code: Some(0),
            }
        );
    }

    #[test]
    fn preserves_unknown_and_display_osc_sequences() {
        let mut parser = TerminalStreamParser::default();
        let parsed = parser.push("before\x1b]0;SlateTerm\x07middle\x1b]9;custom\x07after");
        assert_eq!(
            parsed.visible,
            "before\x1b]0;SlateTerm\x07middle\x1b]9;custom\x07after"
        );
        assert_eq!(
            parsed.signals,
            vec![TerminalSignal::Title("SlateTerm".into())]
        );
    }
}
