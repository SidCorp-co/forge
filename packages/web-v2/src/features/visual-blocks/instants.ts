"use client";

import type { InstantReading } from "@forge/contracts/visual-blocks";
import { useMemo } from "react";
import { type EtaClock, doneDayText, partsOf, whenText } from "@/features/forecast/clock";
import { ETA_COPY } from "@/features/forecast/eta-copy";
import { useEtaClock } from "@/features/forecast/hooks";

// Every date a block draws reads as the Requirements list reads the same moment: the forecast's own
// clock words (`forecast/clock.ts`) in the viewer's timezone, never the ISO a frame carries.

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

/** The reading every block of a screen shares, on the interface language and the viewer's clock. */
export function useBlockInstants(): BlockInstants {
  const clock = useEtaClock();
  return useMemo(() => instantsOn(clock), [clock]);
}
