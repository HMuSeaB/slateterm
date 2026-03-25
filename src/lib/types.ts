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

export type Settings = {
  theme: ThemeMode;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  defaultProfileId: string;
  rememberLayout: boolean;
};

export type Pane = {
  id: string;
  sessionId: string;
  sizeRatio: number;
  title?: string;
};

export type Tab = {
  id: string;
  profileId: string;
  title: string;
  panes: Pane[];
  activePaneId: string;
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

export type ErrorEvent = {
  sessionId: string;
  message: string;
};
