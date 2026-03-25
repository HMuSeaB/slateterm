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
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          className={clsx("tab-pill", tab.id === activeTabId && "is-active")}
          onClick={() => onSelect(tab.id)}
        >
          <span>{tab.title}</span>
          <span
            className="tab-pill-close"
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            ×
          </span>
        </button>
      ))}
    </nav>
  );
}
