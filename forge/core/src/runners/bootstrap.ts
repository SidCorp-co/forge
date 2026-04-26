import { antigravityAdapter } from './adapters/antigravity.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { registerRunnerAdapter } from './registry.js';

let bootstrapped = false;

export function bootstrapRunnerAdapters(): void {
  if (bootstrapped) return;
  registerRunnerAdapter(claudeCodeAdapter);
  registerRunnerAdapter(antigravityAdapter);
  bootstrapped = true;
}

export function resetRunnerBootstrapForTest(): void {
  bootstrapped = false;
}
