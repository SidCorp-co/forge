import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryProvider } from '@/providers/query-provider';

function Inspector({ onClient }: { onClient: (c: ReturnType<typeof useQueryClient>) => void }) {
  const client = useQueryClient();
  onClient(client);
  return null;
}

describe('QueryProvider', () => {
  it('configures staleTime, retry, and gcTime defaults', () => {
    let client: ReturnType<typeof useQueryClient>;
    render(
      <QueryProvider>
        <Inspector onClient={(c) => { client = c; }} />
      </QueryProvider>
    );

    const defaults = client!.getDefaultOptions().queries;
    expect(defaults?.staleTime).toBe(60_000);
    expect(defaults?.retry).toBe(2);
    expect(defaults?.gcTime).toBe(300_000);
  });

  it('provides a QueryClient to child components', () => {
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <Inspector onClient={(c) => { client = c; }} />
      </QueryProvider>
    );

    expect(client).toBeDefined();
    expect(client!.getQueryCache()).toBeDefined();
  });
});
