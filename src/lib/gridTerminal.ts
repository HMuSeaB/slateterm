/**
 * 自绘终端的渲染器。
 *
 * 设计要点：它伪装成 xterm 的 `Terminal`，只实现上层真正用到的那几个方法
 * （`write` / `open` / `dispose` / `onData` / `element` / `hasSelection` /
 * `getSelection` / `clearSelection` / `attachCustomKeyEventHandler`），
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
  displayOffset: number;
  historySize: number;
  dataUrl: string;
};

export type ScrollInfo = { offset: number; history: number; rows: number };
export type GridSearchResult = { count: number; active: number | null };

export type GridRendererOptions = {
  sessionId: string;
  cols: number;
  rows: number;
  /** 一帧画完后回调，用于同步真实格数 */
  onResize?: (cols: number, rows: number) => void;
  /** 滚动位置变化，用于画滚动条 */
  onScroll?: (info: ScrollInfo) => void;
};

/** 选区类型，和 Rust 侧的 `SelectionType` 一一对应。 */
type SelectionKind = "simple" | "block" | "semantic" | "lines";

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
  /**
   * 隐藏的输入框，专门承接输入法。
   *
   * canvas 不是可编辑元素，输入法根本不会激活——中文一个字都打不进去。
   * 所以真正接收键盘的是这个 1×1 的透明 textarea：
   * 普通按键走 keydown 转义成终端字节（并且 preventDefault，不让它落进 value），
   * 只有输入法提交的文字才会从 `input` / `compositionend` 里出来。
   */
  private imeInput: HTMLTextAreaElement | null = null;
  private composing = false;
  private cols: number;
  private rows: number;
  private disposed = false;
  /** 是否有待渲染的新内容 */
  private dirty = false;
  private rafId = 0;
  private resizeObserver: ResizeObserver | null = null;
  private abort: AbortController | null = null;
  private onResize?: (cols: number, rows: number) => void;
  private onScroll?: (info: ScrollInfo) => void;
  /** 输入回调，与 xterm 的 onData 语义一致 */
  private dataHandlers = new Set<(data: string) => void>();
  /** 宿主注册的按键拦截器，等价于 xterm 的 attachCustomKeyEventHandler */
  private keyHandler?: (event: KeyboardEvent) => boolean;
  /** 最近一帧的度量，供鼠标换算格子用 */
  metrics = { cellWidth: 9, cellHeight: 19, padding: 14 };
  /** 位图尺寸到 CSS 像素的缩放（帧宽被 maxWidth 钳过，两者不完全相等） */
  private scale = 1;
  /** 上次渲染时的格数；鼠标换算要用它，不能用 `this.cols` */
  private frameCols = 80;
  private frameRows = 24;
  /** 当前向上滚了多少行 */
  private displayOffset = 0;
  private historySize = 0;
  /** 选区状态。文本要缓存：`getSelection()` 在按键回调里必须同步返回。 */
  private hasSel = false;
  private selectionText = "";
  private selectAnchor: { line: number; col: number } | null = null;
  private selecting = false;
  private selectRaf = 0;

  constructor(options: GridRendererOptions) {
    this.sessionId = options.sessionId;
    this.cols = options.cols;
    this.rows = options.rows;
    this.onResize = options.onResize;
    this.onScroll = options.onScroll;
  }

  /** 兼容 xterm 的 `terminal.element`，部分逻辑会读它 */
  get element(): HTMLElement | null {
    return this.container;
  }

  /** 兼容 xterm 的 `focus()`。 */
  focus() {
    this.imeInput?.focus();
  }

  /** 会话结束或组件卸载时调用。 */
  disposeSilently() {
    this.dispose();
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
    // 文本选中、拖拽这些原生行为会和自己的选区逻辑打架
    canvas.style.userSelect = "none";
    canvas.style.cursor = "text";
    canvas.style.touchAction = "none";
    container.appendChild(canvas);
    this.canvas = canvas;

    // 输入法宿主。放在容器左上角 1×1、完全透明、不吃指针事件，
    // 这样它既不会挡住画面，也不会被浏览器滚动进视野。
    const ime = document.createElement("textarea");
    ime.className = "grid-terminal-ime";
    ime.setAttribute("autocomplete", "off");
    ime.setAttribute("autocorrect", "off");
    ime.setAttribute("autocapitalize", "off");
    ime.setAttribute("spellcheck", "false");
    ime.style.position = "absolute";
    ime.style.left = "0";
    ime.style.top = "0";
    ime.style.width = "1px";
    ime.style.height = "1px";
    ime.style.padding = "0";
    ime.style.border = "0";
    ime.style.opacity = "0";
    ime.style.resize = "none";
    ime.style.overflow = "hidden";
    ime.style.pointerEvents = "none";
    ime.style.background = "transparent";
    container.appendChild(ime);
    this.imeInput = ime;

    // 尺寸变化时让后端知道真实格数，并重绘
    this.resizeObserver = new ResizeObserver(() => this.handleContainerResize());
    this.resizeObserver.observe(container);

    this.abort = new AbortController();
    this.bindInput(ime, this.abort.signal);
    this.bindPointer(canvas, this.abort.signal);
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
        // 新输出会让旧选区/命中位置失效，后端已经清掉，本地缓存也要跟上
        this.hasSel = false;
        this.selectionText = "";
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

  /**
   * 宿主按键拦截。语义与 xterm 的 `attachCustomKeyEventHandler` 一致：
   * 返回 `false` 表示这个键已经被处理，别再发字节。
   */
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }

  // ---- 选区（xterm 兼容接口）----

  hasSelection(): boolean {
    return this.hasSel;
  }

  getSelection(): string {
    return this.selectionText;
  }

  clearSelection() {
    if (!this.hasSel) {
      return;
    }
    this.hasSel = false;
    this.selectionText = "";
    void invoke("grid_clear_selection", { sessionId: this.sessionId })
      .then(() => this.scheduleRender())
      .catch(() => {
        // 会话可能已关闭，静默即可
      });
  }

  /** 让宿主能主动请求重绘（选区、搜索命中变化后）。 */
  markDirty() {
    if (this.disposed) {
      return;
    }
    this.dirty = true;
    this.scheduleRender();
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
      this.frameCols = frame.cols;
      this.frameRows = frame.rows;
      this.scale = frame.width > 0 ? this.canvas.clientWidth / frame.width || 1 : 1;
      if (this.displayOffset !== frame.displayOffset) {
        this.displayOffset = frame.displayOffset;
        this.historySize = frame.historySize;
        this.onScroll?.({ offset: frame.displayOffset, history: frame.historySize, rows: frame.rows });
      }
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

  // ---- 滚动 ----

  /** `delta` 正数向上翻（看更早的内容）。 */
  async scrollLines(delta: number) {
    const info = await invoke<ScrollInfo>("grid_scroll", { sessionId: this.sessionId, delta });
    this.applyScroll(info);
  }

  async scrollPage(up: boolean) {
    const info = await invoke<ScrollInfo>("grid_scroll_page", { sessionId: this.sessionId, up });
    this.applyScroll(info);
  }

  async scrollTo(edge: "top" | "bottom") {
    const info = await invoke<ScrollInfo>("grid_scroll_to", { sessionId: this.sessionId, edge });
    this.applyScroll(info);
  }

  private applyScroll(info: ScrollInfo) {
    this.displayOffset = info.offset;
    this.historySize = info.history;
    this.onScroll?.(info);
    this.dirty = true;
    this.scheduleRender();
  }

  // ---- 选区 ----

  /** 鼠标坐标 → 缓冲坐标（行可负）。 */
  private cellAt(clientX: number, clientY: number) {
    const canvas = this.canvas;
    if (!canvas) {
      return { line: 0, col: 0 };
    }
    const rect = canvas.getBoundingClientRect();
    const scale = this.scale || 1;
    const padCss = this.metrics.padding * scale;
    const cw = Math.max(1, this.metrics.cellWidth * scale);
    const ch = Math.max(1, this.metrics.cellHeight * scale);
    const col = Math.floor((clientX - rect.left - padCss) / cw);
    const row = Math.floor((clientY - rect.top - padCss) / ch);
    // 屏幕行 → 缓冲行；两端都钳住，拖到窗口外也不会算出离谱的坐标
    const line = row - this.displayOffset;
    const maxLine = this.frameRows - 1 - this.displayOffset;
    return {
      line: Math.max(-this.displayOffset, Math.min(maxLine, line)),
      col: Math.max(0, Math.min(this.frameCols - 1, col)),
    };
  }

  private async applySelection(kind: SelectionKind, anchor: { line: number; col: number }, focus: { line: number; col: number }) {
    try {
      await invoke("grid_select", {
        sessionId: this.sessionId,
        kind,
        startLine: anchor.line,
        startCol: anchor.col,
        endLine: focus.line,
        endCol: focus.col,
      });
      const text = await invoke<string | null>("grid_selection_text", { sessionId: this.sessionId });
      this.selectionText = text ?? "";
      this.hasSel = this.selectionText.length > 0;
      this.dirty = true;
      this.scheduleRender();
    } catch (error) {
      console.error("[grid] select failed", error);
    }
  }

  /**
   * 鼠标：拖选、双击选词、三击选行。
   *
   * 拖选用 rAF 合帧，否则每移动一像素就一次 IPC + 一整帧 PNG。
   */
  private bindPointer(canvas: HTMLCanvasElement, signal: AbortSignal) {
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) {
          return;
        }
        // 焦点始终给隐藏输入框，canvas 拿不到输入法
        this.focus();
        this.clearSelection();
        this.selectAnchor = this.cellAt(event.clientX, event.clientY);
        this.selecting = true;
        canvas.setPointerCapture(event.pointerId);
        // 单击也要立刻建立零长度选区，xterm 的行为是"点一下取消选区"，
        // 这里保持一致：不主动选，但记录锚点等拖动。
      },
      { signal },
    );

    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!this.selecting || !this.selectAnchor) {
          return;
        }
        const focus = this.cellAt(event.clientX, event.clientY);
        const anchor = this.selectAnchor;
        if (this.selectRaf) {
          cancelAnimationFrame(this.selectRaf);
        }
        this.selectRaf = requestAnimationFrame(() => {
          this.selectRaf = 0;
          void this.applySelection("simple", anchor, focus);
        });
      },
      { signal },
    );

    const endDrag = (event: PointerEvent) => {
      if (!this.selecting) {
        return;
      }
      this.selecting = false;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      const anchor = this.selectAnchor;
      this.selectAnchor = null;
      if (!anchor) {
        return;
      }
      const focus = this.cellAt(event.clientX, event.clientY);
      if (anchor.line === focus.line && anchor.col === focus.col) {
        return;
      }
      void this.applySelection("simple", anchor, focus);
    };
    canvas.addEventListener("pointerup", endDrag, { signal });
    canvas.addEventListener("pointercancel", endDrag, { signal });

    canvas.addEventListener(
      "dblclick",
      (event) => {
        event.preventDefault();
        const point = this.cellAt(event.clientX, event.clientY);
        void this.applySelection("semantic", point, point);
      },
      { signal },
    );

    canvas.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY === 0) {
          return;
        }
        event.preventDefault();
        // 一个滚轮刻度按 3 行算，和 xterm 的手感接近
        const lines = Math.round(event.deltaY / 40) * 3 || (event.deltaY > 0 ? -3 : 3);
        void this.scrollLines(-lines);
      },
      { passive: false, signal },
    );
  }

  /**
   * 键盘输入。
   *
   * 这里刻意保持薄：把按键转成终端期望的字节，交给上层现有的 `writeInput`。
   * 组合键、输入法的处理沿用 `TerminalPane` 已有的 `onData` 链路，
   * 避免出现两套不一致的按键规则。
   */
  private bindInput(ime: HTMLTextAreaElement, signal: AbortSignal) {
    ime.addEventListener(
      "keydown",
      (event) => {
        // 输入法组字过程中不要抢键，空格/回车都是给候选框的
        if (event.isComposing || this.composing) {
          return;
        }
        // 先给宿主拦：Ctrl+C 复制、Ctrl+F 搜索这些都不该发到 PTY
        if (this.keyHandler && this.keyHandler(event) === false) {
          event.preventDefault();
          return;
        }
        // 翻看快捷键自己消化：Shift+PageUp 在 xterm 里也是滚动而不是发给程序，
        // 只有不带 Shift 的 PageUp 才是程序要的 \x1b[5~。
        if (event.shiftKey && event.key === "PageUp") {
          event.preventDefault();
          void this.scrollPage(true);
          return;
        }
        if (event.shiftKey && event.key === "PageDown") {
          event.preventDefault();
          void this.scrollPage(false);
          return;
        }
        if (event.ctrlKey && event.shiftKey && event.key === "Home") {
          event.preventDefault();
          void this.scrollTo("top");
          return;
        }
        if (event.ctrlKey && event.shiftKey && event.key === "End") {
          event.preventDefault();
          void this.scrollTo("bottom");
          return;
        }
        const data = keyToBytes(event);
        if (data !== null) {
          // 必须拦住，否则字符会落进 textarea，接着 input 事件又发一遍
          event.preventDefault();
          this.emitData(data);
        }
      },
      { signal },
    );

    ime.addEventListener(
      "compositionstart",
      () => {
        this.composing = true;
      },
      { signal },
    );

    ime.addEventListener(
      "compositionend",
      (event) => {
        this.composing = false;
        const text = event.data;
        if (text) {
          this.emitData(text);
        }
        ime.value = "";
      },
      { signal },
    );

    // 输入法之外的文字来源（比如拖入文本、部分输入法不派发 compositionend）
    ime.addEventListener(
      "input",
      () => {
        if (this.composing) {
          return;
        }
        const text = ime.value;
        if (text) {
          this.emitData(text);
        }
        ime.value = "";
      },
      { signal },
    );

    ime.addEventListener(
      "paste",
      (event) => {
        const text = event.clipboardData?.getData("text");
        if (text) {
          event.preventDefault();
          // 开了括号粘贴模式时要包一层，否则多行粘贴会被 shell 当成逐条执行
          this.emitData(`\x1b[200~${text}\x1b[201~`);
        }
      },
      { signal },
    );
  }

  dispose() {
    this.disposed = true;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.selectRaf) {
      cancelAnimationFrame(this.selectRaf);
      this.selectRaf = 0;
    }
    this.abort?.abort();
    this.abort = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.imeInput?.remove();
    this.imeInput = null;
    this.canvas?.remove();
    this.canvas = null;
    this.container = null;
    this.dataHandlers.clear();
  }
}

