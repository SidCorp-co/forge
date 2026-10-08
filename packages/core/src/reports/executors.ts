// The Executor port's registry: the sandboxes this deployment enabled, handed in by the process
// entry at boot (`provideExecutors`), each an adapter `reports` never imports. Same mechanism as the
// query and share-subject registries: a duplicate id is refused naming it, a descriptor outside the
// port's contract is refused naming the field, and a read before the boot call is refused naming
// it. With no adapter registered every execution is refused by name, never faked.

import {
  type ComputePolicy,
  type ExecutionRefusalCode,
  type Executor,
  ExecutorDescriptorSchema,
} from '@forge/contracts/report-executions';
import { portSlot } from '../lib/port-slot.js';
import { refuser } from '../lib/refusal.js';

export type { ComputePolicy };

export const refuseExecution = refuser<ExecutionRefusalCode>('EXECUTION_REFUSED');

interface ExecutorPorts {
  /** The project's `compute` setting, read from its project document. */
  computePolicyOf(projectId: string): Promise<ComputePolicy | undefined>;
}

const slot = portSlot<ExecutorPorts>('reports', 'provideExecutorPorts');
export const provideExecutorPorts = slot.provide;
export const executorPorts = slot.get;

const adapters = new Map<string, Executor>();
let composed = false;

/** Adds one adapter; a second adapter under an id, or a descriptor off the contract, is refused. */
export function registerExecutor(adapter: Executor): void {
  const descriptor = ExecutorDescriptorSchema.safeParse({
    id: adapter.id,
    mode: adapter.mode,
    isolation: adapter.isolation,
    network: adapter.network,
    dataLeavesTo: adapter.dataLeavesTo,
    zdrEligible: adapter.zdrEligible,
  });
  if (!descriptor.success) {
    throw new Error(
      `reports: executor "${String(adapter.id)}" declares itself off the port's contract: ${descriptor.error.issues
        .map((i) => `${i.path.join('.') || '(descriptor)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  if (adapters.has(adapter.id)) {
    throw new Error(`reports: an executor "${adapter.id}" is already registered`);
  }
  adapters.set(adapter.id, adapter);
}

/** The process entry's one call: the executors this deployment enabled, possibly none. */
export function provideExecutors(list: readonly Executor[]): void {
  composed = true;
  for (const adapter of list) registerExecutor(adapter);
}

/** For a test that registers a fake adapter of its own; production never removes one. */
export function unregisterExecutorForTest(id: string): void {
  adapters.delete(id);
}

/**
 * Every registered executor, or the refusal that says this deployment enabled none. A read before
 * the boot call is an invariant break, not a refusal.
 */
export function registeredExecutors(): Executor[] {
  if (!composed) {
    throw new Error(
      'reports: no executors were provided; the process entry calls provideExecutors before it serves',
    );
  }
  if (adapters.size === 0) {
    throw refuseExecution(
      'EXECUTOR_UNAVAILABLE',
      'no sandbox executor is enabled on this deployment, so no computation can run here; answer from a report query (forge_report) instead, or ask the operator to enable an executor adapter',
    );
  }
  return [...adapters.values()];
}
