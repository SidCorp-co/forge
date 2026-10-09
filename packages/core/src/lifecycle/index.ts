export {
  type GateCount,
  type GatedMove,
  type GatedPeriod,
  gatedMoveCounts,
  gatedMovesOf,
} from './gated-moves.js';
export type { MachineRow } from './machine-tables.js';
export { kernelRefusedMovesRetention, kernelTransitionsRetention } from './retention.js';
export {
  type Guard,
  type GuardInput,
  type KernelActor,
  type KernelExecutor,
  type MoveChecklist,
  movedRow,
  type TransitionArgs,
  type TransitionResult,
  transition,
} from './transition.js';
