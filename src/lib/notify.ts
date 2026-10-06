// 完成提示音：用 WebAudio 现场合成两声短音，不依赖音频资源文件。
let audioContext: AudioContext | null = null;
let lastChimeAt = 0;

// 同一轮回复可能同时触发标题切换和 BEL，短时间内只响一次
const CHIME_COOLDOWN_MS = 3000;

function ensureContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    void audioContext.resume();
  }
  return audioContext;
}

export function playCompletionChime() {
  const now = Date.now();
  if (now - lastChimeAt < CHIME_COOLDOWN_MS) {
    return;
  }
  lastChimeAt = now;

  try {
    const context = ensureContext();
    const start = context.currentTime + 0.02;
    [
      { frequency: 880, offset: 0 },
      { frequency: 1318.5, offset: 0.14 },
    ].forEach(({ frequency, offset }) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.32);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.35);
    });
  } catch (error) {
    console.warn("SlateTerm: completion chime failed", error);
  }
}

// Claude Code 用终端标题前缀表示状态：工作中是不断切换的动画字符，
// 空闲时停在 "✳"。动画帧里也可能出现 ✳，所以要求它稳定一段时间才算空闲。
const IDLE_PREFIX = "✳";
const IDLE_STABLE_MS = 900;

function titleGlyph(title: string) {
  const first = Array.from(title.trim())[0] ?? "";
  return /[\p{L}\p{N}]/u.test(first) ? "" : first;
}

export function createClaudeIdleWatcher(onIdle: () => void) {
  let sawBusy = false;
  let idleTimer: number | null = null;

  function clearTimer() {
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  return {
    handleTitle(title: string) {
      const glyph = titleGlyph(title);
      clearTimer();
      if (!glyph) {
        // 不是 Claude 风格的标题（例如回到了普通 shell），重置状态
        sawBusy = false;
        return;
      }
      if (glyph !== IDLE_PREFIX) {
        sawBusy = true;
        return;
      }
      if (!sawBusy) {
        return;
      }
      idleTimer = window.setTimeout(() => {
        idleTimer = null;
        sawBusy = false;
        onIdle();
      }, IDLE_STABLE_MS);
    },
    dispose: clearTimer,
  };
}
