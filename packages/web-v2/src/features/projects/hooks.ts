'use client';

// web-v2 feature module: projects — React Query hooks.
//
// Query-key contract (ISS-288): `useProjects` is keyed `['projects']`, which is
// exactly the key `replayOnReconnect()` in `lib/ws/event-router.ts` invalidates
// on every WS reconnect. That makes the project console the "sample query that
// invalidates on a WS event" required by the foundation acceptance — and it is
// the template every later web-v2 feature follows: pick a key the event-router
// already touches, or live updates silently no-op.
import { useQuery } from '@tanstack/react-query';
import { projectApi } from './api';

/** Project console list. Keyed `['projects']` — see the WS contract above. */
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => projectApi.list(),
  });
}

/**
 * Per-project pipeline-health rollup. Keyed `['projects', 'health']`, a child
 * of `['projects']` — so the same reconnect replay invalidates it too.
 */
export function useProjectHealth() {
  return useQuery({
    queryKey: ['projects', 'health'],
    queryFn: () => projectApi.health(),
  });
}

/** Full detail for one project. Keyed `['project', id]`. */
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => projectApi.getById(id as string),
    enabled: !!id,
  });
}
