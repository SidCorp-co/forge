// Whether every provider the registry holds answers the questions asked of it.
//
// A registry is a single door only while what is behind it is uniform. Until
// ISS-1071 the capabilities object was optional behind an all-false fallback,
// so an adapter that declared nothing read as inert to every generic path and
// said so nowhere — five of seven adapters reached the registry through `as
// any`. Making the fields required in TypeScript closes that for code the
// compiler sees; it does not close it for a declaration assembled at run time,
// spread from a partial, or widened on its way in. This checks the object that
// actually reaches the map.
//
// Two of the rules are not shape rules and are the reason this file exists at
// all:
//
//   · `justification` on a `direct-mcp` arm is ISS-1071 rule 2 — a new provider
//     defaults to core-mediated, and exporting a project's credential to a
//     runner box is a decision that gets written down. A `direct-mcp` arm with
//     an empty justification fails NAMING the provider, because the whole value
//     of the field is that somebody had to type a sentence.
//   · `canDispatch` must agree with whether the adapter implements
//     `dispatchOutbound`. ISS-1062's rule is that a capability is declared or it
//     is absent, never declared and unimplemented — and until it landed nothing
//     defended that: `canDispatch` had no reader anywhere in core, six of seven
//     adapters satisfied a required `dispatchOutbound` with a stub that threw by
//     name, and github could have declared `true` beside its throwing stub with
//     all 22 verify checks still green. Both directions fail, because a provider
//     that implements a dispatch it does not declare is a capability no generic
//     path will ever reach for.
//   · `canDeploy` must agree with `@forge/contracts/deploy-capability`. Core's
//     production image does not carry contracts and a browser build cannot
//     resolve core, so the deploy capability is written on both sides of the
//     package boundary on purpose. Asking core's own `providerCanDeploy` here
//     would be a tautology — it reads this very field — so the comparison is
//     against the OTHER copy, which is the only one that can disagree.
//
// The input is a JSON projection of the live registry rather than the registry
// itself: the verdict logic is testable from a plain object, and the part that
// needs a TypeScript runtime stays in the CLI.

export const CAPABILITY_BOOLEANS = [
  'canDispatch',
  'canReceiveWebhook',
  'canDeploy',
  'liveConfirmGate',
  'hasDeliveryLog',
  'multiBinding',
];

export const AGENT_PATH_KINDS = ['none', 'core-mediated', 'direct-mcp'];

/** The five zod schemas every provider declares, whatever it integrates. */
export const SCHEMA_OBJECTS = [
  'connectionConfig',
  'bindingConfig',
  'patchConfig',
  'secrets',
  'patchSecrets',
];

// cm:guard these two are checked for DECLARATION and not for truthiness. Null is a legal answer —
// a provider that stores no rotating credential says so — and `undefined` is a provider that never
// answered. `rotation.ts` reads this instead of its own per-provider table, so the difference
// between "declares no primary credential" and "forgot to say" is the difference between a
// rotation that correctly does nothing and one that silently skips a provider that has one.
export const SCHEMA_NULLABLE_FIELDS = ['primaryCredentialField', 'previousCredentialField'];

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function capabilityReasons(caps) {
  if (!caps || caps.types === undefined) return ['declares no `capabilities` object'];
  const reasons = [];
  for (const field of CAPABILITY_BOOLEANS) {
    const seen = caps.types[field];
    if (seen === 'boolean') continue;
    reasons.push(
      seen === undefined || seen === 'undefined'
        ? `capabilities.${field} is missing`
        : `capabilities.${field} is a ${seen}, not a boolean`,
    );
  }
  return [...reasons, ...agentPathReasons(caps.agentPath)];
}

