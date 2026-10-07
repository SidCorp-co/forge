"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useStartTour } from "../hooks";
import { onTourRoute, type TourDefinition, tourById } from "../registry";
import { presentSteps } from "../run-tour";

/** How long a deep link waits for its page to draw the tour's anchors. */
const ANCHOR_WAIT_MS = 8_000;
/** How long the page must stay still, with some anchor drawn, before a missing one counts as missing. */
const QUIET_MS = 800;

// a page draws its parts as their reads land: the tour starts once every anchor is drawn, or once
// the page has gone still with at least one of them, or at the cap, so a slow read is not a skip
function whenAnchored(tour: TourDefinition, go: () => void): () => void {
  let done = false;
  let quiet: number | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    window.clearTimeout(cap);
    window.clearTimeout(quiet);
    go();
  };
  const check = () => {
    const { present, missing } = presentSteps(tour);
    if (missing.length === 0) return finish();
    if (present.length > 0) {
      window.clearTimeout(quiet);
      quiet = window.setTimeout(finish, QUIET_MS);
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  const cap = window.setTimeout(finish, ANCHOR_WAIT_MS);
  check();
  return () => {
    done = true;
    observer.disconnect();
    window.clearTimeout(cap);
    window.clearTimeout(quiet);
  };
}

/**
 * `?tour=<id>` opens that tour on the page it names, once its anchors are drawn, and the parameter
 * is taken off the address so a reload does not replay it. A link the person followed is the only
 * way in; nothing here starts a tour on its own.
 */
export function TourLauncher() {
  const pathname = usePathname() || "/";
  const search = useLocationSearch();
  const router = useRouter();
  const start = useStartTour();
  const started = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const tour = tourById(params.get("tour"));
    if (!tour || !onTourRoute(tour, pathname, params)) return;
    const once = `${pathname}?${search}`;
    if (started.current === once) return;
    return whenAnchored(tour, () => {
      started.current = once;
      params.delete("tour");
      const rest = params.toString();
      router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
      start(tour);
    });
  }, [pathname, search, router, start]);

  return null;
}
