import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NamedWorkspace } from "../lib/types";

type Props = {
  anchor: { x: number; y: number };
  workspaces: NamedWorkspace[];
  activeWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
  onSaveCurrent: () => void;
  onClose: () => void;
};

export default function WorkspaceSwitcher({
  anchor,
  workspaces,
  activeWorkspaceId,
  onSelect,
  onSaveCurrent,
  onClose,
}: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeIndexRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(() => {
    const currentIndex = workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId);
    return currentIndex >= 0 ? currentIndex : 0;
  });
  activeIndexRef.current = activeIndex;

  const itemCount = workspaces.length + 1;

  useEffect(() => {
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => (current + direction + itemCount) % itemCount);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const index = activeIndexRef.current;
        if (index < workspaces.length) {
          onClose();
          onSelect(workspaces[index].id);
          return;
        }
        onClose();
        onSaveCurrent();
      }
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose, onSelect, onSaveCurrent, workspaces, itemCount]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - bounds.height - 8))}px`;
  }, [anchor]);

  return createPortal(
    <div
      ref={menuRef}
      className="workspace-switcher"
      style={{ left: anchor.x, top: anchor.y }}
      role="menu"
      aria-label="Switch saved workspace"
    >
      <div className="workspace-switcher-heading">Saved workspaces</div>
      {workspaces.length === 0 && (
        <div className="workspace-switcher-empty">No saved workspaces yet.</div>
      )}
      {workspaces.map((workspace, index) => (
        <button
          key={workspace.id}
          type="button"
          role="menuitem"
          className={index === activeIndex ? "is-active" : ""}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => {
            onClose();
            onSelect(workspace.id);
          }}
        >
          <span aria-hidden="true">{workspace.id === activeWorkspaceId ? "●" : "○"}</span>
          <div>
            <strong>{workspace.name}</strong>
            <small>{workspace.state.tabs.length} tabs · {new Date(workspace.updatedAt).toLocaleString()}</small>
          </div>
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        className={workspaces.length === activeIndex ? "is-active" : ""}
        onMouseEnter={() => setActiveIndex(workspaces.length)}
        onClick={() => {
          onClose();
          onSaveCurrent();
        }}
      >
        <span aria-hidden="true">＋</span>
        <div>
          <strong>Save current as workspace…</strong>
          <small>Snapshot the open tabs and directories</small>
        </div>
      </button>
      <div
        className="workspace-switcher-hint"
      >
        Ctrl + Alt + ← / → cycles workspaces
      </div>
    </div>,
    document.body,
  );
}
