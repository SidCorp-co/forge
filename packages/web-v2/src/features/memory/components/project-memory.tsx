
// REQ-33 BC-7: the Dashboard's Memory section, the memories naming no requirement, workflow or issue
// of the project, read with the same fields and acts as an item's Memory tab. `#project-memory` is
// where an old /memory link lands. A project with no memory of its own draws no section at all: an
// empty section is hidden, never shown empty (ISS-903), and nothing is drawn while the read is out.

import { useEffect, useRef } from "react";
import { useItemMemory } from "../hooks";
import { ItemMemory } from "./item-memory";

const PROJECT_MEMORY_ANCHOR = "project-memory";

export function ProjectMemory({ projectId, slug }: { projectId: string; slug: string }) {
  const atRef = useRef<HTMLDivElement>(null);
  // the same read the section's list makes: one request, answered once for both
  const q = useItemMemory(projectId, { cites: null, state: "live" });
  const empty = q.data ? q.data.counts.live === 0 : !q.isError;
  // the section draws after the project resolves, later than the browser looks for the anchor
  useEffect(() => {
    if (window.location.hash === `#${PROJECT_MEMORY_ANCHOR}`) atRef.current?.scrollIntoView?.({ block: "start" });
  }, [empty]);
  if (empty) return null;
  return (
    <div id={PROJECT_MEMORY_ANCHOR} ref={atRef} className="scroll-mt-16">
      <ItemMemory projectId={projectId} slug={slug} cites={null} />
    </div>
  );
}
