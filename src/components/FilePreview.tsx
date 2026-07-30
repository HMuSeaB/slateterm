import type { FilePreview as FilePreviewData } from "../lib/types";

type Props = {
  workspaceRoot?: string | null;
  preview?: FilePreviewData | null;
  error?: string | null;
  onChooseFolder: () => void;
  onOpenTerminal: () => void;
};

export default function FilePreview({ workspaceRoot, preview, error, onChooseFolder, onOpenTerminal }: Props) {
  if (!workspaceRoot) {
    return (
      <section className="editor-welcome">
        <span className="editor-welcome-mark">ST</span>
        <h1>Open a folder to start</h1>
        <p>Browse files, preview text, and run terminals in one local workspace.</p>
        <div>
          <button type="button" className="primary-button" onClick={onChooseFolder}>Choose folder</button>
          <button type="button" className="ghost-button" onClick={onOpenTerminal}>Open terminal</button>
        </div>
      </section>
    );
  }

  if (error) {
    return <section className="editor-message"><strong>Preview unavailable</strong><span>{error}</span></section>;
  }

  if (!preview) {
    return (
      <section className="editor-message">
        <strong>{workspaceRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0] || workspaceRoot}</strong>
        <span>Select a text file from the explorer, or open a terminal for this folder.</span>
      </section>
    );
  }

  return (
    <section className="file-preview">
      <header>
        <strong>{preview.path.split(/[\\/]/).pop()}</strong>
        <span>{preview.path}</span>
      </header>
      <pre>{preview.content}</pre>
      {preview.truncated && <footer>Preview limited to the first 1 MB.</footer>}
    </section>
  );
}
