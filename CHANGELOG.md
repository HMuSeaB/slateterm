# Changelog

## Unreleased

## v0.1.2 - 2026-08-03

- Add folder-first workspaces, named workspace restore, verified session CWD creation, command palette/history, PowerShell command blocks, and responsive split-pane controls.
- Restore complete Shell and Claude Code profiles, active panes, and runtime state after restarting or reopening a saved workspace.
- Route native Windows file drops to the pane under the pointer; insert Explorer files and folders as quoted absolute paths while keeping clipboard images available as Claude Code attachments.
- Add file-tree context actions for opening or revealing items in Windows File Explorer and starting a terminal from the selected directory.
- Add interactive `cd` directory suggestions for ordinary shell sessions with keyboard and pointer selection.
- Refine Graphite and Paper themes with softer tactile surfaces, rounded controls, improved scrollbars, responsive drawers, and consistent dialogs.
- Fix Windows taskbar identity and icon rendering with a stable AppUserModelID, explicit window icon assignment, and a multi-size ICO.
- Improve startup diagnostics and frontend resource tracking to avoid stale or empty embedded assets.
- Stabilize frontend build filenames and preserve Rust compiler temporary files so intercepted cleanup does not flood the Windows Recycle Bin.
- Standardize dependency installation, frontend builds, and Tauri build hooks on pnpm.

## v0.1.1 - 2026-03-29

- Finalized the SlateTerm rename release.
- Bumped the app version to `0.1.1` across the main release manifests.
- Verified the frontend build and Rust checks for the release.
- Published tag `v0.1.1` and the matching GitHub Release.
