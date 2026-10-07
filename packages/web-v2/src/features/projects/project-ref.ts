"use client";

import { isUuid, type Rekey, useBridgedRef } from "@/lib/api/ref-bridge";
import { useProjects } from "./hooks";
import type { ProjectListItem } from "./types";

const SLUG_SHAPE = /^[a-z0-9-]{1,64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A key segment naming the project by `slug`, or a plain object carrying it, renamed to `id`. */
export function projectRekey(slug: string, id: string): Rekey {
  return (segment) => {
    if (segment === slug) return id;
    if (isPlainObject(segment) && Object.values(segment).includes(slug)) {
      return Object.fromEntries(Object.entries(segment).map(([k, v]) => [k, v === slug ? id : v]));
    }
    return undefined;
  };
}

/**
 * How a project page addresses its project. Core takes the slug wherever it takes the id, so until
 * the projects list answers, the page reads by the URL's slug and its first reads leave at once;
 * once the list names the uuid, the page switches to it with those reads handed over, and from then
 * on reads, rooms and comparisons see the uuid as they always have. `row` is the list's entry, absent
 * until it answers (and for a slug no project the caller sees carries, where `ref` is absent too).
 */
export function useProjectRef(slug: string | null | undefined) {
  const projectsQ = useProjects();
  const row: ProjectListItem | undefined = slug ? projectsQ.data?.find((p) => p.slug === slug) : undefined;
  const provisional = slug && !isUuid(slug) && SLUG_SHAPE.test(slug) && (projectsQ.data === undefined || row) ? slug : undefined;
  const ref = useBridgedRef(provisional, row?.id, projectRekey);
  return { ref, row, projectsQ };
}
