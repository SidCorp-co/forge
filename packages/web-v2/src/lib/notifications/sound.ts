// Notification sound cue (ISS-513) — the audio analogue of the browser channel.
//
// An opt-in audible chime that accompanies transient notification delivery. It
// is NOT a contract channel: it piggybacks on the existing toast/browser
// delivery decision (see features/notifications/use-notification-delivery), so
// it fires for exactly the high-signal types and stays silent for bell-only
// ones — with no change to `@forge/contracts`.
//
// Like the browser channel it gates on an explicit localStorage opt-in
// (default OFF) and the cue is a synthesized Web Audio tone — no bundled asset,
// so nothing to license or host. Everything degrades to a silent no-op when the
// API is unsupported or the autoplay policy blocks playback; callers never need
// to guard and nothing here ever throws.
//
// Autoplay reliability (ISS-513 reopen): the browser autoplay policy keeps a
// freshly-constructed AudioContext `suspended` until a user gesture resumes it.
// The opt-in persists across reloads but the AudioContext does not, so two
// mechanisms keep the cue actually audible: `installGesturePrimer()` resumes the
// context on the first interaction after load, and `playNotificationSound()`
// resumes-THEN-schedules so a cue is never scheduled against the frozen
// timeline of a still-suspended context (which silently drops the tone).

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

/**
 * Resume (or construct) the AudioContext from a user gesture. The autoplay
 * policy only unlocks audio after such a gesture, so the Settings toggle calls
 * this on opt-in. No-op + swallow on any failure.
 */
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

/** Resume-if-needed THEN schedule. Scheduling against a suspended context's
 *  frozen `currentTime` and resuming afterwards drops the tone (its start time
 *  lands in the past once the clock advances), so when suspended we wait for the
 *  resume to resolve before building the nodes. Wrapped end-to-end in try/catch
 *  so it never throws and never blocks toast/browser delivery. */
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
    // node construction / scheduling can throw on some platforms — silent.
  }
}

/**
 * Play the notification cue: a short two-note chime. No-op unless supported AND
 * opted-in. Resumes a suspended context first (best-effort) so a persisted
 * opt-in still plays after a reload. Never throws.
 */
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

/**
 * Install one-time global user-gesture listeners that resume the AudioContext
 * whenever the sound cue is enabled. The opt-in persists across reloads but the
 * AudioContext does not, so without this a persisted opt-in would stay silent
 * until the user happened to re-visit the Settings toggle. Idempotent + SSR-safe;
 * never throws.
 */
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
