# Changelog

## Unreleased

## v1.0.0 - 2026-08-04

- Add Claude path attachment chips that collect dropped files and folders for the next prompt while ordinary shells continue to receive quoted paths directly.
- Add persistent terminal tab reordering with Windows-friendly pointer capture, clear insertion feedback, and saved workspace ordering.
- Refine the workspace file tree with SVG file-type icons, animated directory chevrons, hierarchy guides, keyboard-only focus rings, cached empty folders, and retryable loading states.
- Keep reliable Shell and Claude profile restoration, pane-aware native file drops, clipboard image attachments, command history, command palette, PowerShell command blocks, and named workspaces from the 0.1 series.
- Publish SlateTerm under the MIT License and add a reproducible GitHub Actions Windows release workflow.
- Remove personal workstation identifiers from repository history and use a GitHub noreply identity for published commits and tags.

## v0.1.2 - 2026-08-03

- Add folder-first workspaces, named workspace restore, verified session CWD creation, command palette/history, PowerShell command blocks, and responsive split-pane controls.
- Restore complete Shell and Claude Code profiles, active panes, and runtime state after restarting or reopening a saved workspace.
- Route native Windows file drops to the pane under the pointer; insert Explorer files and folders as quoted absolute paths while keeping clipboard images available as Claude Code attachments.
- Add file-tree context actions for opening or revealing items in Windows File Explorer and starting a terminal from the selected directory.
- Add interactive `cd` directory suggestions for ordinary shell sessions with keyboard and pointer selection.
- Refine Graphite and Paper themes with softer tactile surfaces, rounded controls, improved scrollbars, responsive drawers, and consistent dialogs.
- Fix Windows taskbar identity and icon rendering with a stable AppUserModelID, explicit window icon assignment, and a multi-size ICO.
- Improve startup diagnostics and frontend resource tracking to avoid stale or empty embedded assets.
- Stabilize frontend build filenames to avoid accumulating stale hashed assets between builds.
- Standardize dependency installation, frontend builds, and Tauri build hooks on pnpm.

## v0.1.1 - 2026-03-29

- Finalized the SlateTerm rename release.
- Bumped the app version to `0.1.1` across the main release manifests.
- Verified the frontend build and Rust checks for the release.
- Published tag `v0.1.1` and the matching GitHub Release.
