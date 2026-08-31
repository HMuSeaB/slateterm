import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export type NativeFileDropHandlers = {
  /** 判断拖拽坐标（物理像素）是否落在本 pane 内 */
  isTargetAt: (position: { x: number; y: number }) => boolean;
  /** 文件悬停进入/离开本 pane；leave 与 drop 之后必然会收到 false */
  onDragOver?: (isTarget: boolean) => void;
  /** 文件带着路径进入 WebView 时收到一次，用于在胶囊里预览文件名 */
  onDragEnter?: (paths: string[]) => void;
  /** 文件落到本 pane */
  onDrop: (paths: string[]) => void;
};

export function useNativeFileDrop(handlers: NativeFileDropHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let dragWasOverPane = false;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const current = handlersRef.current;
      switch (event.payload.type) {
        case "enter":
          dragWasOverPane = current.isTargetAt(event.payload.position);
          current.onDragEnter?.(event.payload.paths);
          current.onDragOver?.(dragWasOverPane);
          return;
        case "over":
          dragWasOverPane = current.isTargetAt(event.payload.position);
          current.onDragOver?.(dragWasOverPane);
          return;
        case "leave":
          dragWasOverPane = false;
          current.onDragOver?.(false);
          return;
        case "drop": {
          const isTarget = current.isTargetAt(event.payload.position) || dragWasOverPane;
          dragWasOverPane = false;
          current.onDragOver?.(false);
          if (isTarget) {
            current.onDrop(event.payload.paths);
          }
        }
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
}
