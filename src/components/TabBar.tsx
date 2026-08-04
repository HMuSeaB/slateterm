import clsx from "clsx";
import { useRef, useState, type PointerEvent } from "react";
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
  dragging: boolean;
  dropTarget: DropTarget | null;
};

type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (draggedTabId: string, targetTabId: string, placement: DropPlacement) => void;
};

const DRAG_THRESHOLD = 5;

export default function TabBar({ tabs, activeTabId, onSelect, onClose, onReorder }: Props) {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const pointerGestureRef = useRef<PointerGesture | null>(null);
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

  function clearPointerGesture(event?: PointerEvent<HTMLButtonElement>) {
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerGestureRef.current = null;
    setDraggingTabId(null);
    setDropTarget(null);
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>, tabId: string) {
    if (event.button !== 0 || tabs.length < 2) {
      return;
    }

    suppressClickRef.current = false;
    pointerGestureRef.current = {
      tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
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

    if (!gesture.dragging) {
      const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (distance < DRAG_THRESHOLD) {
        return;
      }
      gesture.dragging = true;
      suppressClickRef.current = true;
      setDraggingTabId(gesture.tabId);
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
      const finalTarget = resolveDropTarget(event.clientX, event.clientY, gesture.tabId) ?? gesture.dropTarget;
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

  return (
    <nav className="tabbar" aria-label="Terminal tabs">
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
          >
            <button
              type="button"
              className="tab-pill-main"
              title={`${tab.title} · Drag to reorder`}
              onClick={() => handleTabClick(tab.id)}
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
    </nav>
  );
}
