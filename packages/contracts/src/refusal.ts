// The one refusal body, at REST and MCP alike (docs/conventions/domain-entities.md).
export type Refusal = {
  code: string;
  path: string;
  detail: string;
};

export type RefusalEnvelope = {
  error: {
    code: string;
    message: string;
    refusals: Refusal[];
  };
};
