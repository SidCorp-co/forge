// What credential-doors.test.ts claims about every request access core's source makes: what each
// carrier member does, and for each input read by name, each whole read and each hono-family
// import, whether a presented credential arrives through it and why. The scan
// (credential-access.fixture.ts) finds the accesses by type; these tables are the claims a reviewer
// checks, and the test refuses an access none of them names, and an entry no access reads.

import type { Role, Surface } from './credential-ast.fixture.js';

/** The names of a template literal, split on whitespace. */
const words = (s: TemplateStringsArray) => s.join('').split(/\s+/).filter(Boolean);
/** The lines of a template literal, trimmed, blank lines dropped. */
const lines = (s: TemplateStringsArray) =>
  s
    .join('')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Each carrier's members, by what they do (credential-ast.fixture.ts:Role). */
const members = (roles: Partial<Record<Role, string>>): ReadonlyMap<string, Role> =>
  new Map(
    Object.entries(roles).flatMap(([role, names]) =>
      (names ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((n) => [n, role as Role] as const),
    ),
  );

/** What each member of each carrier does; a member not listed here is refused by the scan. */
export const SURFACE: Surface = {
  Context: members({
    carrier: 'req',
    var: 'get',
    whole: 'env var',
    none: 'set json text body html redirect notFound newResponse header status res error finalized executionCtx',
  }),
  HonoRequest: members({
    carrier: 'raw',
    header: 'header',
    query: 'query queries',
    param: 'param',
    fields: 'valid',
    whole: 'json text parseBody formData arrayBuffer blob url',
    none: 'method path routePath matchedRoutes',
  }),
  Request: members({
    carrier: 'headers clone',
    whole: 'url json text formData arrayBuffer blob body bytes',
    none: 'method signal',
  }),
  Headers: members({
    header: 'get has',
    whole: 'getSetCookie entries keys values forEach',
    none: 'set append delete',
  }),
  URL: members({
    carrier: 'searchParams',
    whole: 'search href toString toJSON username password hash',
    none: 'pathname origin host hostname port protocol',
  }),
  URLSearchParams: members({
    query: 'get getAll has',
    whole: 'entries keys values forEach toString',
    none: 'size set append delete sort',
  }),
  IncomingMessage: members({
    carrier: 'headers',
    whole: 'rawHeaders headersDistinct url pipe read',
    event: 'on once',
    none: 'method statusCode statusMessage socket destroy resume',
  }),
  // every member of a header record is a header, read by its own name
  IncomingHttpHeaders: members({}),
  WebSocket: members({
    event: 'on once',
    none: 'send close terminate ping readyState OPEN bufferedAmount',
  }),
};

/** Each input a presented secret arrives in, by `<kind>:<name>`, and what it carries. */
export const CREDENTIAL_INPUTS: Readonly<Record<string, string>> = {
  'header:authorization': 'a bearer token: a PAT, a session JWT, a box token',
  'header:cookie': 'the session, refresh and preview viewer cookies',
  'header:sec-websocket-protocol': 'a browser socket’s bearer, as forge.bearer.<token>',
  'query:ticket': 'a preview ticket, spent once for the viewer cookie',
  'param:token': 'an invitation token, looked up by its digest',
  'field:json:password': 'a password: checked at sign-in and re-auth, hashed at sign-up',
  'field:json:pairing_code': 'a device login’s pairing code, approved by a signed-in person',
  'field:query:pairing_code': 'the same code, polled with no session for the box credential',
  'field:json:token': 'a share link’s token, opening one share',
  'field:query:token': 'an email verification token',
  'field:query:code': 'an OAuth authorization code; /pair passes a pairing code on',
  'field:query:state': 'an OAuth or GitHub connect state, checked against its cookie or HMAC',
  'field:param:uploadId': 'an upload ticket: holding it is the right to write one file',
  'field:param:ticketId': 'a download ticket: holding it is the right to read one file',
};

const ROW_KEYS = 'an id, key, number or slug naming a row, checked under the caller’s permissions';

/** Every input no credential arrives in, grouped by why. */
export const PLAIN_INPUTS: Readonly<Record<string, readonly string[]>> = {
  'a header no credential rides in: media types, sizes, the proxy’s view, a trace id': words`
    header:accept header:accept-encoding header:cf-ray header:content-encoding
    header:content-length header:content-type header:host header:link header:origin header:range
    header:referer header:sec-fetch-dest header:user-agent header:x-forwarded-for
    header:x-forwarded-host header:x-forwarded-proto header:x-next-page header:x-real-ip
    header:x-request-id`,
  'a header core’s own clients send: what they render, the project an /mcp call names': words`
    header:x-forge-capabilities header:x-forge-project-slug header:x-forge-unresolved-ref`,
  [ROW_KEYS]: words`
    param:bindingId param:file param:id param:projectId param:provider param:questionId param:slug param:target
    param:templateId param:version query:projectId
    field:param:agentUserId field:param:aid field:param:approvalId field:param:at
    field:param:attachmentId field:param:bid field:param:bindingId field:param:code
    field:param:commentId field:param:contract field:param:did field:param:doc field:param:edgeId
    field:param:executionId field:param:fb field:param:fireId field:param:id field:param:issue
    field:param:issueId field:param:issueKey field:param:itemId field:param:key field:param:link
    field:param:memoryId field:param:mk field:param:module field:param:name field:param:number
    field:param:orgId field:param:participantId field:param:patternId field:param:pid
    field:param:profileId field:param:project field:param:projectId field:param:provider
    field:param:queryId field:param:ref field:param:reportId field:param:req
    field:param:requestId field:param:run field:param:runId field:param:runnerId
    field:param:scheduleId field:param:scope field:param:sessionId field:param:shareId
    field:param:sid field:param:skillId field:param:slug field:param:templateId
    field:param:turnId field:param:userId field:param:version field:param:waitId
    field:param:workflow field:param:workflowId
    field:query:assignee field:query:assigneeId field:query:connectionId field:query:createdBy
    field:query:deviceId field:query:installation_id field:query:integrationId field:query:issue
    field:query:issueId field:query:memoryId field:query:org field:query:orgId
    field:query:pipelineRunId field:query:projectId field:query:requirement
    field:query:resourceUuid field:query:rootIssueId field:query:runId field:query:sessionId
    field:query:sourceRef field:query:feedback field:query:workflow field:query:ref
    field:json:activeOrgId field:json:agentSessionId field:json:agent_id field:json:areaId
    field:json:assigneeId field:json:attachmentIds field:json:boundProjectId
    field:json:claudeSessionId field:json:clientToken field:json:dependsOnId
    field:json:deploymentUuid field:json:deviceId field:json:duplicateOf field:json:externalId
    field:json:fromTurnId field:json:id field:json:ids field:json:inReplyTo
    field:json:integrationId field:json:issue field:json:issueId field:json:issueIds
    field:json:issueKey field:json:issueKeys field:json:jobId field:json:knowledgeEntryId
    field:json:optionId field:json:orgId field:json:parentId field:json:passId field:json:patchId
    field:json:pipelineRunId field:json:project field:json:projectId field:json:projectIds
    field:json:providerRef field:json:recommendedOptionId field:json:ref field:json:requirement
    field:json:resourceUuid field:json:run field:json:runId field:json:runIds field:json:runnerId
    field:json:sessionId field:json:slug field:json:sourceRef field:json:subjectId
    field:json:targetProjectSlug field:json:targetRef field:json:templateId field:json:turnId
    field:json:userId field:json:workflowId field:json:signalKey field:json:detectorKey
    field:json:operationId field:json:issuePrefix`,
  'prose a person or an agent writes: a title, a body, a message, a note': words`
    field:json:about field:json:acceptanceCriteria field:json:alt field:json:answer
    field:json:assistantInstructions field:json:assumed field:json:body field:json:brief
    field:json:caption field:json:changeSummary field:json:content field:json:description
    field:json:detail field:json:diagnosis field:json:greeting field:json:instructions
    field:json:intro field:json:message field:json:narrative field:json:note
    field:json:observedSteps field:json:plan field:json:prompt field:json:reason
    field:json:releaseNotes field:json:soul field:json:summary field:json:text
    field:json:textContent field:json:title field:json:tldr field:json:why field:json:whereSeen
    field:json:raw field:json:localGuide field:json:skillMd field:json:decision
    field:json:triage field:json:suggestion field:json:evidence field:json:emoji field:json:name
    field:json:displayName field:json:shortName field:json:request field:json:account`,
  'a structured part of a record core validates and stores; it admits nobody': words`
    field:json:agentReport field:json:answers field:json:artifact field:json:attachments
    field:json:awaitsDesign field:json:awaitsMerge field:json:block field:json:blocker
    field:json:build field:json:capabilities field:json:carried field:json:category
    field:json:changes field:json:checklist field:json:checkpoint field:json:checks
    field:json:codes field:json:color field:json:config field:json:contract field:json:contracts
    field:json:createIssue field:json:criteria field:json:cron field:json:designs
    field:json:dialog field:json:diff field:json:disk field:json:document field:json:drift
    field:json:ecosystem field:json:edges field:json:events field:json:expect field:json:facts
    field:json:feedback field:json:fields field:json:files field:json:findings field:json:from
    field:json:gate field:json:grants field:json:handle field:json:handles field:json:identity
    field:json:inputs field:json:issues field:json:items field:json:kind field:json:labels
    field:json:mergeRefused field:json:merged field:json:messages field:json:metadata
    field:json:mime field:json:model field:json:modules field:json:names field:json:needed
    field:json:needs field:json:node field:json:options field:json:params field:json:path
    field:json:paths field:json:pattern field:json:payload field:json:people field:json:phase
    field:json:picture field:json:plugins field:json:pool field:json:presence field:json:probe
    field:json:probes field:json:record field:json:relations field:json:release
    field:json:salvage field:json:scope field:json:screen field:json:script field:json:semantic
    field:json:session field:json:sessionContext field:json:skill field:json:skillNames
    field:json:skillsRanWith field:json:snapshot field:json:source field:json:spec
    field:json:standing field:json:step field:json:steps field:json:stillWaits
    field:json:subject field:json:target field:json:targetPhase field:json:targets field:json:to
    field:json:touched field:json:turnError field:json:type field:json:uiSnapshot
    field:json:usage field:json:value field:json:verdict field:json:via field:json:voidQuestions
    field:json:workState field:json:workflow field:json:worktree field:json:query
    field:json:error field:json:origin field:json:contentBase64 field:json:binaries
    field:json:endpoint field:json:by field:json:cites field:json:intent field:json:recommended
    field:json:reportedBy`,
  'a time, a version or a time zone': words`
    field:json:agentVersion field:json:dueAt field:json:dueBy field:json:expectedEditedAt
    field:json:expiresAt field:json:minVersion field:json:parkDeadlineAt field:json:readAt
    field:json:readWhen field:json:timeZone field:json:until field:json:validUntil
    field:json:startedAt field:json:version`,
  'a git name: a branch, a commit, a path in a repository': words`
    field:json:agentCommit field:json:atSha field:json:base field:json:branch field:json:commit
    field:json:head field:json:repoPath field:json:sha`,
  'what a box says about itself: its name, its platform, a machine id core hashes': words`
    field:json:device_hostname field:json:device_label field:json:device_platform
    field:json:machine_id`,
  'a third party’s token core stores or forwards to that service; it checks no caller': words`
    field:json:apiToken field:json:authToken field:json:secrets`,
  'an address: a mailbox, a service URL, a git host, where to go after sign-in': words`
    field:json:baseUrl field:json:serverUrl field:json:host field:json:protocol
    field:json:email field:query:email field:query:redirect`,
  'a filter, a sort, a page or a view of a read; a provider’s error code': words`
    field:query:after field:query:archived field:query:before field:query:category
    field:query:cites field:query:cursor field:query:includeFiles field:query:intent
    field:query:key field:query:kind field:query:label field:query:metadataType
    field:query:module field:query:party field:query:q field:query:search field:query:status
    field:query:step field:query:steps field:query:verb field:query:view field:query:error`,
  'a value core’s own middleware set once it admitted the caller, never the secret': words`
    var:agency var:agentUserId var:authUserResolution var:chatWriteAdmitted var:device
    var:deviceId var:onBehalfOf var:patDeviceId var:patRequestClass var:patRequestResolution
    var:patActRecorded var:patRequestWrites var:patTokenId var:principal var:requestId var:sessionCookie
    var:user var:userId var:userTokenResolution`,
};

/** Each whole read a presented secret arrives in, by `<module> <what> in <owner>`, and what. */
export const CREDENTIAL_READS: Readonly<Record<string, string>> = {
  'auth/oauth/handler.ts Context handed to hono:getCookie in handleCallback':
    'the OAuth state cookie',
  'auth/oauth/handler.ts HonoRequest.url in handleCallback':
    'the callback URL: the provider’s code and state',
  'auth/oauth/handler.ts URL.search in handleCallback': 'the same callback query',
  'integrations/identity/github.ts URL handed to openid-client:authorizationCodeGrant in githubProvider':
    'the callback URL, its code exchanged with GitHub',
  'integrations/identity/oidc.ts URL handed to openid-client:authorizationCodeGrant in finish':
    'the callback URL, its code exchanged with the provider',
  'integration-door/webhook-inbound-routes.ts HonoRequest.header(map.signatureHeader) in module code':
    'a provider’s body signature or shared token',
  'orgs/invitations-routes.ts HonoRequest.param() in module code':
    'the path parameters, the invitation token among them',
  'projects/invitations-routes.ts HonoRequest.param() in module code':
    'the path parameters, the invitation token among them',
  ...Object.fromEntries(
    lines`
      previews/relay.ts IncomingHttpHeaders handed to @types/node:httpRequest in relayPreviewRequest
      previews/relay.ts IncomingHttpHeaders handed to @types/node:httpRequest in relayPreviewUpgrade
      previews/relay.ts IncomingHttpHeaders handed to lib:entries in upstreamHeaders
      previews/relay.ts IncomingHttpHeaders[name] in upstreamHeaders
      previews/relay.ts IncomingMessage.rawHeaders in relayPreviewUpgrade
      previews/relay.ts IncomingMessage.url in relayPreviewRequest
      previews/relay.ts IncomingMessage.url in relayPreviewUpgrade`.map((key) => [
      key,
      'a viewer’s request, forwarded to the preview with Forge’s cookies cut out; its URL may carry a ticket',
    ]),
  ),
};

/** Every whole read no credential arrives in, grouped by why. */
export const PLAIN_READS: Readonly<Record<string, readonly string[]>> = {
  'an outbound URL, header set or module URL core builds, never a request to core': lines`
    assistant/identity/link-url.ts URLSearchParams.toString in speakerLinkUrl
    integrations/autoflow/refresh.ts URLSearchParams.toString in requestRefresh
    integrations/deploy/coolify/client.ts URLSearchParams.toString in CoolifyClient
    integrations/deploy/coolify/health-probe.ts URL handed to @types/node:fetchImpl in probeHealth
    integrations/deploy/kept-probe-request.ts Headers handed to @types/node:fetchImpl in sendKeptProbeRequest
    integrations/deploy/runtime-probe.ts URL handed to @types/node:fetchImpl in readRuntimeProbe
    integrations/github/octokit.ts URL handed to @types/node:inner in boundedFetch
    integrations/github/published-releases/fetch-release.ts URL.href in isMain
    integrations/identity/github.ts URL.href in githubProvider
    integrations/identity/oidc.ts URL handed to openid-client:discovery in configFor
    integrations/identity/oidc.ts URL.href in start
    integrations/inbound-door.ts URL.search in sameEndpoint
    integrations/llm/embeddings-client.ts URL handed to @types/node:fetchFn in timedFetch
    integrations/rocketchat/rest-client.ts URLSearchParams.toString in rcGet
    integrations/sentry/endpoints.ts URLSearchParams.toString in sentryOrgIssuesUrl
    sandbox/run.ts URL handed to @types/node:Worker in runScript
    sandbox/run.ts URL.href in workerEntry
    skills/builtin-seed.ts URL handed to @types/node:fileURLToPath in defaultSkillsRoot`,
  'a cookie written or cleared on the answer, never read': lines`
    auth/oauth/state.ts Context handed to hono:deleteCookie in clearStateCookie
    auth/oauth/state.ts Context handed to hono:setCookie in setStateCookie
    credentials/cookie.ts Context handed to hono:deleteCookie in clearSessionCookie
    credentials/cookie.ts Context handed to hono:deleteCookie in writeSessionCookie
    credentials/cookie.ts Context handed to hono:setCookie in writeSessionCookie`,
  'frames on a socket core opened to Rocket.Chat': lines`
    integrations/rocketchat/ddp-client.ts WebSocket.on cast to WsLike in RocketChatDdpClient`,
  'a file’s bytes, stored as an attachment or upload': lines`
    agent-sessions/attachment-routes.ts HonoRequest.parseBody in module code
    comments/attachment-routes.ts HonoRequest.parseBody in module code
    issues/attachment-routes.ts HonoRequest.parseBody in module code
    uploads/routes.ts HonoRequest.arrayBuffer in module code`,
  'a chat’s held write, its body and query replayed as they came once the person agrees': lines`
    assistant/agreement/rest-hold.ts HonoRequest.arrayBuffer in holdSessionWrite
    assistant/agreement/rest-hold.ts HonoRequest.url in holdSessionWrite
    assistant/agreement/rest-hold.ts URL.search in holdSessionWrite`,
  'a validated target whose type names no fixed keys; the handler reads the fields it names': lines`
    auth/oauth/routes.ts HonoRequest.valid(query) in module code
    comments/entity-routes.ts HonoRequest.valid(param) in module code
    ecosystem/link-routes.ts HonoRequest.valid(json) in module code
    ecosystem/project-routes.ts HonoRequest.valid(json) in module code
    ecosystem/routes.ts HonoRequest.valid(json) in module code
    integration-door/github-connect-routes.ts HonoRequest.valid(query) in module code
    integration-door/issue-merge-routes.ts HonoRequest.valid(json) in module code
    integration-door/issue-merge-routes.ts HonoRequest.valid(param) in module code
    issues/merge-routes.ts HonoRequest.valid(json) in runMergeMarker
    issues/merge-routes.ts HonoRequest.valid(param) in runMergeMarker
    jobs/lifecycle-routes.ts HonoRequest.valid(json) in module code
    project-config/routes.ts HonoRequest.valid(json) in module code
    projects/master-charter-routes.ts HonoRequest.valid(json) in module code
    release-batch/version-routes.ts HonoRequest.valid(json) in module code
    requirements/route-kit.ts HonoRequest.valid(json) in draftPictureFits
    workflows/routes.ts HonoRequest.valid(json) in module code`,
  'the request handed to core’s own router, gates and body checks, which read it here': lines`
    index.ts Request handed to hono:fetch in module code
    middleware/route-refs.ts Request handed to hono:dispatch in resolvingRouteRefs
    middleware/route-refs.ts Context handed to hono:authenticate in refuseUnresolvedRefs
    middleware/zod-validator.ts Context handed to hono:middleware in refuseUndeclaredBodyType
    lib/upload-body-limit.ts Context handed to hono:limiter in uploadBodyLimit
    middleware/chat-write-hold.ts Context handed to hono:matchedRoutes in chatWriteRouteOf
    middleware/pat-rest-surface.ts Context handed to hono:matchedRoutes in routeIsServed`,
  'the path, the query or the origin, read for a route reference, a link back or a route id': lines`
    middleware/route-refs.ts Request.url in resolveRouteRefs
    devices/install-routes.ts HonoRequest.url in module code
    guides/routes.ts HonoRequest.url in module code
    integration-door/github-connect-routes.ts HonoRequest.url in assertApiOriginReachable
    requirements/route-kit.ts HonoRequest.param() in draftPictureFits
    workflows/template-routes.ts HonoRequest.param() in module code
    questions/routes.ts HonoRequest.param(…) handed to questionId as { param: (k: string) => string; } in module code`,
  'a request or socket used only as a key of a WeakMap': lines`
    middleware/route-refs.ts Request handed to lib:get in routeRefMs
    middleware/route-refs.ts Request handed to lib:set in resolveRouteRefs
    previews/tunnel.ts WebSocket handed to lib:get in acceptTunnelUpgrade
    previews/tunnel.ts WebSocket handed to lib:set in acceptTunnelUpgrade`,
  'whether a body arrived where a route declares none; it is refused unread': lines`
    middleware/zod-validator.ts HonoRequest.text in refuseUndeclaredBodyType
    middleware/zod-validator.ts Request.body in refuseUndeclaredBodyType`,
  'x-forge-capabilities, the one header clientCapabilities reads': lines`
    comments/routes.ts HonoRequest.header(…) handed to clientCapabilities as Pick<HonoRequest<"/", {}>, "header"> in module code
    comments/routes.ts HonoRequest.header(…) handed to clientCapabilities as Pick<HonoRequest<"/", {}>, "header"> in registerIssueCommentRoutes`,
  'a webhook’s event headers and body, read once its signature verified': lines`
    integration-door/webhook-inbound-routes.ts HonoRequest.header(m.header) in module code
    integration-door/webhook-inbound-routes.ts Headers handed to lib:fromEntries in module code
    integration-door/webhook-inbound-routes.ts Request.text in module code`,
  'the /mcp request requirePat admitted: the SDK verifies nothing, the class reads the tool': lines`
    mcp/handler.ts Request handed to @modelcontextprotocol/sdk:handleRequest in mcpHandler
    mcp/request-class.ts Request.json in mcpRequestClass`,
  'the preview’s answer, a viewer’s body streamed through unread, the recorder’s own path': lines`
    previews/relay.ts IncomingHttpHeaders handed to lib:entries in downstreamHeaders
    previews/relay.ts IncomingMessage.on(data) in bodyOf
    previews/relay.ts IncomingMessage.on(data) in injectRecorder
    previews/relay.ts IncomingMessage.pipe in relayPreviewRequest
    previews/relay.ts IncomingMessage.pipe in relayPreviewUpgrade
    previews/relay.ts IncomingMessage.url in serveRecorder`,
  'the storefront MCP relay, once its relay ticket verified: the transport headers it passes by name, the agent’s message relayed as sent, and the provider’s answer core passes back': lines`
    integrations/mcp-relay.ts Headers handed to @types/node:fetch in relayToUpstream
    integrations/mcp-relay.ts Headers handed to undici-types:Response in relayToUpstream
    integrations/mcp-relay.ts Headers.get(name) in relayToUpstream
    integration-door/mcp-relay-routes.ts HonoRequest.arrayBuffer in module code
    integration-door/mcp-relay-routes.ts HonoRequest.header(name) in module code`,
  'a socket ws/server.ts opened for a person or a box, and its frames: subscribe, runner': lines`
    previews/tunnel.ts IncomingMessage handed to @types/ws:handleUpgrade in acceptTunnelUpgrade
    previews/tunnel.ts WebSocket.on(message) in adoptTunnel
    ws/server.ts WebSocket handed to @types/node:emit in attachWs
    ws/server.ts WebSocket.on(message) in attachWs`,
};

/** Every value import of hono, hono/* and @hono/*: whether it reads a credential, and why. */
export const FRAMEWORK_IMPORTS: Readonly<Record<string, { credential: boolean; why: string }>> = {
  'hono:Hono': { credential: false, why: 'the router' },
  'hono/http-exception:HTTPException': { credential: false, why: 'an error answer' },
  'hono/cookie:getCookie': { credential: true, why: 'reads a named cookie' },
  'hono/cookie:setCookie': { credential: false, why: 'writes a cookie on the answer' },
  'hono/cookie:deleteCookie': { credential: false, why: 'clears a cookie on the answer' },
  'hono/cors:cors': { credential: false, why: 'reads Origin, admits nobody' },
  'hono/body-limit:bodyLimit': { credential: false, why: 'counts body bytes' },
  'hono/route:matchedRoutes': { credential: false, why: 'which routes matched' },
  'hono/utils/constants:COMPOSED_HANDLER': { credential: false, why: 'a marker constant' },
  'hono/utils/handler:findTargetHandler': { credential: false, why: 'a route’s own handler' },
  'hono/utils/handler:isMiddleware': { credential: false, why: 'whether a handler is middleware' },
  '@hono/node-server:serve': { credential: false, why: 'serves app.fetch on a Node server' },
  '@hono/zod-validator:zValidator': {
    credential: false,
    why: 'fills valid(); each field it yields is classified above',
  },
};
