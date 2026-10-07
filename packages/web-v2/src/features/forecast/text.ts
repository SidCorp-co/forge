import type { Forecast, ForecastPaused, ScopeForecast } from "@forge/contracts/forecast";

/** "40 min", "2.6 h", "3 d": a span read as a range bound, never as a promise. */
export function spanText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = m / 60;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

const until = (iso: string, now: number) => (new Date(iso).getTime() - now) / 60_000;

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

export const pausedText = (p: ForecastPaused) => `Paused — waiting on ${p.who}${p.act ? ` to ${p.act}` : ""}`;

/**
 * One line and its tooltip. A range is always two bounds and always says it is a forecast and as of
 * when; a pause names who owes the move instead of a date.
 */
export function forecastText(f: Forecast, now: number = Date.now()): { line: string; detail: string } {
  switch (f.kind) {
    case "forecast": {
      const low = Math.max(0, until(f.p50At, now));
      const high = Math.max(low, until(f.p85At, now));
      const b = f.basis;
      const ahead = f.ahead > 0 ? ` ${f.ahead} ahead of it${f.aheadKeys.length ? ` (${f.aheadKeys.join(", ")}${f.ahead > f.aheadKeys.length ? ", …" : ""})` : ""}.` : " Nothing ahead of it.";
      const waits = f.waitsOn.length ? ` Waits on ${f.waitsOn.join(", ")} to land first.` : "";
      return {
        line: `Forecast ${spanText(low)} – ${spanText(high)} · as of ${clock(f.asOf)}`,
        detail:
          `A forecast, not a promise: half the simulated runs land it by ${new Date(f.p50At).toLocaleString()}, 85% by ${new Date(f.p85At).toLocaleString()}.` +
          ahead +
          waits +
          ` Read from ${b.n} issues landed in the last ${b.windowDays} days${b.complexity ? ` at complexity ${b.complexity}` : ""} (p50 ${spanText(b.cycleP50Minutes)}, p85 ${spanText(b.cycleP85Minutes)}), ${b.concurrency} at a time: ${b.concurrencyBasis}.`,
      };
    }
    case "paused":
      return { line: pausedText(f), detail: f.reason };
    case "not_enough_history":
      return {
        line: `Not enough history to forecast · ${f.n} of ${f.floor} landings`,
        detail: `A forecast needs at least ${f.floor} issues landed in the window; this project has ${f.n}.`,
      };
    case "landed":
      return {
        line: f.landedAt ? `Landed ${day(f.landedAt)}` : "Landed",
        detail: f.landedAt ? `Landed ${new Date(f.landedAt).toLocaleString()}` : "Past the landing, with no merge time recorded",
      };
    case "ended":
      return { line: `Not forecast · ${f.status}`, detail: `The issue is ${f.status}; nothing is forecast for it.` };
  }
}

/** A requirement's or a draft release's line: how many have landed, then when the last will. */
export function scopeText(s: ScopeForecast, now: number = Date.now()): { line: string; detail: string } {
  if (!s.forecast) return { line: "No issues to forecast", detail: "Nothing is linked to it yet." };
  const own = forecastText(s.forecast, now);
  const head = `${s.landed}/${s.total} landed`;
  if (s.forecast.kind === "landed") {
    const next = s.next ? ` · then ${pausedText(s.next).replace(/^Paused — w/, "w")}` : "";
    return { line: `All ${s.total} landed${s.forecast.landedAt ? ` by ${day(s.forecast.landedAt)}` : ""}${next}`, detail: s.next?.reason ?? own.detail };
  }
  if (s.forecast.kind === "forecast") {
    const low = Math.max(0, until(s.forecast.p50At, now));
    const high = Math.max(low, until(s.forecast.p85At, now));
    return {
      line: `${head} · forecast all landed in ${spanText(low)} – ${spanText(high)} · as of ${clock(s.forecast.asOf)}`,
      detail: own.detail,
    };
  }
  return { line: `${head} · ${own.line}`, detail: own.detail };
}