function agentPathReasons(path) {
  if (!path?.present) return ['capabilities.agentPath is missing'];
  if (!AGENT_PATH_KINDS.includes(path.kind)) {
    return [
      `capabilities.agentPath.kind is ${JSON.stringify(path.kind)}, ` +
        `not one of ${AGENT_PATH_KINDS.join(' | ')}`,
    ];
  }
  if (path.kind === 'none') return [];

  const reasons = [];
  if (path.toolsType !== 'array') {
    reasons.push(
      `a ${path.kind} agentPath carries tools: ${path.toolsType ?? 'missing'}, not an array`,
    );
  }
  if (path.kind !== 'direct-mcp') return reasons;

  if (!nonEmptyString(path.serverName)) {
    reasons.push('a direct-mcp agentPath declares no non-empty `serverName`');
  }
  // cm:guard this refusal names the PROVIDER and not only the field, because the reader who has to
  // act on it is deciding whether this provider should be direct-mcp at all. "justification is
  // empty" sends them to add a sentence; "epodsystem is direct-mcp and says why nowhere" sends them
  // to the question ISS-1071 rule 2 is actually about.
  if (!nonEmptyString(path.justification)) {
    reasons.push(
      "is direct-mcp — its credential is rendered into the runner's MCP config and Forge " +
        'is outside the call path — and carries no `justification`. Say why this provider ' +
        'offers no core-mediated route, or declare it core-mediated instead',
    );
  }
  if (path.buildEntryType !== 'function') {
    reasons.push(
      `a direct-mcp agentPath carries buildEntry: ${path.buildEntryType ?? 'missing'}, ` +
        'not a function — nothing can render its `mcpServers` entry',
    );
  }
  return reasons;
}

// cm:guard BOTH directions, and the second one is not pedantry: a provider whose adapter implements
// `dispatchOutbound` while declaring `canDispatch: false` has a capability every generic path is told
// it does not have, which is how a face ships and reaches nobody.
function dispatchReasons(decl) {
  const declared = decl.capabilities?.canDispatch;
  if (typeof declared !== 'boolean') return [];
  const implemented = decl.adapter?.dispatchOutboundType === 'function';
  if (declared === implemented) return [];
  return declared
    ? [
        'capabilities.canDispatch is true and the adapter implements no `dispatchOutbound`. A ' +
          'capability is declared or it is absent, never declared and unimplemented — implement it, ' +
          'or declare canDispatch: false until the change that does',
      ]
    : [
        'capabilities.canDispatch is false and the adapter implements `dispatchOutbound`. Every ' +
          'generic path is being told this provider cannot dispatch while it can, so the method is ' +
          'reachable by nothing — declare canDispatch: true, or delete the method',
      ];
}

function schemaReasons(schemas) {
  if (!schemas?.present) return ['declares no `schemas` object'];
  const reasons = [];
  for (const key of SCHEMA_OBJECTS) {
    if (schemas.types?.[key] === 'object') continue;
    reasons.push(`schemas.${key} is ${schemas.types?.[key] ?? 'missing'}, not a zod schema`);
  }
  if (schemas.types?.bindingConfigKeys !== 'array') {
    reasons.push(
      `schemas.bindingConfigKeys is ${schemas.types?.bindingConfigKeys ?? 'missing'}, not an array`,
    );
  }
  for (const key of SCHEMA_NULLABLE_FIELDS) {
    if (!schemas.declaredKeys?.includes(key)) {
      reasons.push(`schemas.${key} is not declared — null is the answer for "there is none"`);
      continue;
    }
    const seen = schemas.types?.[key];
    if (seen === 'string' || seen === 'null') continue;
    reasons.push(`schemas.${key} is a ${seen}, not a string or null`);
  }
  return reasons;
}

// cm:guard the comparison runs for a provider the contract list has never heard of too, and that
// asymmetry is deliberate: `contractCanDeploy` answers false for an unknown name, so a provider
// declaring `canDeploy: true` that the contracts copy does not list fails here rather than
// producing a screen that offers a deploy role the create schema then refuses.
function deployReasons(decl, contractCanDeploy) {
  const declared = decl.capabilities?.canDeploy;
  if (typeof declared !== 'boolean') return [];
  const mirrored = contractCanDeploy[decl.provider] === true;
  if (declared === mirrored) return [];
  return [
    `capabilities.canDeploy is ${declared} and @forge/contracts/deploy-capability says ` +
      `${mirrored}. The list is mirrored across the package boundary because neither package ` +
      'may import a runtime value from the other; fix whichever copy is wrong',
  ];
}

