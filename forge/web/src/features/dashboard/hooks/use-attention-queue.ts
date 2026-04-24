'use client';

import { useUnimplemented } from '@/lib/api/unimplemented';

export interface AttentionGroup {
  label: string;
  items: unknown[];
}

export function useAttentionQueue() {
  return useUnimplemented<AttentionGroup[]>('Attention queue');
}