/**
 * 搜索适配器。
 *
 * 形如 `@xterm/addon-search` 的 `SearchAddon`，但命中在 Rust 侧算——
 * 回滚区可能有上万行，拉回前端再搜等于把整屏文本传两遍。
 *
 * 返回值是 Promise：`TerminalPane` 的 `runSearch` 已经 await，
 * 这样 xterm 的同步实现与这里的异步实现能共用同一处调用。
 */
export class GridSearch {
  private lastNeedle = "";
  private caseSensitive = false;
  private result: GridSearchResult = { count: 0, active: null };

  constructor(private terminal: GridTerminal) {}

  async findNext(needle: string, options?: { caseSensitive?: boolean }): Promise<boolean> {
    return this.run(needle, options, true);
  }

  async findPrevious(needle: string, options?: { caseSensitive?: boolean }): Promise<boolean> {
    return this.run(needle, options, false);
  }

  private async run(
    needle: string,
    options: { caseSensitive?: boolean } | undefined,
    forward: boolean,
  ): Promise<boolean> {
    const caseSensitive = options?.caseSensitive ?? false;
    const changed = needle !== this.lastNeedle || caseSensitive !== this.caseSensitive;
    this.lastNeedle = needle;
    this.caseSensitive = caseSensitive;

    try {
      // 词变了就重新搜；没变就在已有命中里跳，避免每次都扫一遍回滚区
      const command = changed ? "grid_search" : "grid_search_step";
      const args =
        command === "grid_search"
          ? { sessionId: this.terminal.sessionId, needle, caseSensitive, limit: 2000 }
          : { sessionId: this.terminal.sessionId, forward };
      this.result = await invoke<GridSearchResult>(command, args);
      if (command === "grid_search" && this.result.count > 0 && !forward) {
        // 反向搜索要落到最后一条
        this.result = await invoke<GridSearchResult>("grid_search_step", {
          sessionId: this.terminal.sessionId,
          forward: false,
        });
      }
      this.terminal.markDirty();
      return this.result.count > 0;
    } catch (error) {
      console.error("[grid] search failed", error);
      return false;
    }
  }

  clearDecorations() {
    this.lastNeedle = "";
    this.result = { count: 0, active: null };
    void invoke("grid_clear_search", { sessionId: this.terminal.sessionId })
      .then(() => this.terminal.markDirty())
      .catch(() => {});
  }

  clearActiveDecoration() {
    this.clearDecorations();
  }

  dispose() {
    this.clearDecorations();
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
