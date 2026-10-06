# 0007 — Approval is a permission

**Status:** accepted · **Date:** 2026-10-04

## Context

Who may approve, accept, agree, sign or verify was decided in thirteen places, each by its own
rule and under its own refusal code. Most read the actor's agency: "a person's act, an agent is
refused" for requirement sign-off, suggestion and mockup decisions, feedback triage and verify,
release approval and plan approval. Some read authorship: "the author never accepts their own"
for mockups, suggestions and release requests. Workflow designs and contract versions added a
project-document knob (`workflows.designApprover`, `contracts.approver`) choosing between "an org
admin person" and "the project's master", and a breaking contract version needed a person whatever
the knob said. An agent token the owner trusted could approve nothing, and a reader had to know
which door they came through to know who could act.

The owner ruled on 2026-10-04: "Không chặn người duyệt, cái đó sẽ tính theo dạng permission, kể cả
AAT có permission cũng duyệt được" (do not block the approver; it is decided as a permission, and an
agent access token holding the permission approves too).

## Decision

- **Every approve-type act asks one question**: does the actor hold `<resource>.approve` on the
  project? The resources are `requirements`, `mockups`, `suggestions`, `workflow-designs`,
  `contracts`, `feedback`, `releases` and `plans` (`@forge/contracts/permissions:APPROVAL_RESOURCES`).
- **The one permission check decides it**: `packages/core/src/permissions/can.ts` — `holds` for a
  read flag, `permissionRefusal` / `permissionRefusalFor` for a write, the same check every other
  permission in core goes through. Nothing compares agency or authorship for an approval.
- **The grant is the effective project role plus the membership's grant**: an org owner or admin
  holds `admin` on every project of the org, and `project_members.grants` names permissions held
  beyond the role. By default `admin` holds every approve permission
  (`@forge/contracts/permissions:ROLE_PERMISSIONS`); member and viewer hold none.
- **An agent is an account like any other.** An agent token approves when its account holds the
  permission and its token reaches the route (the route's `<resource>:write` grant, as for any
  write). The orchestrator's dev agents are members holding a grant of the approve permissions
  they need, not admins.
- **A token approves only where its grant names the approval** (ISS-187). Every
  `<resource>.approve` is in `@forge/contracts/permissions:TOKEN_EXPLICIT_PERMISSIONS`, so neither a
  full grant (`*`) nor a legacy token reaches one: a write-scoped token of an admin no longer
  approves all eight resources by holding the role. A person names the approvals when minting a
  token (`POST /api/pat { permissions }`). A credential core mints for an agent (its account
  token, its box's and its checkouts') names the explicit permissions its memberships grant, and
  changing a membership's grant re-grants the agent's live credentials in the same transaction
  (`packages/core/src/permissions/agent-fence.ts:regrantAgentCredentials`). A turn's token, which acts for
  the person whose message it answers, names none, so a turn never approves. This attenuates the
  token; it is not a person-only rule, and an agent token holding the grant approves.
- **Who acted, with which credential, for whom.** The actor is
  `{ userId, agency, tokenId, onBehalfOf }` (`packages/core/src/permissions/actor.ts:Actor`), and
  every kernel move records the token and the person it acts for
  (`kernel_transitions.actor_token_id`, `actor_on_behalf_of`). A token records whom it was handed to
  act for (`personal_access_tokens.on_behalf_of`): a turn's token the person it answers, a checkout's
  token the person who paired the box. No rule reads either; they answer who approved and through
  what.
- **No author rule.** The author of a proposal, the asker of a release and the producer of a
  suggestion approve their own when they hold the permission.
- **One refusal**: `PERMISSION_FORBIDDEN`, 403 in the envelope, carrying `permission` and `scope`
  beside `code`, `path` and `detail`, the same refusal every missing permission answers. The old
  codes are deleted:
  `MOCKUP_DECIDE_FORBIDDEN`, `MOCKUP_ACCEPT_OWN_FORBIDDEN`, `REQUIREMENT_SIGNOFF_FORBIDDEN`,
  `SUGGESTION_ACCEPT_FORBIDDEN`, `SUGGESTION_REVISE_FORBIDDEN`, `WORKFLOW_DESIGN_APPROVER_NOT_PERSON`,
  `WORKFLOW_DESIGN_APPROVER_NOT_ADMIN`, `WORKFLOW_DESIGN_APPROVER_NOT_PROJECT`,
  `CONTRACT_APPROVER_NOT_PERSON`, `CONTRACT_APPROVER_NOT_ADMIN`, `CONTRACT_APPROVER_NOT_PROJECT`,
  `CONTRACT_BREAKING_NEEDS_PERSON`, `FEEDBACK_DECIDE_FORBIDDEN`, `FEEDBACK_VERIFY_FORBIDDEN`,
  `RELEASE_APPROVER_IS_AGENT`, `RELEASE_APPROVER_NOT_ADMIN`, `RELEASE_APPROVAL_SELF`. Plan approval
  keeps `PLAN_REQUIRED` for a missing plan and refuses the permission under the new code.
- **Every approval still records who decided and why**, in the act's own row (`decided_by`,
  `reason`, and the agency column where the table has one), and an approval that moves a status
  records its credential and delegation on the `kernel_transitions` row.
- **The two person-or-master knobs are retired.** A stored document carrying
  `workflows.designApprover` or `contracts.approver` still reads; a write naming either is refused
  `APPROVER_POLICY_RETIRED` (`packages/core/src/project-config/rules.ts`), and nothing reads them
  (amnesty ISS-159 in `packages/core/src/project-config/schema.ts`, until no stored document carries
  them).

## Consequences

- A project member who signed off requirements, decided suggestions and mockups or triaged feedback
  as a person no longer does by default: those acts now take `admin`. Making members approvers is
  one line in `ROLE_PERMISSIONS`; making one member an approver is a grant
  (`PATCH /api/projects/:id/members/:userId { grants }`), not a new rule.
- A grant gives approval without configuration or member powers, which a role change to `admin`
  would also hand over.
- A person who approved through a token with a full grant re-mints it naming the approvals, or
  approves signed in. An agent's credentials that were live when this landed were re-granted from
  their memberships by migration 0391.
- A separation-of-duties policy (a distinct approver, a person required for a resource) is not
  built. Were it wanted, it is an opt-in project policy read only inside `can()`, default off.
