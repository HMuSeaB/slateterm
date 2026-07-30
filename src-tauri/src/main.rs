#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod pty;
mod settings;

use models::{
    default_profiles, shell_profiles, CreateSessionResponse, FileEntry, FilePreview, Profile,
    Settings,
};
use pty::SessionManager;
use std::{ptr, thread, time::Duration};
use tauri::{AppHandle, Manager, State};
use windows_sys::Win32::{
    Foundation::GlobalFree,
    System::{
        Com::CoTaskMemFree,
        DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
            OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
        Ole::{CF_DIB, CF_DIBV5, CF_UNICODETEXT},
    },
    UI::{
        Shell::{
            SHBrowseForFolderW, SHGetPathFromIDListW, ShellExecuteW, BIF_NEWDIALOGSTYLE,
            BIF_RETURNONLYFSDIRS, BROWSEINFOW,
        },
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
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

fn temp_image_path(extension: &str) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    Ok(std::env::temp_dir().join(format!("slateterm_img_{timestamp}.{extension}")))
}

#[tauri::command]
fn save_temp_image(bytes: Vec<u8>, extension: Option<String>) -> Result<String, String> {
    let extension = extension
        .as_deref()
        .filter(|value| matches!(*value, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"))
        .unwrap_or("png");
    let file_path = temp_image_path(extension)?;
    std::fs::write(&file_path, bytes).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[tauri::command]
fn select_workspace_folder() -> Result<Option<String>, String> {
    let title = wide_null("Choose a SlateTerm workspace folder");
    let mut display_name = [0u16; 260];
    let browse_info = BROWSEINFOW {
        hwndOwner: ptr::null_mut(),
        pidlRoot: ptr::null_mut(),
        pszDisplayName: display_name.as_mut_ptr(),
        lpszTitle: title.as_ptr(),
        ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
        lpfn: None,
        lParam: 0,
        iImage: 0,
    };
    let item_id = unsafe { SHBrowseForFolderW(&browse_info) };
    if item_id.is_null() {
        return Ok(None);
    }
    let mut path = [0u16; 260];
    let resolved = unsafe { SHGetPathFromIDListW(item_id, path.as_mut_ptr()) };
    unsafe { CoTaskMemFree(item_id as *const _) };
    if resolved == 0 {
        return Err("Windows could not resolve the selected folder".into());
    }
    let length = path
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(path.len());
    Ok(Some(String::from_utf16_lossy(&path[..length])))
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() {
        return Err("The requested path is not a directory".into());
    }
    let mut entries = std::fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if metadata.file_type().is_symlink() {
                return None;
            }
            Some(FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_directory: metadata.is_dir(),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    entries.truncate(500);
    Ok(entries)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<FilePreview, String> {
    const MAX_PREVIEW_BYTES: usize = 1024 * 1024;
    let file_path = std::path::Path::new(&path);
    if !file_path.is_file() {
        return Err("The requested path is not a file".into());
    }
    let bytes = std::fs::read(file_path).map_err(|error| error.to_string())?;
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err("Binary files cannot be previewed".into());
    }
    let truncated = bytes.len() > MAX_PREVIEW_BYTES;
    let visible = &bytes[..bytes.len().min(MAX_PREVIEW_BYTES)];
    Ok(FilePreview {
        path,
        content: String::from_utf8_lossy(visible).to_string(),
        truncated,
    })
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

fn png_file_to_dib(path: &std::path::Path) -> Result<Vec<u8>, String> {
    const MAX_IMAGE_DIMENSION: u32 = 16_384;
    const MAX_IMAGE_PIXELS: u64 = 100_000_000;

    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut decoder = png::Decoder::new(file);
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("Could not decode PNG image: {error}"))?;
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || info.width > MAX_IMAGE_DIMENSION
        || info.height > MAX_IMAGE_DIMENSION
        || u64::from(info.width) * u64::from(info.height) > MAX_IMAGE_PIXELS
    {
        return Err("The dropped image dimensions are not supported".into());
    }

    let mut decoded = vec![0; reader.output_buffer_size()];
    let output = reader
        .next_frame(&mut decoded)
        .map_err(|error| format!("Could not read PNG image pixels: {error}"))?;
    let pixels = &decoded[..output.buffer_size()];
    let width = output.width as usize;
    let height = output.height as usize;
    let row_bytes = width
        .checked_mul(4)
        .ok_or_else(|| "The dropped image is too large".to_string())?;
    let pixel_bytes = row_bytes
        .checked_mul(height)
        .ok_or_else(|| "The dropped image is too large".to_string())?;
    let mut dib = Vec::with_capacity(40 + pixel_bytes);

    dib.extend_from_slice(&40u32.to_le_bytes());
    dib.extend_from_slice(&(output.width as i32).to_le_bytes());
    dib.extend_from_slice(&(output.height as i32).to_le_bytes());
    dib.extend_from_slice(&1u16.to_le_bytes());
    dib.extend_from_slice(&32u16.to_le_bytes());
    dib.extend_from_slice(&0u32.to_le_bytes());
    dib.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
    dib.extend_from_slice(&0i32.to_le_bytes());
    dib.extend_from_slice(&0i32.to_le_bytes());
    dib.extend_from_slice(&0u32.to_le_bytes());
    dib.extend_from_slice(&0u32.to_le_bytes());

    let channels = output.color_type.samples();
    for source_y in (0..height).rev() {
        let row_start = source_y * width * channels;
        for x in 0..width {
            let offset = row_start + x * channels;
            let (red, green, blue, alpha) = match output.color_type {
                png::ColorType::Grayscale => {
                    let value = pixels[offset];
                    (value, value, value, 255)
                }
                png::ColorType::Rgb => {
                    (pixels[offset], pixels[offset + 1], pixels[offset + 2], 255)
                }
                png::ColorType::GrayscaleAlpha => {
                    let value = pixels[offset];
                    (value, value, value, pixels[offset + 1])
                }
                png::ColorType::Rgba => (
                    pixels[offset],
                    pixels[offset + 1],
                    pixels[offset + 2],
                    pixels[offset + 3],
                ),
                png::ColorType::Indexed => {
                    return Err("Could not expand the PNG color palette".into());
                }
            };
            let composite = |channel: u8| -> u8 {
                let alpha = u32::from(alpha);
                (((u32::from(channel) * alpha) + (255 * (255 - alpha))) / 255) as u8
            };
            dib.extend_from_slice(&[composite(blue), composite(green), composite(red), 0]);
        }
    }

    Ok(dib)
}

fn image_file_to_dib(path: &std::path::Path) -> Result<Vec<u8>, String> {
    if !path.is_file() {
        return Err("The dropped image path is not a file".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "png" => png_file_to_dib(path),
        "bmp" => {
            let bitmap = std::fs::read(path).map_err(|error| error.to_string())?;
            if bitmap.len() < 54 || &bitmap[..2] != b"BM" {
                return Err("The dropped BMP image is invalid".into());
            }
            Ok(bitmap[14..].to_vec())
        }
        _ => Err("Only PNG and BMP images can currently be attached by dragging".into()),
    }
}

fn set_clipboard_dib(dib: Vec<u8>) -> Result<(), String> {
    if dib.is_empty() {
        return Err("The dropped image contains no bitmap data".into());
    }
    with_open_clipboard(|| unsafe {
        if EmptyClipboard() == 0 {
            return Err("Could not clear clipboard".into());
        }
        let allocation = GlobalAlloc(GMEM_MOVEABLE, dib.len());
        if allocation.is_null() {
            return Err("Could not allocate clipboard image memory".into());
        }
        let pointer = GlobalLock(allocation);
        if pointer.is_null() {
            GlobalFree(allocation);
            return Err("Could not lock clipboard image memory".into());
        }
        ptr::copy_nonoverlapping(dib.as_ptr(), pointer as *mut u8, dib.len());
        GlobalUnlock(allocation);
        if SetClipboardData(CF_DIB as u32, allocation as *mut _).is_null() {
            GlobalFree(allocation);
            return Err("Could not write the dropped image to the clipboard".into());
        }
        Ok(())
    })
}

#[tauri::command]
fn write_clipboard_image_file(path: String) -> Result<(), String> {
    let dib = image_file_to_dib(std::path::Path::new(&path))?;
    set_clipboard_dib(dib)
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

fn png_clipboard_format() -> u32 {
    let format_name = wide_null("PNG");
    unsafe { RegisterClipboardFormatW(format_name.as_ptr()) }
}

#[tauri::command]
fn clipboard_has_image() -> Result<bool, String> {
    with_open_clipboard(|| unsafe {
        let png_format = png_clipboard_format();
        Ok(IsClipboardFormatAvailable(CF_DIBV5 as u32) != 0
            || IsClipboardFormatAvailable(CF_DIB as u32) != 0
            || (png_format != 0 && IsClipboardFormatAvailable(png_format) != 0))
    })
}

#[tauri::command]
fn read_clipboard_image() -> Result<Option<String>, String> {
    with_open_clipboard(|| unsafe {
        let format = if IsClipboardFormatAvailable(CF_DIBV5 as u32) != 0 {
            CF_DIBV5 as u32
        } else if IsClipboardFormatAvailable(CF_DIB as u32) != 0 {
            CF_DIB as u32
        } else {
            return Ok(None);
        };
        let handle = GetClipboardData(format);
        if handle.is_null() {
            return Ok(None);
        }
        let size = GlobalSize(handle as *mut _);
        if size < 40 {
            return Err("Clipboard image data is invalid".into());
        }
        let pointer = GlobalLock(handle as *mut _);
        if pointer.is_null() {
            return Err("Could not access clipboard image".into());
        }
        let dib = std::slice::from_raw_parts(pointer as *const u8, size);
        let header_size = u32::from_le_bytes(dib[0..4].try_into().unwrap()) as usize;
        let bit_count = u16::from_le_bytes(dib[14..16].try_into().unwrap()) as usize;
        let colors_used = u32::from_le_bytes(dib[32..36].try_into().unwrap()) as usize;
        let palette_entries = if colors_used > 0 {
            colors_used
        } else if bit_count <= 8 {
            1usize << bit_count
        } else {
            0
        };
        let pixel_offset = 14usize
            .checked_add(header_size)
            .and_then(|value| value.checked_add(palette_entries * 4))
            .ok_or_else(|| "Clipboard image is too large".to_string())?;
        let file_size = 14usize
            .checked_add(size)
            .ok_or_else(|| "Clipboard image is too large".to_string())?;
        let mut bitmap = Vec::with_capacity(file_size);
        bitmap.extend_from_slice(b"BM");
        bitmap.extend_from_slice(&(file_size as u32).to_le_bytes());
        bitmap.extend_from_slice(&[0u8; 4]);
        bitmap.extend_from_slice(&(pixel_offset as u32).to_le_bytes());
        bitmap.extend_from_slice(dib);
        GlobalUnlock(handle as *mut _);

        let file_path = temp_image_path("bmp")?;
        std::fs::write(&file_path, bitmap).map_err(|error| error.to_string())?;
        Ok(Some(file_path.to_string_lossy().to_string()))
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
            select_workspace_folder,
            list_directory,
            read_text_file,
            create_session,
            write_input,
            resize_session,
            close_session,
            save_temp_image,
            open_external_url,
            read_clipboard_text,
            clipboard_has_image,
            read_clipboard_image,
            write_clipboard_image_file,
            write_clipboard_text
        ]);

    if let Err(error) = app.run(tauri::generate_context!()) {
        eprintln!("SlateTerm failed to run: {error}");
    }
}
