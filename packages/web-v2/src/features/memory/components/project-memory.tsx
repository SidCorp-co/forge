"use client";

// REQ-33 BC-7: the Dashboard's Memory section, the memories naming no requirement, workflow or issue
// of the project, read with the same fields and acts as an item's Memory tab. `#project-memory` is
// where an old /memory link lands.

import { useEffect, useRef } from "react";
import { ItemMemory } from "./item-memory";

export const PROJECT_MEMORY_ANCHOR = "project-memory";

export function ProjectMemory({ projectId, slug }: { projectId: string; slug: string }) {
  const at = useRef<HTMLDivElement>(null);
  // the section draws after the project resolves, later than the browser looks for the anchor
  useEffect(() => {
    if (window.location.hash === `#${PROJECT_MEMORY_ANCHOR}`) at.current?.scrollIntoView?.({ block: "start" });
  }, []);
  return (
    <div id={PROJECT_MEMORY_ANCHOR} ref={at} className="scroll-mt-16">
      <ItemMemory projectId={projectId} slug={slug} cites={null} />
    </div>
  );
}
