/**
 * 自绘终端的渲染器。
 *
 * 设计要点：它伪装成 xterm 的 `Terminal`，只实现上层真正用到的那几个方法
 * （`write` / `open` / `dispose` / `onData` / `element`），
 * 这样 `TerminalPane` 里 1400 多行输入处理、搜索、块折叠、粘贴逻辑全都不用改。
 *
 * 真正的解析在 Rust 侧（alacritty_terminal），这里只负责：
 * 收字节 → 转 base64 发给后端 → 后端回一帧 PNG → 画到 canvas。
 */

import { invoke } from "@tauri-apps/api/core";

type FramePayload = {
  width: number;
  height: number;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  padding: number;
  dataUrl: string;
};

export type GridRendererOptions = {
  sessionId: string;
  cols: number;
  rows: number;
  /** 一帧画完后回调，用于同步真实格数 */
  onResize?: (cols: number, rows: number) => void;
};

/**
 * 把 UTF-8 字符串编码成 base64。
 * 后端 `grid_feed` 收的是原始字节，不能直接传字符串——
 * 中文在 JS 里是 UTF-16，直接传会丢字节。
 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 自绘终端的门面对象。
 *
 * 关键取舍：**不实现逐字符渲染**，而是整帧重绘。
 * 一帧 1600×900 的 PNG 约 40~80KB，本地 IPC + `createImageBitmap` 足够快；
 * 换来的是渲染逻辑全在 Rust 里一份，前端没有第二套字体度量。
 */
export class GridTerminal {
  readonly sessionId: string;
  private canvas: HTMLCanvasElement | null = null;
  private container: HTMLElement | null = null;
  private cols: number;
  private rows: number;
  private disposed = false;
  /** 是否有待渲染的新内容 */
  private dirty = false;
  private rafId = 0;
  private resizeObserver: ResizeObserver | null = null;
  private onResize?: (cols: number, rows: number) => void;
  /** 输入回调，与 xterm 的 onData 语义一致 */
  private dataHandlers = new Set<(data: string) => void>();
  /** 最近一帧的度量，供鼠标换算格子用 */
  metrics = { cellWidth: 9, cellHeight: 19, padding: 14 };

  constructor(options: GridRendererOptions) {
    this.sessionId = options.sessionId;
    this.cols = options.cols;
    this.rows = options.rows;
    this.onResize = options.onResize;
  }

  /** 兼容 xterm 的 `terminal.element`，部分逻辑会读它 */
  get element(): HTMLElement | null {
    return this.container;
  }

  /** 后端已建好网格会话。 */
  static async create(sessionId: string, cols: number, rows: number) {
    await invoke("grid_create_session", { sessionId, cols, rows });
  }

  open(container: HTMLElement) {
    this.container = container;
    container.style.position = "relative";
    container.style.overflow = "hidden";

    const canvas = document.createElement("canvas");
    canvas.className = "grid-terminal-canvas";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.tabIndex = 0;
    container.appendChild(canvas);
    this.canvas = canvas;

    // 尺寸变化时让后端知道真实格数，并重绘
    this.resizeObserver = new ResizeObserver(() => this.handleContainerResize());
    this.resizeObserver.observe(container);

    this.bindInput(canvas);
    this.scheduleRender();
  }

  /** 写入一段输出（与 xterm 的 `write` 同签名）。 */
  write(data: string | Uint8Array) {
    if (this.disposed) {
      return;
    }
    const text =
      typeof data === "string" ? data : new TextDecoder().decode(data);
    // 后端解析是同步的，这里不 await：连续 chunk 到达时靠 IPC 顺序保证
    void invoke("grid_feed", {
      sessionId: this.sessionId,
      base64: toBase64(text),
    })
      .then(() => {
        this.dirty = true;
        this.scheduleRender();
      })
      .catch((error) => {
        console.error("[grid] feed failed", error);
      });
  }

  /** 输入事件。语义与 xterm 的 `onData` 一致。 */
  onData(handler: (data: string) => void): { dispose: () => void } {
    this.dataHandlers.add(handler);
    return { dispose: () => this.dataHandlers.delete(handler) };
  }

