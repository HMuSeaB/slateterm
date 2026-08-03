# SlateTerm

Local-first Windows terminal built with Tauri, Rust, React, and xterm.js.

![SlateTerm hero](docs/hero.svg)

SlateTerm is a local-first, workspace-aware AI terminal for Windows. It keeps the terminal as the primary surface while adding project context, visible AI runtime state, and native Windows integration around local AI coding tools.

## Current Focus

- Windows-first, workspace-aware AI terminal
- Terminal-dominant xterm.js workflow with optional PowerShell command blocks
- Claude Code sessions with visible runtime state and workspace CWD
- PowerShell 7 and Command Prompt as first-class local shells
- Native-feeling tabs, split panes, project context, image attachments, search, copy/paste, and local settings

## Stack

- Tauri 2
- Rust
- React
- Vite
- xterm.js
- ConPTY via `portable-pty`

## Snapshot

![SlateTerm workspace preview](docs/workspace.svg)

Highlights:

- Fast shell-first startup with Claude Code available as a first-class AI runtime
- PowerShell 7 and Command Prompt as primary local shell targets
- Persistent Shell/Claude status in tabs and the active workspace context bar
- Native-feeling tabs, split panes, named workspaces, command palette, and local settings persistence
- PowerShell Shell Integration for structured command blocks, CWD tracking, and exit status

## What Works Today

- Open a shell tab from the top launcher
- Split the active tab into two panes
- Resize panes with the splitter
- Search terminal output
- Open terminal URLs with Ctrl+click in the default browser
- Use smart `Ctrl+V` while Claude Code is running: SlateTerm detects Claude even when it was started manually from a shell, pastes text normally, and routes images through Claude's Windows `Alt+V` action
- Pick an image from Windows clipboard history to attach it directly while Claude Code is running
- Drag one PNG, JPG, JPEG, WebP, GIF, or BMP image into a pane running Claude Code to create an image attachment; non-PNG/BMP files are safely converted before attachment and other dropped files remain terminal paths
- Use `Ctrl+Shift+V` or `Shift+Insert` to explicitly paste clipboard text or an image file path in ordinary shells
- Open workspace-aware shell or Claude Code tabs with the selected folder as their verified working directory
- Save and restore named workspaces
- Search, copy, and replay command history from the command palette
- Inspect, collapse, copy, and rerun PowerShell command blocks in a non-blocking right-side drawer
- Read each pane's runtime, session status, title, and working directory from a compact persistent pane header
- Use consistent keyboard-dismissable command, history, settings, and file-preview overlays
- Persist theme, font, cursor, and startup shell settings locally
- Launch, continue, or resume `Claude Code` when it is installed on the machine

## Deliberate Non-Goals For This MVP

- No account system
- No cloud sync
- No cloud-hosted AI runtime; SlateTerm integrates local AI terminal tools instead
- No plugin system
- No cross-platform scope yet

## Development

Requirements:

- Node.js 20 or newer
- pnpm 10 or newer (`corepack enable` can provide it with supported Node.js installations)
- Rust toolchain
- Tauri prerequisites for Windows
- PowerShell 7 recommended

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Run the desktop app in development:

```bash
pnpm tauri dev
```

Run only the Vite frontend:

```bash
pnpm dev
```

Build the frontend bundle:

```bash
pnpm build
```

Build the desktop application:

```bash
pnpm tauri build
```

## Repository Notes

- pnpm is the required JavaScript package manager; `pnpm-lock.yaml` is the only dependency lock file.
- The repo ignores local build output such as `node_modules`, `dist`, and `src-tauri/target`.
- Current app version is `0.1.2`.
- Startup remains optimized around opening a local shell quickly, while AI runtimes are treated as visible, workspace-aware terminal sessions.

## Near-Term Direction

- Make startup feel faster and quieter on Windows
- Keep the top toolbar clean and low-friction
- Improve scroll behavior and pane ergonomics
- Refine shell and AI profile handling without bloating the UI

