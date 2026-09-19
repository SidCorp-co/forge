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
