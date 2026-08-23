import { invoke } from "@tauri-apps/api/core";
import type {
  CreateSessionResponse,
  FileEntry,
  FilePreview,
  Profile,
  ProxySettings,
  Settings,
} from "./types";

export async function listProfiles() {
  return invoke<Profile[]>("list_profiles");
}

export async function listShellProfiles() {
  return invoke<Profile[]>("list_shell_profiles");
}

export async function loadSettings() {
  return invoke<Settings>("load_settings");
}

export async function saveSettings(settings: Settings) {
  return invoke<void>("save_settings", { settings });
}

export async function selectWorkspaceFolder() {
  return invoke<string | null>("select_workspace_folder");
}

export async function listDirectory(path: string) {
  return invoke<FileEntry[]>("list_directory", { path });
}

export async function readTextFile(path: string) {
  return invoke<FilePreview>("read_text_file", { path });
}

export async function createSession(
  profileId: string,
  cols: number,
  rows: number,
  cwd?: string | null,
  proxy?: ProxySettings | null,
) {
  return invoke<CreateSessionResponse>("create_session", {
    profileId,
    cols,
    rows,
    cwd: cwd || null,
    proxy: proxy || null,
  });
}

export async function writeInput(sessionId: string, data: string) {
  return invoke<void>("write_input", { sessionId, data });
}

export async function resizeSession(sessionId: string, cols: number, rows: number) {
  return invoke<void>("resize_session", { sessionId, cols, rows });
}

export async function closeSession(sessionId: string) {
  return invoke<void>("close_session", { sessionId });
}

export async function saveTempImage(bytes: Uint8Array, extension?: string) {
  return invoke<string>("save_temp_image", { bytes: Array.from(bytes), extension: extension || null });
}

export async function readImageFile(path: string) {
  return invoke<number[]>("read_image_file", { path }).then((bytes) => new Uint8Array(bytes));
}

export async function openExternalUrl(url: string) {
  return invoke<void>("open_external_url", { url });
}

export async function revealInFileExplorer(path: string) {
  return invoke<void>("reveal_in_file_explorer", { path });
}

export async function readClipboardText() {
  return invoke<string>("read_clipboard_text");
}

export async function clipboardHasImage() {
  return invoke<boolean>("clipboard_has_image");
}

export async function readClipboardImage() {
  return invoke<string | null>("read_clipboard_image");
}

export async function writeClipboardImageFile(path: string) {
  return invoke<void>("write_clipboard_image_file", { path });
}

export async function writeClipboardText(text: string) {
  return invoke<void>("write_clipboard_text", { text });
}
