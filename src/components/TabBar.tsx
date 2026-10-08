import clsx from "clsx";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { Tab } from "../lib/types";

type DropPlacement = "before" | "after";

type DropTarget = {
  tabId: string;
  placement: DropPlacement;
};

type PointerGesture = {
  tabId: string;
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  dragging: boolean;
  dropTarget: DropTarget | null;
};

type DragPreview = {
  x: number;
  y: number;
  title: string;
  detail: string;
  runtimeMode: "shell" | "claude";
};

type ContextMenuState = {
  tabId: string;
  x: number;
  y: number;
};

type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers?: (tabId: string) => void;
  onCloseToRight?: (tabId: string) => void;
  onReorder: (draggedTabId: string, targetTabId: string, placement: DropPlacement) => void;
  onNewTab?: () => void;
};

const DRAG_THRESHOLD = 5;
const EDGE_SCROLL_ZONE = 64;
const MIN_EDGE_SCROLL_SPEED = 4;
const MAX_EDGE_SCROLL_SPEED = 18;

export default function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onReorder,
  onNewTab,
}: Props) {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const tabbarRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pointerGestureRef = useRef<PointerGesture | null>(null);
  const edgeScrollFrameRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  function updateDropTarget(nextTarget: DropTarget | null) {
    const gesture = pointerGestureRef.current;
    if (gesture) {
      gesture.dropTarget = nextTarget;
    }
    setDropTarget((current) =>
      current?.tabId === nextTarget?.tabId && current?.placement === nextTarget?.placement
        ? current
        : nextTarget,
    );
  }

  function resolveDropTarget(clientX: number, clientY: number, draggedTabId: string) {
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>(".tab-pill[data-tab-id]");
    const targetTabId = target?.dataset.tabId;
    if (!target || !targetTabId || targetTabId === draggedTabId) {
      return null;
    }

    const bounds = target.getBoundingClientRect();
    return {
      tabId: targetTabId,
      placement: clientX < bounds.left + bounds.width / 2 ? "before" : "after",
    } satisfies DropTarget;
  }

  function stopEdgeScroll() {
    if (edgeScrollFrameRef.current !== null) {
      cancelAnimationFrame(edgeScrollFrameRef.current);
      edgeScrollFrameRef.current = null;
    }
  }

  function runEdgeScroll() {
    const gesture = pointerGestureRef.current;
    const tabbar = tabbarRef.current;
    if (!gesture?.dragging || !tabbar) {
      edgeScrollFrameRef.current = null;
      return;
    }

    const bounds = tabbar.getBoundingClientRect();
    const leftDistance = gesture.clientX - bounds.left;
    const rightDistance = bounds.right - gesture.clientX;
    let direction = 0;
    let intensity = 0;

    if (leftDistance >= 0 && leftDistance < EDGE_SCROLL_ZONE) {
      direction = -1;
      intensity = 1 - leftDistance / EDGE_SCROLL_ZONE;
    } else if (rightDistance >= 0 && rightDistance < EDGE_SCROLL_ZONE) {
      direction = 1;
      intensity = 1 - rightDistance / EDGE_SCROLL_ZONE;
    }

    if (direction !== 0) {
      const speed = MIN_EDGE_SCROLL_SPEED
        + (MAX_EDGE_SCROLL_SPEED - MIN_EDGE_SCROLL_SPEED) * intensity;
      const previousScrollLeft = tabbar.scrollLeft;
      tabbar.scrollLeft += direction * speed;
      if (tabbar.scrollLeft !== previousScrollLeft) {
        updateDropTarget(resolveDropTarget(gesture.clientX, gesture.clientY, gesture.tabId));
      }
    }

    edgeScrollFrameRef.current = requestAnimationFrame(runEdgeScroll);
  }

  function startEdgeScroll() {
    if (edgeScrollFrameRef.current === null) {
      edgeScrollFrameRef.current = requestAnimationFrame(runEdgeScroll);
    }
  }

  function clearPointerGesture(event?: PointerEvent<HTMLButtonElement>) {
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopEdgeScroll();
    pointerGestureRef.current = null;
    setDraggingTabId(null);
    setDropTarget(null);
    setDragPreview(null);
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>, tabId: string) {
    if (event.button === 1) {
      event.preventDefault();
      onClose(tabId);
      return;
    }
    if (event.button !== 0 || tabs.length < 2) {
      return;
    }

    suppressClickRef.current = false;
    setContextMenu(null);
    pointerGestureRef.current = {
      tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      dragging: false,
      dropTarget: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    gesture.clientX = event.clientX;
    gesture.clientY = event.clientY;

    if (!gesture.dragging) {
      const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (distance < DRAG_THRESHOLD) {
        return;
      }
      gesture.dragging = true;
      suppressClickRef.current = true;
      setDraggingTabId(gesture.tabId);
      startEdgeScroll();
    }

    const draggedTab = tabs.find((tab) => tab.id === gesture.tabId);
    const activePane = draggedTab?.panes.find((pane) => pane.id === draggedTab.activePaneId)
      ?? draggedTab?.panes[0];
    if (draggedTab && activePane) {
      setDragPreview({
        x: event.clientX,
        y: event.clientY,
        title: draggedTab.title,
        detail: activePane.sessionState === "running"
          ? activePane.runtimeMode === "claude" ? "AI" : "Shell"
          : activePane.sessionState,
        runtimeMode: activePane.runtimeMode,
      });
    }

    event.preventDefault();
    updateDropTarget(resolveDropTarget(event.clientX, event.clientY, gesture.tabId));
  }

  function handlePointerUp(event: PointerEvent<HTMLButtonElement>) {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    if (gesture.dragging) {
      event.preventDefault();
      event.stopPropagation();
      const finalTarget = resolveDropTarget(event.clientX, event.clientY, gesture.tabId)
        ?? gesture.dropTarget;
      if (finalTarget) {
        onReorder(gesture.tabId, finalTarget.tabId, finalTarget.placement);
      }
    }
    clearPointerGesture(event);
  }

  function handleTabClick(tabId: string) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSelect(tabId);
  }

  function moveTabToEdge(tabId: string, edge: "start" | "end") {
    const target = edge === "start" ? tabs[0] : tabs[tabs.length - 1];
    if (target && target.id !== tabId) {
      onReorder(tabId, target.id, edge === "start" ? "before" : "after");
    }
    setContextMenu(null);
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) {
    if (!event.ctrlKey || !event.shiftKey || (event.key !== "PageUp" && event.key !== "PageDown")) {
      return;
    }

    const currentIndex = tabs.findIndex((tab) => tab.id === tabId);
    const direction = event.key === "PageUp" ? -1 : 1;
    const target = tabs[currentIndex + direction];
    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onReorder(tabId, target.id, direction < 0 ? "before" : "after");
  }

  useEffect(() => stopEdgeScroll, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const closeMenu = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !contextMenu) {
      return;
    }
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(contextMenu.x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(contextMenu.y, window.innerHeight - bounds.height - 8))}px`;
  }, [contextMenu]);

  return (
    <>
      <nav ref={tabbarRef} className={clsx("tabbar", draggingTabId && "is-reordering")} aria-label="Terminal tabs">
        {tabs.map((tab) => {
          const activePane = tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
          const runtimeLabel = activePane?.runtimeMode === "claude" ? "AI" : "Shell";
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={clsx(
                "tab-pill",
                tab.id === activeTabId && "is-active",
                activePane?.runtimeMode === "claude" && "is-claude",
                tab.id === draggingTabId && "is-dragging",
                dropTarget?.tabId === tab.id && `is-drop-${dropTarget.placement}`,
              )}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab.id);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
              }}
            >
              <button
                type="button"
                className="tab-pill-main"
                title={`${tab.title} · Drag to reorder · Middle-click to close`}
                onClick={() => handleTabClick(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                onPointerDown={(event) => handlePointerDown(event, tab.id)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={(event) => clearPointerGesture(event)}
              >
                <span className={`tab-runtime-dot is-${activePane?.runtimeMode ?? "shell"}`} aria-hidden="true" />
                <span>{tab.title}</span>
                <small>{activePane?.sessionState === "running" ? runtimeLabel : activePane?.sessionState}</small>
              </button>
              <button type="button" className="tab-pill-close" aria-label={`Close ${tab.title}`} onClick={() => onClose(tab.id)}>×</button>
            </div>
          );
        })}

        {onNewTab && (
          <button
            type="button"
            className="tabbar-new-tab-button"
            title="New tab (Ctrl+T)"
            aria-label="New tab"
            onClick={onNewTab}
          >
            +
          </button>
        )}
      </nav>

      {dragPreview && createPortal(
        <div
          className={clsx("tab-drag-preview", dragPreview.runtimeMode === "claude" && "is-claude")}
          style={{ left: dragPreview.x + 14, top: dragPreview.y + 16 }}
          aria-hidden="true"
        >
          <span className={`tab-runtime-dot is-${dragPreview.runtimeMode}`} />
          <strong>{dragPreview.title}</strong>
          <small>{dragPreview.detail}</small>
        </div>,
        document.body,
      )}

      {contextMenu && createPortal(
        <div
          ref={menuRef}
          className="tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label="Tab actions"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            <span aria-hidden="true">✕</span>
            <div><strong>Close tab</strong><small>Close this terminal tab</small></div>
          </button>
          {onCloseOthers && (
            <button
              type="button"
              role="menuitem"
              disabled={tabs.length <= 1}
              onClick={() => {
                onCloseOthers(contextMenu.tabId);
                setContextMenu(null);
              }}
            >
              <span aria-hidden="true">⊘</span>
              <div><strong>Close other tabs</strong><small>Keep only this tab</small></div>
            </button>
          )}
          {onCloseToRight && (
            <button
              type="button"
              role="menuitem"
              disabled={tabs.findIndex((t) => t.id === contextMenu.tabId) >= tabs.length - 1}
              onClick={() => {
                onCloseToRight(contextMenu.tabId);
                setContextMenu(null);
              }}
            >
              <span aria-hidden="true">⇥</span>
              <div><strong>Close tabs to the right</strong><small>Close all tabs to the right</small></div>
            </button>
          )}
          <hr className="tab-context-menu-divider" />
          <button type="button" role="menuitem" disabled={tabs[0]?.id === contextMenu.tabId} onClick={() => moveTabToEdge(contextMenu.tabId, "start")}>
            <span aria-hidden="true">⇤</span>
            <div><strong>Move to first</strong><small>Place at the left edge</small></div>
          </button>
          <button type="button" role="menuitem" disabled={tabs[tabs.length - 1]?.id === contextMenu.tabId} onClick={() => moveTabToEdge(contextMenu.tabId, "end")}>
            <span aria-hidden="true">⇥</span>
            <div><strong>Move to last</strong><small>Place at the right edge</small></div>
          </button>
          <div className="tab-context-menu-hint">Ctrl + Shift + PageUp / PageDown</div>
        </div>,
        document.body,
      )}
    </>
  );
}
