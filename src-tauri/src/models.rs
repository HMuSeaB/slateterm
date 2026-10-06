use serde::{Deserialize, Serialize};
use std::{os::windows::process::CommandExt, process::Command};

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub category: String,
    pub description: String,
    pub featured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StartupLayout {
    pub pane_count: u8,
    pub split_ratio: f32,
}

impl Default for StartupLayout {
    fn default() -> Self {
        Self {
            pane_count: 1,
            split_ratio: 0.5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SavedPaneState {
    pub profile_id: String,
    pub cwd: Option<String>,
    pub size_ratio: f32,
    pub title: Option<String>,
}

impl Default for SavedPaneState {
    fn default() -> Self {
        Self {
            profile_id: "pwsh".into(),
            cwd: None,
            size_ratio: 1.0,
            title: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SavedTabState {
    pub profile_id: String,
    pub title: Option<String>,
    pub panes: Vec<SavedPaneState>,
    pub active_pane_index: usize,
}

impl Default for SavedTabState {
    fn default() -> Self {
        Self {
            profile_id: "pwsh".into(),
            title: None,
            panes: Vec::new(),
            active_pane_index: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceState {
    pub tabs: Vec<SavedTabState>,
    pub active_tab_index: usize,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            tabs: Vec::new(),
            active_tab_index: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NamedWorkspace {
    pub id: String,
    pub name: String,
    pub state: WorkspaceState,
    pub updated_at: String,
}

impl Default for NamedWorkspace {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Workspace".into(),
            state: WorkspaceState::default(),
            updated_at: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: "127.0.0.1".into(),
            port: 7890,
        }
    }
}

impl ProxyConfig {
    pub fn env_pairs(&self) -> Vec<(String, String)> {
        let url = format!("http://{}:{}", self.host, self.port);
        vec![
            ("HTTP_PROXY".into(), url.clone()),
            ("HTTPS_PROXY".into(), url.clone()),
            ("ALL_PROXY".into(), url.clone()),
            ("http_proxy".into(), url.clone()),
            ("https_proxy".into(), url.clone()),
            ("all_proxy".into(), url),
            ("NO_PROXY".into(), "localhost,127.0.0.1".into()),
            ("no_proxy".into(), "localhost,127.0.0.1".into()),
        ]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub cursor_style: String,
    pub default_profile_id: String,
    pub remember_layout: bool,
    pub startup_layout: StartupLayout,
    pub last_cwd: Option<String>,
    pub workspace_root: Option<String>,
    pub saved_state: Option<WorkspaceState>,
    pub named_workspaces: Vec<NamedWorkspace>,
    pub proxy: ProxyConfig,
    pub completion_sound: bool,
    pub remote_attach: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "graphite".into(),
            font_family: "JetBrainsMono Nerd Font, Cascadia Mono, Consolas, monospace".into(),
            font_size: 14,
            line_height: 1.28,
            cursor_style: "block".into(),
            default_profile_id: "pwsh".into(),
            remember_layout: true,
            startup_layout: StartupLayout::default(),
            last_cwd: None,
            workspace_root: None,
            saved_state: None,
            named_workspaces: Vec::new(),
            proxy: ProxyConfig::default(),
            completion_sound: true,
            remote_attach: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputEvent {
    pub session_id: String,
    pub chunk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitEvent {
    pub session_id: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleEvent {
    pub session_id: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdEvent {
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandBlockEvent {
    pub session_id: String,
    pub block_id: String,
    pub phase: String,
    pub command: Option<String>,
    pub output: Option<String>,
    pub cwd: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEvent {
    pub session_id: String,
    pub message: String,
}

struct ShellLaunch {
    label: String,
    command: String,
}

pub fn shell_profiles() -> Vec<Profile> {
    let (preferred_shell, mut shells) = discover_shell_profiles();
    let mut profiles = vec![preferred_shell];
    profiles.append(&mut shells);
    profiles
}

pub fn default_profiles() -> Vec<Profile> {
    let mut profiles = shell_profiles();
    if let Some(preferred_shell) = profiles.first().cloned() {
        profiles.extend(discover_claude_profiles(&preferred_shell));
    }
    profiles
}

fn discover_shell_profiles() -> (Profile, Vec<Profile>) {
    if let Some(path) = find_command_path(&["pwsh.exe", "pwsh"]) {
        let preferred = Profile {
            id: "pwsh".into(),
            name: "PowerShell 7".into(),
            command: path,
            args: powershell_shell_args(),
            cwd: None,
            category: "shell".into(),
            description: "Modern PowerShell for daily Windows work".into(),
            featured: true,
        };

        let mut shells = vec![Profile {
            id: "cmd".into(),
            name: "Command Prompt".into(),
            command: "cmd.exe".into(),
            args: vec![],
            cwd: None,
            category: "shell".into(),
            description: "Classic Windows command line".into(),
            featured: true,
        }];

        if let Some(legacy_path) = find_command_path(&["powershell.exe", "powershell"]) {
            shells.push(Profile {
                id: "powershell".into(),
                name: "Windows PowerShell".into(),
                command: legacy_path,
                args: powershell_shell_args(),
                cwd: None,
                category: "shell".into(),
                description: "Compatibility shell for older scripts".into(),
                featured: false,
            });
        }

        (preferred, shells)
    } else if let Some(path) = find_command_path(&["powershell.exe", "powershell"]) {
        (
            Profile {
                id: "powershell".into(),
                name: "Windows PowerShell".into(),
                command: path,
                args: powershell_shell_args(),
                cwd: None,
                category: "shell".into(),
                description: "Built-in PowerShell fallback".into(),
                featured: true,
            },
            vec![Profile {
                id: "cmd".into(),
                name: "Command Prompt".into(),
                command: "cmd.exe".into(),
                args: vec![],
                cwd: None,
                category: "shell".into(),
                description: "Classic Windows command line".into(),
                featured: true,
            }],
        )
    } else {
        (
            Profile {
                id: "cmd".into(),
                name: "Command Prompt".into(),
                command: "cmd.exe".into(),
                args: vec![],
                cwd: None,
                category: "shell".into(),
                description: "Classic Windows command line".into(),
                featured: true,
            },
            Vec::new(),
        )
    }
}

fn discover_claude_profiles(shell: &Profile) -> Vec<Profile> {
    if shell.id == "cmd" {
        return Vec::new();
    }

    let Some(executable) = find_command_path(&["claude.exe", "claude.cmd", "claude"]) else {
        return Vec::new();
    };
    let launch = ShellLaunch {
        label: shell.name.clone(),
        command: shell.command.clone(),
    };

    [
        (
            "claude",
            "Claude Code",
            "",
            "Start a new Claude Code conversation",
        ),
        (
            "claude-continue",
            "Continue Claude",
            " --continue",
            "Continue the latest conversation in this workspace",
        ),
        (
            "claude-resume",
            "Resume Claude",
            " --resume",
            "Choose a previous conversation to resume",
        ),
    ]
    .into_iter()
    .map(|(id, name, suffix, description)| {
        let args = vec![
            "-NoLogo".into(),
            "-NoExit".into(),
            "-Command".into(),
            format!("{}{suffix}", powershell_invocation(&executable)),
        ];
        Profile {
            id: id.into(),
            name: name.into(),
            command: launch.command.clone(),
            args,
            cwd: None,
            category: "ai".into(),
            description: format!("{description} via {}", launch.label),
            featured: true,
        }
    })
    .collect()
}

fn powershell_shell_args() -> Vec<String> {
    vec![
        "-NoLogo".into(),
        "-NoExit".into(),
        "-Command".into(),
        POWERSHELL_SHELL_INTEGRATION.into(),
    ]
}

const POWERSHELL_SHELL_INTEGRATION: &str = r#"
$global:SlateTermEsc = [char]27
$global:SlateTermBell = [char]7
$global:SlateTermCommandPending = $false
$global:SlateTermOriginalPrompt = (Get-Command prompt -CommandType Function).ScriptBlock
function global:prompt {
    $commandSucceeded = $?
    if ($global:SlateTermCommandPending) {
        $exitCode = if ($commandSucceeded) { 0 } elseif ($global:LASTEXITCODE -is [int] -and $global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } else { 1 }
        [Console]::Write("$($global:SlateTermEsc)]133;D;$exitCode$($global:SlateTermBell)")
        $global:SlateTermCommandPending = $false
    }
    [Console]::Write("$($global:SlateTermEsc)]133;A$($global:SlateTermBell)")
    $cwdPath = (Get-Location).Path.Replace('\\', '/')
    [Console]::Write("$($global:SlateTermEsc)]7;file://localhost/$cwdPath$($global:SlateTermBell)")
    $promptText = & $global:SlateTermOriginalPrompt
    [Console]::Write(($promptText -join ''))
    [Console]::Write("$($global:SlateTermEsc)]133;B$($global:SlateTermBell)")
    return ''
}
Import-Module PSReadLine -ErrorAction SilentlyContinue
if (Get-Module PSReadLine) {
    try { Set-PSReadLineOption -PredictionSource History -ErrorAction Stop } catch { }
    try { Set-PSReadLineOption -PredictionViewStyle InlineView -ErrorAction Stop } catch { }
    try { Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete -ErrorAction Stop } catch { }
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        param($key, $arg)
        $line = ''
        $cursor = 0
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        $global:SlateTermCommandPending = $true
        [Console]::Write("$($global:SlateTermEsc)]133;C;$line$($global:SlateTermBell)")
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}
"#;

fn find_command_path(candidates: &[&str]) -> Option<String> {
    for candidate in candidates {
        let Ok(output) = Command::new("where.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .arg(candidate)
            .output()
        else {
            continue;
        };

        if !output.status.success() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = stdout
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_string)
        {
            return Some(path);
        }
    }

    None
}

fn powershell_invocation(path: &str) -> String {
    format!("& '{}'", path.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::{SavedPaneState, SavedTabState};

    #[test]
    fn saved_tab_state_preserves_active_pane_index() {
        let tab = SavedTabState {
            profile_id: "claude".into(),
            title: Some("Claude Code".into()),
            panes: vec![SavedPaneState::default(), SavedPaneState::default()],
            active_pane_index: 1,
        };

        let json = serde_json::to_string(&tab).expect("serialize saved tab state");
        assert!(json.contains("\"activePaneIndex\":1"));

        let restored: SavedTabState =
            serde_json::from_str(&json).expect("deserialize saved tab state");
        assert_eq!(restored.active_pane_index, 1);
    }
}
