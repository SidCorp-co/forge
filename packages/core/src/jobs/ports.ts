// What the jobs kernel needs from the modules above it, handed in by the process entry at boot
// (ADR 0008: a kernel imports only kernel and platform modules). Read only inside a call, never at
// import, so an unprovided port fails the call that needed it and names the provide it lacked.

import type { DispatchState, PolicyStateSource } from '@forge/contracts/project-config';
import type { Db } from '../db/client.js';
import type {
  SkillActivityEventType,
  SkillActivityOutcome,
  SkillActivityTrigger,
} from '../db/schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A drizzle executor: the base `db` or a transaction handle. */
export type SkillActivityExecutor = Db | Tx;

export interface RecordSkillActivityEventInput {
  eventType: SkillActivityEventType;
  /** `human:<user>` | `agent:master` | `system:seeder` | `runner:<device>`. */
  actor: string;
  trigger: SkillActivityTrigger;
  packetId?: string;
  projectId?: string;
  skillId?: string;
  deviceId?: string;
  beforeHash?: string;
  afterHash?: string;
  deltaSummary?: string;
  reason?: string;
  outcome?: SkillActivityOutcome;
}

/** The skills domain's audit trail, written inside the caller's transaction. */
export interface SkillActivityPort {
  recordSkillActivityEvent(
    executor: SkillActivityExecutor,
    input: RecordSkillActivityEventInput,
  ): Promise<void>;
}

/** The project's policy document, read as the state one dispatch runs under. */
export interface DispatchPolicyPort {
  /**
   * Throws the policy refusal when the project has no policy, or its policy leaves out the state
   * the work is for.
   */
  dispatchState(
    projectId: string,
    wanted: { status: string | null; from: Exclude<PolicyStateSource, 'entry'> },
  ): Promise<DispatchState>;
}

/** A requirement a job's issue delivers, as the design domain loaded it; jobs reads these fields. */
export interface GivenRequirement {
  key: string;
  text: string;
  pins: readonly unknown[];
}

/**
 * The design and contract context a job's issue reaches. Each loaded value is opaque here and handed
 * back to the function that renders or records it.
 */
export interface JobContextPort {
  loadArtifactContext(issueId: string): Promise<readonly unknown[]>;
  renderArtifactContext(loaded: readonly unknown[]): string | null;
  loadRequirementContext(
    issueId: string,
    mockupsWithheld: boolean,
  ): Promise<GivenRequirement | null>;
  issueMockupsOf(issueId: string): Promise<readonly unknown[]>;
  renderIssueMockups(rows: readonly unknown[], withheld: boolean): string | null;
  loadPinnedContracts(key: string, pins: readonly unknown[]): Promise<readonly unknown[]>;
  renderPinnedContracts(key: string, loaded: readonly unknown[]): string | null;
  pathsNamedIn(text: string): string[];
  loadContractContext(projectId: string, paths: readonly string[]): Promise<readonly unknown[]>;
  renderContractContext(loaded: readonly unknown[]): string | null;
  recordArtifactContext(
    agentSessionId: string,
    loaded: readonly unknown[],
    source: string,
    requirement?: GivenRequirement | null,
    contracts?: readonly unknown[],
  ): Promise<void>;
  recordContractContext(
    agentSessionId: string,
    loaded: readonly unknown[],
    source: string,
  ): Promise<void>;
}

/** One MCP server a granted integration binding produced. */
export interface ProducedMcpServer {
  name: string;
  bindingId: string;
}

export interface JobsPorts {
  skillActivity: SkillActivityPort;
  dispatchPolicy: DispatchPolicyPort;
  jobContext: JobContextPort;
  vault: { isVaultConfigured(): boolean; decryptSecret(enc: Buffer): string };
  mcpServers: {
    applyGrantedMcpServers(
      projectId: string,
    ): Promise<{ map: Record<string, unknown> | null; produced: ProducedMcpServer[] }>;
  };
  /** Re-dispatches a schedule's session on another box after a failover-class failure. */
  redispatchScheduleSessionOnFailover(
    sessionId: string,
    opts?: { failureClass?: string | null },
  ): Promise<{ ok: boolean; status: string; sessionId?: string; deviceId?: string }>;
}

let provided: JobsPorts | null = null;

export function provideJobsPorts(ports: JobsPorts): void {
  provided = ports;
}

export function jobsPorts(): JobsPorts {
  if (!provided) {
    throw new Error(
      'jobs: no ports were provided, so a job cannot reach the skills, policy, design or vault modules it needs; the process entry calls provideJobsPorts before it serves',
    );
  }
  return provided;
}
