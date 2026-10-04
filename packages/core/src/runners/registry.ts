import type { RunnerAdapter } from './types.js';

const adapters = new Map<string, RunnerAdapter>();

export function registerRunnerAdapter(adapter: RunnerAdapter): void {
  adapters.set(adapter.type, adapter);
}

export function getRunnerAdapter(type: string): RunnerAdapter | undefined {
  return adapters.get(type);
}
