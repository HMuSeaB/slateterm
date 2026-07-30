import { invoke } from "@tauri-apps/api/core";
import type {
  CreateSessionResponse,
  Profile,
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

export async function createSession(profileId: string, cols: number, rows: number, cwd?: string | null) {
  return invoke<CreateSessionResponse>("create_session", { profileId, cols, rows, cwd: cwd || null });
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

export async function saveTempImage(bytes: Uint8Array) {
  return invoke<string>("save_temp_image", { bytes: Array.from(bytes) });
}

export async function openExternalUrl(url: string) {
  return invoke<void>("open_external_url", { url });
}

export async function readClipboardText() {
  return invoke<string>("read_clipboard_text");
}

export async function writeClipboardText(text: string) {
  return invoke<void>("write_clipboard_text", { text });
}
