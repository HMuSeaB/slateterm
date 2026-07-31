import clsx from "clsx";
import type { Tab } from "../lib/types";

type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
};

export default function TabBar({ tabs, activeTabId, onSelect, onClose }: Props) {
  return (
    <nav className="tabbar">
      {tabs.map((tab) => {
        const activePane = tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
        const runtimeLabel = activePane?.runtimeMode === "claude" ? "AI" : "Shell";
        return (
          <div key={tab.id} className={clsx("tab-pill", tab.id === activeTabId && "is-active", activePane?.runtimeMode === "claude" && "is-claude")}>
            <button type="button" className="tab-pill-main" title={tab.title} onClick={() => onSelect(tab.id)}>
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
