export type ProfileCategory = "shell" | "ai";

export type Profile = {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string | null;
  category: ProfileCategory;
  description: string;
  featured: boolean;
};

export type CursorStyle = "block" | "underline" | "bar";
export type ThemeMode = "graphite" | "paper";

export type StartupLayout = {
  paneCount: 1 | 2;
  splitRatio: number;
};

export type SavedPaneState = {
  profileId: string;
  cwd?: string | null;
  sizeRatio?: number;
  title?: string;
};

export type SavedTabState = {
  profileId: string;
  title?: string;
  panes: SavedPaneState[];
};

export type WorkspaceState = {
  tabs: SavedTabState[];
  activeTabIndex: number;
};

export type NamedWorkspace = {
  id: string;
  name: string;
  state: WorkspaceState;
  updatedAt: string;
};

export type Settings = {
  theme: ThemeMode;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  defaultProfileId: string;
  rememberLayout: boolean;
  startupLayout: StartupLayout;
  lastCwd?: string | null;
  workspaceRoot?: string | null;
  savedState?: WorkspaceState | null;
  namedWorkspaces?: NamedWorkspace[];
};

export type Pane = {
  id: string;
  sessionId: string;
  sizeRatio: number;
  title?: string;
  cwd?: string;
};

export type Tab = {
  id: string;
  profileId: string;
  title: string;
  panes: Pane[];
  activePaneId: string;
};

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type FilePreview = {
  path: string;
  content: string;
  truncated: boolean;
};

export type CreateSessionResponse = {
  sessionId: string;
};

export type OutputEvent = {
  sessionId: string;
  chunk: string;
};

export type ExitEvent = {
  sessionId: string;
  exitCode: number;
};

export type TitleEvent = {
  sessionId: string;
  title?: string | null;
};

export type CwdEvent = {
  sessionId: string;
  cwd: string;
};

export type CommandBlockEvent = {
  sessionId: string;
  blockId: string;
  phase: "started" | "output" | "finished";
  command?: string | null;
  output?: string | null;
  cwd?: string | null;
  exitCode?: number | null;
};

export type CommandBlock = {
  id: string;
  command: string;
  output: string;
  cwd?: string;
  exitCode?: number | null;
  status: "running" | "finished";
};

export type ErrorEvent = {
  sessionId: string;
  message: string;
};
