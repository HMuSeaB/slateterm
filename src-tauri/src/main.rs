#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod pty;
mod settings;

use models::{default_profiles, shell_profiles, CreateSessionResponse, Profile, Settings};
use pty::SessionManager;
use tauri::{AppHandle, Manager, State};

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
) -> Result<CreateSessionResponse, String> {
    state.sessions.create_session(app, profile_id, cols, rows)
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
            close_session
        ]);

    if let Err(error) = app.run(tauri::generate_context!()) {
        eprintln!("SlateTerm failed to run: {error}");
    }
}