  private emitData(data: string) {
    for (const handler of this.dataHandlers) {
      handler(data);
    }
  }

  /** 容器尺寸变了：重算格数并通知后端。 */
  private handleContainerResize() {
    if (this.disposed || !this.container) {
      return;
    }
    const { width, height } = this.container.getBoundingClientRect();
    const usableW = width - this.metrics.padding * 2;
    const usableH = height - this.metrics.padding * 2;
    const cols = Math.max(20, Math.floor(usableW / this.metrics.cellWidth));
    const rows = Math.max(5, Math.floor(usableH / this.metrics.cellHeight));
    if (cols === this.cols && rows === this.rows) {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    void invoke("grid_resize", { sessionId: this.sessionId, cols, rows })
      .then(() => {
        this.onResize?.(cols, rows);
        this.dirty = true;
        this.scheduleRender();
      })
      .catch((error) => console.error("[grid] resize failed", error));
  }

  /**
   * 合帧：同一帧内多次 `write` 只渲染一次。
   * 不加这个的话 `dir /s` 这种输出会把 IPC 打爆。
   */
  private scheduleRender() {
    if (this.disposed || this.rafId) {
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      if (this.dirty) {
        this.dirty = false;
        void this.renderFrame();
      }
    });
  }

  private async renderFrame() {
    if (this.disposed || !this.canvas || !this.container) {
      return;
    }
    const width = Math.max(1, Math.round(this.container.clientWidth));
    try {
      const frame = await invoke<FramePayload>("grid_frame", {
        sessionId: this.sessionId,
        maxWidth: width,
      });
      if (this.disposed || !this.canvas) {
        return;
      }
      this.metrics = {
        cellWidth: frame.cellWidth,
        cellHeight: frame.cellHeight,
        padding: frame.padding,
      };
      await this.paint(frame);
    } catch (error) {
      // 会话可能刚被关闭，这不是错误
      if (!this.disposed) {
        console.error("[grid] frame failed", error);
      }
    }
  }

  private async paint(frame: FramePayload) {
    const canvas = this.canvas;
    if (!canvas) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== frame.width * dpr || canvas.height !== frame.height * dpr) {
      canvas.width = Math.round(frame.width * dpr);
      canvas.height = Math.round(frame.height * dpr);
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      return;
    }
    const bitmap = await createImageBitmap(await (await fetch(frame.dataUrl)).blob());
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
  }

  /**
   * 键盘输入。
   *
   * 这里刻意保持薄：把按键转成终端期望的字节，交给上层现有的 `writeInput`。
   * 组合键、输入法的处理沿用 `TerminalPane` 已有的 `onData` 链路，
   * 避免出现两套不一致的按键规则。
   */
  private bindInput(canvas: HTMLCanvasElement) {
    canvas.addEventListener("keydown", (event) => {
      const data = keyToBytes(event);
      if (data !== null) {
        event.preventDefault();
        this.emitData(data);
      }
    });

    canvas.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text");
      if (text) {
        event.preventDefault();
        // 开了括号粘贴模式时要包一层，否则多行粘贴会被 shell 当成逐条执行
        this.emitData(`\x1b[200~${text}\x1b[201~`);
      }
    });
  }

  dispose() {
    this.disposed = true;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas?.remove();
    this.canvas = null;
    this.container = null;
    this.dataHandlers.clear();
  }
}

/**
 * 按键 → 终端字节。
 *
 * 只处理终端真正需要的那些。返回 `null` 表示"交给浏览器默认行为"，
 * 比如 Ctrl+C 在有选区时应该是复制，而不是发 SIGINT。
 */
function keyToBytes(event: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey, metaKey, shiftKey } = event;

  if (metaKey) {
    // Win 键组合留给系统
    return null;
  }

  // Ctrl + 字母 → 控制字符
  if (ctrlKey && !altKey && key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) {
      return String.fromCharCode(code - 64);
    }
  }

  switch (key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Delete":
      return "\x1b[3~";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    default:
      break;
  }

  if (altKey && key.length === 1) {
    return `\x1b${key}`;
  }
  if (key.length === 1 && !ctrlKey) {
    return key;
  }
  return null;
}
