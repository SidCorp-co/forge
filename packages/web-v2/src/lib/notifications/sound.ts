
const OPT_IN_KEY = "forge:notify-sound";

type AudioContextCtor = typeof AudioContext;

/** Lazily-constructed singleton AudioContext, shared across cues. */
let audioCtx: AudioContext | null = null;
/** Guard so the global gesture listeners are installed at most once. */
let gesturePrimerInstalled = false;

function getAudioContextCtor(): AudioContextCtor | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  );
}

export function isSupported(): boolean {
  return getAudioContextCtor() !== undefined;
}

/** Whether the user has opted in via Settings (localStorage flag). */
export function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(OPT_IN_KEY) === "1";
}

export function setEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  if (on) window.localStorage.setItem(OPT_IN_KEY, "1");
  else window.localStorage.removeItem(OPT_IN_KEY);
}

/** Get-or-create the singleton AudioContext. Returns null when unsupported or
 *  construction throws. */
function ensureContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
    return audioCtx;
  } catch {
    return null;
  }
}

export function primeAudio(): void {
  const ctx = ensureContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    // resume() can reject/throw under some policies — degrade silently.
  }
}

/** Build + schedule the two-note chime against a RUNNING context. Assumes the
 *  caller has ensured the context is (or is about to be) resumed. */
function emitChime(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  // Soft envelope: quick attack to a low peak, exponential decay to silence.
  const peak = 0.05;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  // Two-note rise (A5 → D6) for a pleasant "ding".
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.setValueAtTime(1174.66, now + 0.09);
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + 0.2);
}

function playChime(ctx: AudioContext): void {
  try {
    if (ctx.state === "suspended") {
      void ctx
        .resume()
        .then(() => {
          try {
            emitChime(ctx);
          } catch {
            // node construction / scheduling can throw on some platforms — silent.
          }
        })
        .catch(() => {
          // autoplay-blocked resume — degrade silently.
        });
      return;
    }
    emitChime(ctx);
  } catch {
  }
}

export function playNotificationSound(): void {
  if (!isSupported() || !isEnabled()) return;
  const ctx = ensureContext();
  if (!ctx) return;
  playChime(ctx);
}

/**
 * Play the cue immediately as opt-in confirmation, independent of the persisted
 * flag — the caller has just toggled the feature ON from a user gesture, so the
 * context is unlocking and the user should hear proof it works. Never throws.
 */
export function playPreviewCue(): void {
  if (!isSupported()) return;
  const ctx = ensureContext();
  if (!ctx) return;
  playChime(ctx);
}

export function installGesturePrimer(): void {
  if (gesturePrimerInstalled || typeof window === "undefined") return;
  gesturePrimerInstalled = true;
  const onGesture = () => {
    if (!isEnabled()) return;
    primeAudio();
  };
  try {
    window.addEventListener("pointerdown", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture, { passive: true });
  } catch {
    gesturePrimerInstalled = false;
  }
}
