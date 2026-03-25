use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
    thread,
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_FAILED},
    System::Threading::{
        GetExitCodeProcess, OpenProcess, TerminateProcess, WaitForSingleObject, INFINITE,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    },
};

use crate::models::{
    default_profiles, CreateSessionResponse, ErrorEvent, ExitEvent, OutputEvent, TitleEvent,
};

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
}

struct Session {
    pid: u32,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(
        &self,
        app: AppHandle,
        profile_id: String,
        cols: u16,
        rows: u16,
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
        if let Some(cwd) = profile.cwd {
            command.cwd(cwd);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| err.to_string())?;
        let pid = child.process_id().unwrap_or_default();
        drop(child);
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|err| err.to_string())?;
        let writer = pair.master.take_writer().map_err(|err| err.to_string())?;

        let session_id = Uuid::new_v4().to_string();
        let reader_session_id = session_id.clone();
        let monitor_session_id = session_id.clone();
        let app_for_reader = app.clone();

        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
                        let _ = app_for_reader.emit(
                            "terminal/output",
                            OutputEvent {
                                session_id: reader_session_id.clone(),
                                chunk: chunk.clone(),
                            },
                        );
                        for title in extract_titles(&chunk) {
                            let _ = app_for_reader.emit(
                                "terminal/title",
                                TitleEvent {
                                    session_id: reader_session_id.clone(),
                                    title: Some(title),
                                },
                            );
                        }
                    }
                    Err(err) => {
                        let _ = app_for_reader.emit(
                            "terminal/error",
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
            thread::spawn(move || match wait_for_exit(pid) {
                Ok(code) => {
                    let _ = app_for_exit.emit(
                        "terminal/exit",
                        ExitEvent {
                            session_id: monitor_session_id.clone(),
                            exit_code: code,
                        },
                    );
                }
                Err(err) => {
                    let _ = app_for_exit.emit(
                        "terminal/error",
                        ErrorEvent {
                            session_id: monitor_session_id.clone(),
                            message: err,
                        },
                    );
                }
            });
        }

        self.sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned".to_string())?
            .insert(
                session_id.clone(),
                Session {
                    pid,
                    master: pair.master,
                    writer,
                },
            );

        Ok(CreateSessionResponse { session_id })
    }

    pub fn write_input(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned".to_string())?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|err| err.to_string())?;
        session.writer.flush().map_err(|err| err.to_string())
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
            .map_err(|err| err.to_string())
    }

    pub fn close_session(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned".to_string())?
            .remove(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        if session.pid != 0 {
            terminate_pid(session.pid)?;
        }
        Ok(())
    }
}

fn extract_titles(chunk: &str) -> Vec<String> {
    let mut titles = Vec::new();
    let bytes = chunk.as_bytes();
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == 0x1b
            && bytes.get(index + 1) == Some(&b']')
            && bytes.get(index + 2) == Some(&b'0')
            && bytes.get(index + 3) == Some(&b';')
        {
            let start = index + 4;
            let mut end = start;
            while end < bytes.len() && bytes[end] != 0x07 {
                end += 1;
            }

            if end < bytes.len() {
                titles.push(String::from_utf8_lossy(&bytes[start..end]).trim().to_string());
                index = end + 1;
                continue;
            }
        }
        index += 1;
    }

    titles.into_iter().filter(|title| !title.is_empty()).collect()
}

fn wait_for_exit(pid: u32) -> Result<i32, String> {
    unsafe {
        const SYNCHRONIZE_ACCESS: u32 = 0x00100000;
        let handle: HANDLE = OpenProcess(SYNCHRONIZE_ACCESS | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return Err(format!("Failed to monitor process {pid}"));
        }

        let wait_result = WaitForSingleObject(handle, INFINITE);
        if wait_result == WAIT_FAILED {
            CloseHandle(handle);
            return Err(format!("Failed while waiting on process {pid}"));
        }

        let mut exit_code = 0u32;
        if GetExitCodeProcess(handle, &mut exit_code) == 0 {
            CloseHandle(handle);
            return Err(format!("Failed to get exit code for process {pid}"));
        }

        CloseHandle(handle);
        Ok(exit_code as i32)
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


