'use client';

import { useUnimplemented } from '@/lib/api/unimplemented';

export function useKnowledge() {
  return useUnimplemented('Knowledge graph');
}
