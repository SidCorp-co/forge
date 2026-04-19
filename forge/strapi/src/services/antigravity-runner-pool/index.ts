/**
 * Antigravity Runner Pool
 *
 * Manages multiple Antigravity runner instances: health checks, device allocation,
 * and load balancing. Mirrors the device-pool.ts pattern for desktop Claude devices.
 *
 * Split into:
 * - pool.ts — Runner allocation, availability checks, model depletion
 * - health.ts — Runner health checks, project health gate, bootstrap
 */

export { findAvailableRunner, clearRunnerAllocation, markModelDepleted, checkModelDepleted, disableRunnerUntil, clearRunnerPause } from './pool';
export type { RunnerAllocation } from './pool';

export {
  checkRunnerHealth,
  startHealthPoller,
  stopHealthPoller,
  checkAntigravityReady,
  pauseProjectAntigravity,
  clearProjectAntigravityError,
  startProjectHealthPoller,
  stopProjectHealthPoller,
  bootstrapRunners,
} from './health';
export type { AntigravityReadiness } from './health';
