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
  `reason`, and the agency column where the table has one).
- **The two person-or-master knobs are retired.** A stored document carrying
  `workflows.designApprover` or `contracts.approver` still reads; a write naming either is refused
  `APPROVER_POLICY_RETIRED`, and nothing reads them (amnesty ISS-159 in
  `packages/core/src/project-config/schema.ts`, until no stored document carries them).

## Consequences

- A project member who signed off requirements, decided suggestions and mockups or triaged feedback
  as a person no longer does by default: those acts now take `admin`. Making members approvers is
  one line in `ROLE_PERMISSIONS`; making one member an approver is a grant
  (`PATCH /api/projects/:id/members/:userId { grants }`), not a new rule.
- A grant gives approval without configuration or member powers, which a role change to `admin`
  would also hand over.
