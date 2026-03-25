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

export async function createSession(profileId: string, cols: number, rows: number) {
  return invoke<CreateSessionResponse>("create_session", { profileId, cols, rows });
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
