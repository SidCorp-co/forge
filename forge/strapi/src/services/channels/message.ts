export interface NormalizedMessage {
  id: string;
  channel: string;
  from: string;
  to: string;
  text: string;
  media?: { type: string; url?: string; fileId?: string };
  replyTo?: string;
  threadId?: string;
  timestamp: number;
  raw?: unknown;
}