/**
 * Every provider whose declaration is missing something a generic path reads.
 *
 * @param report `{providers: [...projection], contractCanDeploy: {name: boolean}}`
 * @returns `Array<{provider: string, reasons: string[]}>`
 */
/**
 * What `canReceiveWebhook: true` commits a provider to declaring.
 *
 * `webhooks/inbound-routes.ts` derives BOTH the route and the signature header from these fields
 * and holds no list of its own. A provider declaring an inbound surface without saying which header
 * identifies it is never routed; one that names the route and not the signature is routed and then
 * refused `PROVIDER_DECLARES_NO_SIGNATURE_HEADER` on every delivery. Both are a live integration
 * that answers nothing, and neither shows up as anything but silence at the provider's end — which
 * is why they are caught at the gate rather than in a delivery log somebody has to think to open.
 */
// cm:guard the reverse is a fault too: a header declared with `canReceiveWebhook: false` is a route the filter drops, so the declaration says a delivery is handled and the router never builds the path. ISS-1071's defect was this shape one field over — correct routing for the providers already listed, silence for the new one.
function webhookReasons(caps) {
  if (!caps) return [];
  const reasons = [];
  const named = (k) => typeof caps[k] === 'string' && caps[k].length > 0;
  if (caps.canReceiveWebhook === true) {
    if (!named('webhookHeader')) {
      reasons.push(
        '`canReceiveWebhook` is true but `webhookHeader` names no header — the inbound router derives its route from that field, so this provider is declared to receive webhooks and is routed nowhere',
      );
    }
    if (!named('webhookSignatureHeader')) {
      reasons.push(
        '`canReceiveWebhook` is true but `webhookSignatureHeader` names no header — the router reads the signature header off this declaration, so every delivery is refused PROVIDER_DECLARES_NO_SIGNATURE_HEADER',
      );
    }
  } else {
    for (const k of ['webhookHeader', 'webhookSignatureHeader']) {
      if (named(k)) {
        reasons.push(
          `\`${k}\` names ${JSON.stringify(caps[k])} while \`canReceiveWebhook\` is ${JSON.stringify(caps.canReceiveWebhook)} — the router filters on the boolean, so this header builds no route and the declaration promises a surface that does not exist`,
        );
      }
    }
  }
  return reasons;
}

export function declarationFaults(report) {
  const contractCanDeploy = report?.contractCanDeploy ?? {};
  const faults = [];
  for (const decl of report?.providers ?? []) {
    const reasons = [];
    if (!nonEmptyString(decl.provider)) {
      reasons.push(`\`provider\` is ${JSON.stringify(decl.provider)}, not a non-empty string`);
    }
    reasons.push(
      ...capabilityReasons(decl.capabilities),
      ...webhookReasons(decl.capabilities),
      ...dispatchReasons(decl),
      ...schemaReasons(decl.schemas),
      ...deployReasons(decl, contractCanDeploy),
    );
    if (reasons.length > 0) {
      faults.push({ provider: decl.provider ?? '(unnamed declaration)', reasons });
    }
  }
  return faults;
}

// cm:guard a registry that registered nothing is exit 2 and never exit 0. `registerAllIntegrations`
// is one call away from being a no-op — an import dropped, a side-effecting module tree-shaken, a
// throw swallowed — and "no provider is missing a field" is exactly what an empty map reports.
/** @returns a sentence when the report cannot be judged at all, or null when it can. */
export function unusableReport(report) {
  if (!Array.isArray(report?.providers)) return 'the probe returned no `providers` array';
  if (report.providers.length === 0) {
    return 'the registry holds no declaration — `registerAllIntegrations()` registered nothing';
  }
  if (!report.contractCanDeploy || Object.keys(report.contractCanDeploy).length === 0) {
    return '@forge/contracts/deploy-capability yielded no list to compare canDeploy against';
  }
  return null;
}
