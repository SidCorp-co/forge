'use client';

import { useWebSocket } from '@/lib/ws/use-websocket';

export function WsMount() {
  useWebSocket();
  return null;
}
