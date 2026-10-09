"use client";

import { useMemo } from "react";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { type BlockInstants, instantsOn } from "@/lib/i18n/instants";

/** The reading every block of a screen shares, on the interface language and the viewer's clock. */
export function useBlockInstants(): BlockInstants {
  const clock = useEtaClock();
  return useMemo(() => instantsOn(clock), [clock]);
}

