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
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub cursor_style: String,
    pub default_profile_id: String,
    pub remember_layout: bool,
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
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
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
pub struct ErrorEvent {
    pub session_id: String,
    pub message: String,
}

struct ShellLaunch {
    label: String,
    command: String,
    args: Vec<String>,
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
        if let Some(claude_profile) = discover_claude_profile(&preferred_shell) {
            profiles.push(claude_profile);
        }
    }
    profiles
}

fn discover_shell_profiles() -> (Profile, Vec<Profile>) {
    if let Some(path) = find_command_path(&["pwsh.exe", "pwsh"]) {
        let preferred = Profile {
            id: "pwsh".into(),
            name: "PowerShell 7".into(),
            command: path,
            args: vec!["-NoLogo".into()],
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
                args: vec!["-NoLogo".into()],
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
                args: vec!["-NoLogo".into()],
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

fn discover_claude_profile(shell: &Profile) -> Option<Profile> {
    if shell.id == "cmd" {
        return None;
    }

    let executable = find_command_path(&["claude.exe", "claude.cmd", "claude"])?;
    let launch = ShellLaunch {
        label: shell.name.clone(),
        command: shell.command.clone(),
        args: shell.args.clone(),
    };

    let mut args = launch.args;
    args.push("-NoExit".into());
    args.push("-Command".into());
    args.push(powershell_invocation(&executable));

    Some(Profile {
        id: "claude".into(),
        name: "Claude Code".into(),
        command: launch.command,
        args,
        cwd: None,
        category: "ai".into(),
        description: format!("Claude Code via {}", launch.label),
        featured: true,
    })
}

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
