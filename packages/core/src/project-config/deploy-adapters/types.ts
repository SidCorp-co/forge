import type { RecordedEnvironmentState } from '../schema.js';

type RecordedDeployment = RecordedEnvironmentState['deployment'];
export type DeploymentStatus = RecordedDeployment['status'];
export type DeployProvider = RecordedDeployment['provider'];
export type ArtifactKind = NonNullable<RecordedEnvironmentState['artifact']>['kind'];

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
