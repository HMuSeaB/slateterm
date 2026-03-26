# SlateTerm

Local-first Windows terminal built with Tauri, Rust, React, and xterm.js.

![SlateTerm hero](docs/hero.svg)

SlateTerm started as a reaction to cloud-first terminal products that feel heavy, require sign-in, or drift too far from a traditional shell workflow. The goal is simple: keep the terminal local, fast enough to use every day, and pleasant to look at on Windows.

## Current Focus

- Windows-first desktop shell
- Traditional terminal flow instead of command blocks
- PowerShell 7 and Command Prompt as primary built-in shells
- Optional `Claude Code` entry without turning the whole app into an AI product
- Native-feeling terminal window with tabs, split panes, search, copy/paste, and local settings

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

- Shell-first startup so the app becomes usable before optional AI tooling matters
- PowerShell 7 and Command Prompt as the main launch targets
- `Claude Code` kept as an optional entry instead of the center of the whole product
- Native-feeling tabs, split panes, search, and local settings persistence

## What Works Today

- Open a shell tab from the top launcher
- Split the active tab into two panes
- Resize panes with the splitter
- Search terminal output
- Copy and paste with terminal-friendly shortcuts
- Persist theme, font, cursor, and startup shell settings locally
- Launch `Claude Code` from the same shell environment when it is installed on the machine

## Deliberate Non-Goals For This MVP

- No account system
- No cloud sync
- No AI-first workflow replacing the shell
- No plugin system
- No cross-platform scope yet

## Development

Requirements:

- Node.js
- Rust toolchain
- Tauri prerequisites for Windows
- PowerShell 7 recommended

Install dependencies:

```bash
npm install
```

Run the desktop app in development:

```bash
npm run tauri dev
```

Build the frontend bundle:

```bash
npm run build
```

Build the desktop application:

```bash
npm run tauri build
```

## Repository Notes

- The repo ignores local build output such as `node_modules`, `dist`, and `src-tauri/target`.
- Current app version is `0.1.0`.
- Startup is optimized around opening a shell quickly first; extra AI tooling should stay optional and minimal.

## Near-Term Direction

- Make startup feel faster and quieter on Windows
- Keep the top toolbar clean and low-friction
- Improve scroll behavior and pane ergonomics
- Refine shell and AI profile handling without bloating the UI

