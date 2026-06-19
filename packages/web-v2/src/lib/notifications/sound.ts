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

const OPT_IN_KEY = "forge:notify-sound";

type AudioContextCtor = typeof AudioContext;

/** Lazily-constructed singleton AudioContext, shared across cues. */
let audioCtx: AudioContext | null = null;

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

/**
 * Play the notification cue: a short two-note chime. No-op unless supported AND
 * opted-in. Best-effort resume of a suspended context (may stay silent until the
 * user has interacted with the page — acceptable). Wrapped end-to-end in
 * try/catch so it never throws and never blocks toast/browser delivery.
 */
export function playNotificationSound(): void {
  if (!isSupported() || !isEnabled()) return;
  const ctx = ensureContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") void ctx.resume();

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
  } catch {
    // Node construction / scheduling can throw on some platforms — silent.
  }
}
