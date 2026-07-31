# Changelog

## Unreleased

- Restore startup layout preference when `rememberLayout` is enabled.
- Reduce startup-time hard crashes by replacing `expect(...)` with recoverable diagnostics.
- Add native URL and clipboard integration, named workspaces, command palette/history, and PowerShell command blocks.
- Make the terminal the primary workspace surface, with the file tree acting as project context and file previews opening as an optional overlay.
- Add verified workspace CWD creation for shell and Claude Code sessions instead of silently falling back to an unrelated directory.
- Unify Claude Code image attachment entry points: detect Claude even when launched manually from a shell; smart `Ctrl+V`, Windows clipboard history (DIB, registered PNG, or DOM image data), and single image file drops trigger Claude's Windows `Alt+V` attachment action, while ordinary file drops and `Ctrl+Shift+V`/`Shift+Insert` retain explicit path paste. JPG, JPEG, WebP, and GIF drops are converted to real PNG data before attachment.
- Expose Shell/Claude runtime and running/exited/error state in tabs and the active workspace context bar.
- Keep the title bar single-line at medium window widths, replace character icons with accessible SVG controls, and rename the completion hint to Slate Suggestion.
- Remove naturally exited PTY sessions from the backend manager and cap each structured command block at 1,000,000 characters while preserving full terminal scrollback.
- Add a compact persistent pane header for runtime, status, title, CWD, block access, and split-pane close controls.
- Move command blocks into a responsive, non-overlay right-side drawer; simplify project navigation and unify command, history, settings, and file-preview dialog styling across dark and Paper themes.
- Standardize dependency installation, frontend builds, and Tauri build hooks on pnpm.

## v0.1.1 - 2026-03-29

- Finalized the SlateTerm rename release.
- Bumped the app version to `0.1.1` across the main release manifests.
- Verified the frontend build and Rust checks for the release.
- Published tag `v0.1.1` and the matching GitHub Release.
