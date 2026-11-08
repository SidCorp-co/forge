// The V8 profile the scale read test (`tests/integration/slow-reads-at-scale-e2e.test.ts`) takes of a
// read under SLOW_READS_PROFILE: its self time summed by function, and charged to core's own frames.

import { appendFileSync } from 'node:fs';

/** One more GET under the V8 profiler, its self time summed by function, written beside `out`. */
export async function profiled(
  path: string,
  out: string,
  read: () => Promise<unknown>,
): Promise<void> {
  const { Session } = await import('node:inspector/promises');
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.start');
  await read();
  const { profile } = (await session.post('Profiler.stop')) as {
    profile: {
      nodes: {
        id: number;
        callFrame: { functionName: string; url: string; lineNumber: number };
        children?: number[];
      }[];
      samples: number[];
      timeDeltas: number[];
    };
  };
  session.disconnect();
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) => {
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  });
  const by = new Map<string, number>();
  for (const n of profile.nodes) {
    const f = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/(packages|node_modules)\//, '$1/')}:${n.callFrame.lineNumber}`;
    by.set(f, (by.get(f) ?? 0) + (self.get(n.id) ?? 0));
  }
  const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 40);
  // each sample charged to the nearest frame of core's own code above it: who asked for the work
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const node = new Map(profile.nodes.map((n) => [n.id, n]));
  const charged = new Map<string, number>();
  for (const [id, us] of self) {
    let at: number | undefined = id;
    let name = '(no core frame)';
    while (at !== undefined) {
      const f = node.get(at)?.callFrame;
      if (f?.url.includes('/packages/core/src/')) {
        name = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/packages\/core\/src\//, '')}:${f.lineNumber}`;
        break;
      }
      at = parent.get(at);
    }
    charged.set(name, (charged.get(name) ?? 0) + us);
  }
  const chargedTop = [...charged].sort((a, b) => b[1] - a[1]).slice(0, 30);
  appendFileSync(
    out,
    `## profile ${path}\n${top.map(([f, us]) => `  ${(us / 1000).toFixed(1).padStart(8)} ms  ${f}`).join('\n')}\n` +
      `## charged to core's own frame ${path}\n${chargedTop.map(([f, us]) => `  ${(us / 1000).toFixed(1).padStart(8)} ms  ${f}`).join('\n')}\n`,
  );
}
