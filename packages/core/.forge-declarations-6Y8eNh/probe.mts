import { registerAllIntegrations } from '../src/integrations/register-all.js';
import { listIntegrations } from '../src/integrations/registry.js';
import { DEPLOY_CAPABLE_PROVIDERS } from '../../contracts/src/deploy-capability.js';

const report = { providers: [], contractCanDeploy: {} };
registerAllIntegrations();
for (const name of DEPLOY_CAPABLE_PROVIDERS) report.contractCanDeploy[name] = true;

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const BOOLEANS = ['canDispatch','canReceiveWebhook','canDeploy','liveConfirmGate','hasDeliveryLog','multiBinding'];

for (const decl of listIntegrations()) {
  const caps = decl && decl.capabilities;
  const path = caps && caps.agentPath;
  report.providers.push({
    provider: decl && decl.provider,
    capabilities: !caps ? undefined : {
      types: Object.fromEntries(BOOLEANS.map((k) => [k, typeOf(caps[k])])),
      canDeploy: caps.canDeploy,
      agentPath: {
        present: path !== undefined && path !== null,
        kind: path && path.kind,
        toolsType: path && typeOf(path.tools),
        serverName: path && path.serverName,
        justification: path && path.justification,
        buildEntryType: path && typeOf(path.buildEntry),
      },
    },
    schemas: !decl || !decl.schemas ? { present: false } : {
      present: true,
      declaredKeys: Object.keys(decl.schemas),
      types: Object.fromEntries(Object.entries(decl.schemas).map(([k, v]) => [k, typeOf(v)])),
    },
  });
  if (report.contractCanDeploy[decl.provider] === undefined) {
    report.contractCanDeploy[decl.provider] = false;
  }
}

console.log('<<<FORGE_DECLARATIONS');
console.log(JSON.stringify(report));
console.log('FORGE_DECLARATIONS>>>');
// The pool opened by importing the store holds a socket handle, so the probe would finish its
// work and then sit there — which reads to the caller as a checker that hangs rather than answers.
process.exit(0);
