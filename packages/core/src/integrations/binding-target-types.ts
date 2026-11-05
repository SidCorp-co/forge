// What a provider's `verifyBindingTarget` is handed and answers (`types.ts:IntegrationAdapterMethods`).

/** A binding target the provider refused, at a path inside `target`. */
export interface BindingTargetRefusal {
  code:
    | 'COOLIFY_APPLICATION_UNKNOWN'
    | 'COOLIFY_UNREACHABLE'
    | 'SOURCE_HOST_MISMATCH'
    | 'SOURCE_REPOSITORY_LOCAL'
    | 'GITHUB_INSTALLATION_NOT_RECORDED'
    | 'WIDGET_SITE_KEY_MINTED'
    | 'WIDGET_SITE_KEY_TAKEN'
    | 'SUPPORT_ROOM_NOT_ONE_GROUP'
    | 'SUPPORT_ROOM_TWO_KINDS'
    | 'SUPPORT_GRANT_TARGET_UNKNOWN'
    | 'SUPPORT_OWNER_MODE_NOT_AGENT'
    | 'SUPPORT_CHECK_NOT_AGENT'
    | 'SUPPORT_CHECK_ROOM_UNKNOWN'
    | 'SUPPORT_OWNER_ROOM_UNKNOWN'
    | 'AGENT_SWITCH_NOT_READY'
    | 'SUPPORT_AGENT_PROJECT_UNKNOWN'
    | 'SUPPORT_AGENT_PROJECT_NOT_ADMIN'
    | 'SUPPORT_AGENT_PROJECTS_NOT_AGENT'
    | 'SUPPORT_ROOM_ANSWERED_TWICE'
    | 'SUPPORT_ROOM_OVERRIDE_UNKNOWN'
    | 'SUPPORT_TOOL_NAME_TAKEN';
  path: string;
  detail: string;
}

export interface VerifyBindingTargetArgs {
  projectId: string;
  /** The binding being written, so a check across bindings leaves this one out. */
  bindingId: string;
  /** Who writes it: a target naming another project is theirs to name only where they may (ISS-874). */
  userId: string;
  connection: {
    secretsEnc: Buffer | null;
    id: string;
    ownerType: string;
    config: unknown;
    displayName?: string | null;
  };
  /** The binding-tier config the document encodes to. */
  config: Record<string, unknown>;
  /** What the row already holds on this same connection, which was verified when written. */
  held: Record<string, unknown> | null;
  /** The label the binding is written under: '' for a provider's one (or first) binding. */
  label: string;
  /** Whether the binding is written switched on: a switched-off one serves nothing to clash with. */
  active: boolean;
  /**
   * The other bindings the same write stores (a connection created with several bindings), not
   * readable yet: a check across bindings reads them beside the stored ones.
   */
  alongside: readonly AlongsideBinding[];
}

/** A binding written in the same call as the one being verified. */
export interface AlongsideBinding {
  projectId: string;
  bindingId: string;
  provider: string;
  label: string;
  config: Record<string, unknown>;
  active: boolean;
  /** Its connection's name, where the call names one. */
  displayName: string | null;
}
