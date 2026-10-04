// The deploy port's contract: what a provider's deployment history reads as. project-config records
// it into an environment's state, whose schema must keep admitting every value named here.

export type DeploymentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type DeployProvider = 'coolify' | 'shopify' | 'epodsystem' | 'autoflow';
export type ArtifactKind = 'container-image' | 'theme' | 'bundle';

export interface DeploymentRecord {
  readonly id: string;
  readonly status: DeploymentStatus;
  readonly at: string;
  readonly sourceRevision: string | null;
  readonly artifact: { readonly kind: ArtifactKind; readonly id: string } | null;
}

export interface DeployAdapter<TTarget = unknown> {
  readonly provider: DeployProvider;
  latestDeployment(target: TTarget): Promise<DeploymentRecord | null>;
  deployment(target: TTarget, id: string): Promise<DeploymentRecord>;
}

export interface TargetedDeployAdapter<TTarget = unknown> {
  readonly adapter: DeployAdapter<TTarget>;
  readonly target: TTarget;
}
