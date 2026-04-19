import type { NormalizedMessage } from './message';

export interface ChannelConfig {
  [key: string]: unknown;
}

export interface SendOptions {
  replyTo?: string;
  parseMode?: string;
}

export interface ChannelPlugin {
  id: string;
  capabilities: {
    threads: boolean;
    reactions: boolean;
    media: boolean;
    maxChunkSize: number;
  };
  start(config: ChannelConfig, onMessage: (msg: NormalizedMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(to: string, text: string, opts?: SendOptions): Promise<void>;
  sendTyping?(to: string): Promise<void>;
}
