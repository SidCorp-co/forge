'use client';

// Ported verbatim from `packages/web/src/providers/ws-mount.tsx` (ISS-288).
import { useWebSocket } from '@/lib/ws/use-websocket';

/**
 * Zero-render component that installs the singleton WebSocket listener
 * for the authenticated session. Mount inside the React Query + Auth
 * providers so the hook can pick up both.
 */
export function WsMount() {
  useWebSocket();
  return null;
}
