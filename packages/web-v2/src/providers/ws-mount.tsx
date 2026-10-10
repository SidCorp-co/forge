'use client';

import { useWebSocket } from './use-websocket';

export function WsMount() {
  useWebSocket();
  return null;
}
