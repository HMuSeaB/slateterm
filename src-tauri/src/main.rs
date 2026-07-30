#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod pty;
mod settings;

use models::{default_profiles, shell_profiles, CreateSessionResponse, Profile, Settings};
use pty::SessionManager;
use std::{ptr, thread, time::Duration};
use tauri::{AppHandle, Manager, State};
use windows_sys::Win32::{
    Foundation::GlobalFree,
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Ole::CF_UNICODETEXT,
    },
    UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
};

struct AppState {
    sessions: SessionManager,
    profiles: Vec<Profile>,
    shell_profiles: Vec<Profile>,
}

#[tauri::command]
fn list_profiles(state: State<AppState>) -> Vec<Profile> {
    state.profiles.clone()
}

#[tauri::command]
fn list_shell_profiles(state: State<AppState>) -> Vec<Profile> {
    state.shell_profiles.clone()
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Settings, String> {
    settings::load(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    settings::save(&app, &settings)
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<AppState>,
    profile_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<CreateSessionResponse, String> {
    state
        .sessions
        .create_session(app, profile_id, cols, rows, cwd)
}

#[tauri::command]
fn write_input(state: State<AppState>, session_id: String, data: String) -> Result<(), String> {
    state.sessions.write_input(&session_id, &data)
}

#[tauri::command]
fn resize_session(
    state: State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.sessions.resize_session(&session_id, cols, rows)
}

#[tauri::command]
fn close_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    state.sessions.close_session(&session_id)
}

#[tauri::command]
fn save_temp_image(bytes: Vec<u8>) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join(format!("slateterm_img_{timestamp}.png"));
    std::fs::write(&file_path, bytes).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http and https links can be opened".into());
    }

    let operation = wide_null("open");
    let target = wide_null(&url);
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;

    if result <= 32 {
        Err(format!("Windows could not open this link (code {result})"))
    } else {
        Ok(())
    }
}

fn with_open_clipboard<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    for _ in 0..8 {
        if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
            let result = operation();
            unsafe {
                CloseClipboard();
            }
            return result;
        }
        thread::sleep(Duration::from_millis(12));
    }
    Err("The Windows clipboard is currently busy".into())
}

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    with_open_clipboard(|| unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT as u32);
        if handle.is_null() {
            return Ok(String::new());
        }
        let pointer = GlobalLock(handle as *mut _);
        if pointer.is_null() {
            return Err("Could not access clipboard text".into());
        }
        let wide = pointer as *const u16;
        let mut length = 0usize;
        while *wide.add(length) != 0 {
            length += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(wide, length));
        GlobalUnlock(handle as *mut _);
        Ok(text)
    })
}

#[tauri::command]
fn write_clipboard_text(text: String) -> Result<(), String> {
    let wide = wide_null(&text);
    let byte_len = wide.len() * std::mem::size_of::<u16>();

    with_open_clipboard(|| unsafe {
        if EmptyClipboard() == 0 {
            return Err("Could not clear clipboard".into());
        }
        let allocation = GlobalAlloc(GMEM_MOVEABLE, byte_len);
        if allocation.is_null() {
            return Err("Could not allocate clipboard memory".into());
        }
        let pointer = GlobalLock(allocation);
        if pointer.is_null() {
            GlobalFree(allocation);
            return Err("Could not lock clipboard memory".into());
        }
        ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, pointer as *mut u8, byte_len);
        GlobalUnlock(allocation);
        if SetClipboardData(CF_UNICODETEXT as u32, allocation as *mut _).is_null() {
            GlobalFree(allocation);
            return Err("Could not write clipboard text".into());
        }
        Ok(())
    })
}

fn main() {
    let shell_profiles = shell_profiles();
    let profiles = default_profiles();

    let app = tauri::Builder::default()
        .manage(AppState {
            sessions: SessionManager::new(),
            profiles,
            shell_profiles,
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            } else {
                eprintln!("SlateTerm setup warning: main window was not available");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            list_shell_profiles,
            load_settings,
            save_settings,
            create_session,
            write_input,
            resize_session,
            close_session,
            save_temp_image,
            open_external_url,
            read_clipboard_text,
            write_clipboard_text
        ]);

    if let Err(error) = app.run(tauri::generate_context!()) {
        eprintln!("SlateTerm failed to run: {error}");
    }
}
