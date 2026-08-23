const HISTORY_STORAGE_KEY = "slateterm_command_history";
const MAX_HISTORY_ITEMS = 500;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(history: string[]) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)));
  } catch (error) {
    console.error("Failed to save command history", error);
  }
}

let historyCache: string[] | null = null;

export function getHistory(): string[] {
  if (!historyCache) {
    historyCache = loadHistory();
  }
  return historyCache;
}

export function recordCommand(command: string) {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length < 2) return;

  const current = getHistory();
  const next = [trimmed, ...current.filter((item) => item !== trimmed)].slice(0, MAX_HISTORY_ITEMS);
  historyCache = next;
  saveHistory(next);
  window.dispatchEvent(new CustomEvent("slateterm:history-change", { detail: next }));
}

export function searchHistory(query: string, limit = 100) {
  const normalized = query.trim().toLowerCase();
  const source = getHistory();
  if (!normalized) {
    return source.slice(0, limit);
  }
  return source
    .filter((command) => command.toLowerCase().includes(normalized))
    .slice(0, limit);
}

export function clearHistory() {
  historyCache = [];
  saveHistory([]);
  window.dispatchEvent(new CustomEvent("slateterm:history-change", { detail: [] }));
}
