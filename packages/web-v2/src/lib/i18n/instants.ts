import { type InstantReading, readInstantsIn } from "@forge/contracts/visual-blocks";
import { type EtaClock, doneDayText, partsOf, whenText } from "./eta-clock-words";
import { ETA_COPY } from "./eta-copy";

// Every date a block draws reads as the Requirements list reads the same moment: the forecast's own
// clock words (`lib/i18n/eta-clock-words.ts`) in the viewer's timezone, never the ISO a frame carries.

/** A calendar day with no time: its own day, read in UTC so no timezone moves it. */
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}(?:T00:00(?::00(?:\.0+)?)?Z)?$/;

export interface BlockInstants extends InstantReading {
  /** An instant as the day alone, for an axis. */
  day(iso: string): string;
}

/** The reading of an instant on a clock: ahead of now as the ETA cell reads it, behind as the list's done day. */
export function instantsOn(clock: EtaClock): BlockInstants {
  const copy = ETA_COPY[clock.lang];
  const calendar = (iso: string) => {
    const [, m, d] = iso.slice(0, 10).split("-").map(Number);
    return copy.date(d as number, m as number);
  };
  const day = (iso: string) => {
    if (DAY_ONLY.test(iso)) return calendar(iso);
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return iso;
    const p = partsOf(at, clock.timeZone);
    return copy.date(p.d, p.m);
  };
  return {
    day,
    instant(iso) {
      if (DAY_ONLY.test(iso)) return calendar(iso);
      const at = Date.parse(iso);
      if (Number.isNaN(at)) return iso;
      return at > clock.now ? whenText(iso, clock) : doneDayText(iso, clock);
    },
  };
}

/**
 * Prose as a person reads it: every ISO instant in the text as the same reading a block draws, except
 * inside a fenced block, a code span or a link destination, which keep their text as written.
 */
export function readProseInstants(text: string, reading: InstantReading): string {
  let out = "";
  let from = 0;
  const keep = (start: number, end: number) => {
    out += readInstantsIn(text.slice(from, start), reading) + text.slice(start, end);
    from = end;
  };
  for (let at = 0; at < text.length; ) {
    const fence = /[ \t]*(`{3,}|~{3,})/y;
    fence.lastIndex = at;
    const f = at === 0 || text[at - 1] === "\n" ? fence.exec(text) : null;
    if (f) {
      const mark = f[1] as string;
      const close = new RegExp(`\\n[ \\t]*${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*(?=\\n|$)`, "g");
      close.lastIndex = at + f[0].length - 1;
      const m = close.exec(text);
      const end = m ? m.index + m[0].length : text.length;
      keep(at, end);
      at = end;
      continue;
    }
    const c = text[at];
    if (c === "`") {
      let n = 1;
      while (text[at + n] === "`") n++;
      const end = text.indexOf("`".repeat(n), at + n);
      if (end >= 0) {
        keep(at, end + n);
        at = end + n;
        continue;
      }
      at += n;
      continue;
    }
    if (c === "]" && text[at + 1] === "(") {
      const end = text.indexOf(")", at);
      if (end >= 0) {
        keep(at, end + 1);
        at = end + 1;
        continue;
      }
    }
    at++;
  }
  return out + readInstantsIn(text.slice(from), reading);
}

/**
 * The same reading for text no component renders with a hook (a refusal's sentence in a toast): ISO
 * instants in the viewer's timezone on the interface's one language, so a refusal never shows raw ISO.
 */
export function readInstantsNow(text: string): string {
  return readProseInstants(text, instantsOn({ lang: "en", now: Date.now() }));
}
