// What both allowlisted rules take, written once: a field added to one of two copies is a
// schema the other rejects. `why` is required, so an exemption carries its reason.
export const ALLOW_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
    value: { type: "string" },
    why: { type: "string", minLength: 1 },
  },
  required: ["value", "why"],
  additionalProperties: false,
};

export const ALLOWLIST_OPTIONS = {
  allow: { type: "array", items: ALLOW_ENTRY_SCHEMA },
  exemptFiles: { type: "array", items: { type: "string" } },
  tokenSource: { type: "string" },
};
