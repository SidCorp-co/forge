import { baseOf, productCopy, type ProductCopyKey } from "./product-copy";

// The patterns are built with `new RegExp` because the web's compile target has no literal for named groups.
// Core words whom a row waits on and what they owe in English (`@forge/contracts/standing`:
// `WaitingOn.who`, `.act`, `.effect`). The words are core's, built from facts; this module is the
// one place the web maps them to another language, by the shape of the English sentence, and
// leaves anything it does not recognise exactly as core wrote it. A name (a person, a key, a
// version) is never touched. `standing-copy.test.ts` holds one real sentence per pattern.

type Vars = Record<string, string | number>;
interface Rule {
  re: RegExp;
  key: ProductCopyKey;
  /** Null where a part the pattern captured is itself one no pattern names: the sentence then reads as core wrote it. */
  vars?: (groups: Record<string, string>, language: string) => Vars | null;
}

const date = (iso: string, language: string): string => {
  const [y, m, d] = iso.split("-");
  return baseOf(language) === "vi" && y && m && d ? `${d}/${m}/${y}` : iso;
};
const dueWhen = (g: Record<string, string>, language: string): string =>
  productCopy(language)(g.overdue === "overdue since" ? "standing.overdueSince" : "standing.due", { date: date(g.date ?? "", language) });

const WHO: Rule[] = [
  { re: new RegExp("^You$"), key: "standing.who.you" },
  { re: new RegExp("^Master$"), key: "standing.who.master" },
  { re: new RegExp("^BA or owner$"), key: "standing.who.baOrOwner" },
  { re: new RegExp("^Issues$"), key: "standing.who.issues" },
  { re: new RegExp("^A project admin$"), key: "standing.who.projectAdmin" },
  { re: new RegExp("^A project writer$"), key: "standing.who.projectWriter" },
  { re: new RegExp("^A release approver$"), key: "standing.who.releaseApprover" },
  { re: new RegExp("^The project's master$"), key: "standing.who.projectMaster" },
  { re: new RegExp("^Release run$"), key: "standing.who.releaseRun" },
  { re: new RegExp("^Release gate$"), key: "standing.who.releaseGate" },
  { re: new RegExp("^No approver$"), key: "standing.who.noApprover" },
  { re: new RegExp("^Its author$"), key: "standing.who.itsAuthor" },
  { re: new RegExp("^The revision proposal$"), key: "standing.who.revisionProposal" },
  { re: new RegExp("^The linked issue$"), key: "standing.who.linkedIssue" },
  { re: new RegExp("^The linked work$"), key: "standing.who.linkedWork" },
  { re: new RegExp("^The new requirement$"), key: "standing.who.newRequirement" },
  { re: new RegExp("^The current revision$"), key: "standing.who.currentRevision" },
  { re: new RegExp("^(?:Nothing|Nobody)$"), key: "standing.who.nobody" },
  { re: new RegExp("^A holder of (?<perm>.+)$"), key: "standing.who.holderOf", vars: (g) => ({ perm: g.perm ?? "" }) },
  { re: new RegExp("^Its root (?<root>.+)$"), key: "standing.who.itsRoot", vars: (g) => ({ root: g.root ?? "" }) },
];

const ACT: Rule[] = [
  { re: new RegExp("^triage (?<n>\\d+) feedback items$"), key: "standing.act.triageMany", vars: (g) => ({ n: g.n ?? "" }) },
  { re: new RegExp("^triage it again$"), key: "standing.act.triageAgain" },
  { re: new RegExp("^triage it$"), key: "standing.act.triageIt" },
  { re: new RegExp("^triage (?<what>.+)$"), key: "standing.act.triage", vars: (g) => ({ what: g.what ?? "" }) },
  { re: new RegExp("^accept r(?<r>\\d+)$"), key: "standing.act.acceptR", vars: (g) => ({ r: g.r ?? "" }) },
  { re: new RegExp("^accept the revision(?: of (?<req>.+))?$"), key: "standing.act.acceptRevisionOf", vars: (g) => ({ req: g.req ?? "" }) },
  { re: new RegExp("^accept revision (?<r>\\d+)(?: of (?<req>.+))?$"), key: "standing.act.acceptRevisionN", vars: (g) => ({ r: g.r ?? "", req: g.req ?? "" }) },
  { re: new RegExp("^propose the revision(?: of (?<req>.+))?$"), key: "standing.act.proposeRevisionOf", vars: (g) => ({ req: g.req ?? "" }) },
  { re: new RegExp("^propose revision (?<r>\\d+)(?: of (?<req>.+))?$"), key: "standing.act.proposeRevisionN", vars: (g) => ({ r: g.r ?? "", req: g.req ?? "" }) },
  { re: new RegExp("^revise returned r(?<r>\\d+), then propose or drop it$"), key: "standing.act.reviseThenProposeOrDrop", vars: (g) => ({ r: g.r ?? "" }) },
  { re: new RegExp("^revise returned r(?<r>\\d+)$"), key: "standing.act.reviseReturned", vars: (g) => ({ r: g.r ?? "" }) },
  { re: new RegExp("^propose or drop r(?<r>\\d+)$"), key: "standing.act.proposeOrDrop", vars: (g) => ({ r: g.r ?? "" }) },
  { re: new RegExp("^propose r(?<r>\\d+)$"), key: "standing.act.proposeR", vars: (g) => ({ r: g.r ?? "" }) },
  { re: new RegExp("^finish draft$"), key: "standing.act.finishDraft" },
  { re: new RegExp("^agree it$"), key: "standing.act.agreeIt" },
  { re: new RegExp("^agree r(?<r>\\d+)$"), key: "standing.act.agreeR", vars: (g) => ({ r: g.r ?? "" }) },
  { re: new RegExp("^propose design (?<what>.+)$"), key: "standing.act.proposeDesign", vars: (g) => ({ what: g.what ?? "" }) },
  { re: new RegExp("^approve design (?<what>.+)$"), key: "standing.act.approveDesign", vars: (g) => ({ what: g.what ?? "" }) },
  { re: new RegExp("^Update to the approved design: (?<design>.+) \\(revision (?<r>\\d+)\\)$"), key: "standing.act.updateToDesign", vars: (g) => ({ design: g.design ?? "", r: g.r ?? "" }) },
  { re: new RegExp("^Update to the current version of (?<contract>.+) \\((?<v>[^()]+)\\)$"), key: "standing.act.updateToContract", vars: (g) => ({ contract: g.contract ?? "", v: g.v ?? "" }) },
  {
    re: new RegExp("^check (?<codes>.+) against the traceability matrix, (?<overdue>overdue since|due) (?<date>\\d{4}-\\d{2}-\\d{2})$"),
    key: "standing.act.check",
    vars: (g, l) => ({ codes: g.codes ?? "", when: dueWhen(g, l) }),
  },
  { re: new RegExp("^prove (?<codes>.+)$"), key: "standing.act.prove", vars: (g) => ({ codes: g.codes ?? "" }) },
  { re: new RegExp("^re-plan (?<keys>.+)$"), key: "standing.act.replan", vars: (g) => ({ keys: g.keys ?? "" }) },
  {
    re: new RegExp("^break down, (?<overdue>overdue since|due) (?<date>\\d{4}-\\d{2}-\\d{2})$"),
    key: "standing.act.breakDownBy",
    vars: (g, l) => ({ when: dueWhen(g, l) }),
  },
  { re: new RegExp("^break down$"), key: "standing.act.breakDown" },
  { re: new RegExp("^Review how this requirement is split into work$"), key: "standing.act.reviewBreakdown" },
  { re: new RegExp("^promote 1 draft issue$"), key: "standing.act.promoteDraft" },
  { re: new RegExp("^promote (?<n>\\d+) draft issues$"), key: "standing.act.promoteDrafts", vars: (g) => ({ n: g.n ?? "" }) },
  { re: new RegExp("^Running (?<a>\\d+) of (?<b>\\d+)$"), key: "standing.act.running", vars: (g) => ({ a: g.a ?? "", b: g.b ?? "" }) },
  { re: new RegExp("^Done (?<a>\\d+) of (?<b>\\d+)$"), key: "standing.act.done", vars: (g) => ({ a: g.a ?? "", b: g.b ?? "" }) },
  { re: new RegExp("^Confirm the answer$"), key: "standing.act.confirmAnswer" },
  { re: new RegExp("^verify the fix shipped in (?<v>.+)$"), key: "standing.act.verifyFixIn", vars: (g) => ({ v: g.v ?? "" }) },
  { re: new RegExp("^verify the fix$"), key: "standing.act.verifyFix" },
  { re: new RegExp("^release it by hand and close it$"), key: "standing.act.releaseItByHand" },
  { re: new RegExp("^release (?<what>.+) by hand and close it$"), key: "standing.act.releaseByHand", vars: (g) => ({ what: g.what ?? "" }) },
  { re: new RegExp("^Approve release (?<v>.+)$"), key: "standing.act.approveReleaseV", vars: (g) => ({ v: g.v ?? "" }) },
  { re: new RegExp("^Approve the release that carries it$"), key: "standing.act.approveCarrierRelease" },
  { re: new RegExp("^cut the release that carries (?<what>.+)$"), key: "standing.act.cutCarrierRelease", vars: (g) => ({ what: g.what ?? "" }) },
  { re: new RegExp("^cut (?<v>\\S+), then approve it$"), key: "standing.act.cutThenApprove", vars: (g) => ({ v: g.v ?? "" }) },
  { re: new RegExp("^cut (?<v>\\S+)(?: and (?<more>\\d+) more)?$"), key: "standing.act.cut", vars: (g, l) => ({ v: g.v ?? "", more: g.more ? productCopy(l)("standing.more", { n: g.more }) : "" }) },
  { re: new RegExp("^ship$"), key: "standing.act.ship" },
  { re: new RegExp("^be agreed and delivered$"), key: "standing.act.beAgreedDelivered" },
  { re: new RegExp("^be resolved$"), key: "standing.act.beResolved" },
  { re: new RegExp("^be accepted$"), key: "standing.act.beAccepted" },
  { re: new RegExp("^be delivered$"), key: "standing.act.beDelivered" },
  { re: new RegExp("^ask for approval$"), key: "standing.act.askApproval" },
  { re: new RegExp("^approve or return (?<v>.+)$"), key: "standing.act.approveOrReturn", vars: (g) => ({ v: g.v ?? "" }) },
  { re: new RegExp("^no other admin can decide$"), key: "standing.act.noOtherAdmin" },
  { re: new RegExp("^approve$"), key: "standing.act.approve" },
  { re: new RegExp("^answer the return$"), key: "standing.act.answerReturn" },
  { re: new RegExp("^deploying$"), key: "standing.act.deploying" },
  { re: new RegExp("^verifying$"), key: "standing.act.verifying" },
  { re: new RegExp("^starting$"), key: "standing.act.starting" },
  { re: new RegExp("^declare a production environment$"), key: "standing.act.declareProduction" },
  { re: new RegExp("^declare where releases land$"), key: "standing.act.declareTarget" },
  { re: new RegExp("^cut the issues that are waiting$"), key: "standing.act.cutWaiting" },
  { re: new RegExp("^bring an issue to the release gate$"), key: "standing.act.bringIssueToGate" },
  { re: new RegExp("^split this release into smaller releases$"), key: "standing.act.splitRelease" },
  { re: new RegExp("^write the release note(?: on (?<subject>.+))?$"), key: "standing.act.writeReleaseNote", vars: (g, l) => onSubject(g, l) },
  { re: new RegExp("^mark the merge(?: on (?<subject>.+))?$"), key: "standing.act.markMerge", vars: (g, l) => onSubject(g, l) },
  { re: new RegExp("^declare a source probe on production$"), key: "standing.act.declareProbe" },
  { re: new RegExp("^pair a runner$"), key: "standing.act.pairRunner" },
  { re: new RegExp("^bring a runner online$"), key: "standing.act.runnerOnline" },
  { re: new RegExp("^a release is running$"), key: "standing.act.releaseRunning" },
  { re: new RegExp("^judge the criteria still owed$"), key: "standing.act.judgeCriteria" },
  { re: new RegExp("^give production a way to be read$"), key: "standing.act.productionReadable" },
  { re: new RegExp("^a check could not run$"), key: "standing.act.checkCouldNotRun" },
  { re: new RegExp("^label a runner for releases$"), key: "standing.act.labelRunner" },
  { re: new RegExp("^verdicts not re-read$"), key: "standing.act.verdictsNotReread" },
  {
    // the act a person's turn names where no person holds write (FB-104): its own act, then where it is granted
    re: new RegExp("^(?<act>.+): no person on this project can write until a project admin grants write under Settings → Members$"),
    key: "standing.act.noWriter",
    vars: (g, l) => {
      const act = apply(ACT, g.act ?? "", l);
      return act === null ? null : { act };
    },
  },
];

const EFFECT: Rule[] = [
  {
    re: new RegExp("^Records that this requirement follows (?<names>.+) from now on\\. Its wording and criteria do not change, and its delivery is not offered for acceptance until then\\.$"),
    key: "standing.effect.follow",
    vars: (g) => ({ names: g.names ?? "" }),
  },
  {
    re: new RegExp("^Cuts the oldest (?<limit>\\d+) merged issues as this release and leaves (?:the other (?<rest>\\d+)|the others) at the release gate for the next one\\.$"),
    key: "releases.effect.split",
    vars: (g, l) => ({
      limit: g.limit ?? "",
      left: g.rest ? productCopy(l)("releases.effect.splitRest", { n: g.rest }) : productCopy(l)("releases.effect.splitOthers"),
    }),
  },
];

/** Core's sentences on a feedback item that are not whose turn it is: why a shipped fix told nobody, the reason an automatic verify records, why triage ran with no dedup. */
const FEEDBACK_NOTE: Rule[] = [
  { re: new RegExp("^The reporter has turned this notice off, so it reached nobody: tell them yourself\\.$"), key: "feedback.notice.turnedOff" },
  { re: new RegExp("^The reporter is an agent, which has no bell: tell it where it listens\\.$"), key: "feedback.notice.agent" },
  { re: new RegExp("^It shipped before Forge told reporters when a release shipped\\.$"), key: "feedback.notice.before" },
  { re: new RegExp("^(?<release>\\S+) shipped it and sent the reporter no notice\\.$"), key: "feedback.notice.silent", vars: (g) => ({ release: g.release ?? "" }) },
  { re: new RegExp("^No release carries it, so none told the reporter: tell them yourself\\.$"), key: "feedback.notice.noRelease" },
  { re: new RegExp("^Verified automatically after (?<n>\\d+) days with no reply$"), key: "feedback.notice.autoVerified", vars: (g) => ({ n: g.n ?? "" }) },
  { re: new RegExp("^triage without dedup: the item's vector is (?<status>.+)$"), key: "feedback.notice.noDedup", vars: (g) => ({ status: g.status ?? "" }) },
];

// The issues a release gate's sentence names (core `release-batch/release-gates.ts:subjectOf`): a
// count ("3 issues"), keys ("ISS-1, ISS-2"), keys and the rest ("ISS-1, … and 2 more"), or "Some
// issues"; keys are names and are carried over as written.
const SUBJECT: Rule[] = [
  { re: new RegExp("^(?<n>\\d+) (?<issues>issues?)$"), key: "standing.gate.subject.count", vars: (g) => ({ n: g.n ?? "", issues: g.issues ?? "" }) },
  { re: new RegExp("^(?<keys>[A-Z]+-\\d+(?:, [A-Z]+-\\d+)*) and (?<n>\\d+) more$"), key: "standing.gate.subject.more", vars: (g) => ({ keys: g.keys ?? "", n: g.n ?? "" }) },
  { re: new RegExp("^(?<keys>[A-Z]+-\\d+(?:, [A-Z]+-\\d+)*)$"), key: "standing.gate.subject.keys", vars: (g) => ({ keys: g.keys ?? "" }) },
  { re: new RegExp("^Some issues$"), key: "standing.gate.subject.some" },
  { re: new RegExp("^Issues at the gate$"), key: "standing.gate.subject.atGate" },
];
const subject = (text: string | undefined, language: string): string | null => apply(SUBJECT, text ?? "", language);
const onSubject = (g: Record<string, string>, language: string): Vars | null => {
  if (g.subject === undefined) return { on: "" };
  const named = subject(g.subject, language);
  return named === null ? null : { on: productCopy(language)("standing.gate.on", { subject: named }) };
};

// "ISS-4 owes criteria 1, 2; ISS-5 owes criterion 3": what each held issue still owes
const OWES: Rule[] = [
  { re: new RegExp("^(?<key>[A-Z]+-\\d+) owes (?<word>criterion|criteria) (?<list>[\\d, ]+)$"), key: "standing.gate.owes", vars: (g) => ({ key: g.key ?? "", word: g.word ?? "", list: g.list ?? "" }) },
];
const owes = (text: string | undefined, language: string): string | null => {
  const named = subject(text, language);
  if (named !== null) return named;
  const parts = (text ?? "").split("; ").map((p) => apply(OWES, p, language));
  return parts.every((p) => p !== null) ? parts.join("; ") : null;
};
const withSubject = (g: Record<string, string>, l: string): Vars | null => {
  const named = subject(g.subject, l);
  return named === null ? null : { ...g, subject: named };
};
const withOwes = (g: Record<string, string>, l: string): Vars | null => {
  const named = owes(g.owes, l);
  return named === null ? null : { ...g, owes: named };
};
const raw = (g: Record<string, string>): Vars => ({ ...g });

/** A release gate's title (core `release-batch/release-gates.ts:READINGS`), one per reason. */
const GATE_TITLE: Rule[] = (
  [
    ["No release step", "noGate"],
    ["Nowhere to land", "nowhere"],
    ["Issues already claimed", "claimed"],
    ["Nothing at the gate", "empty"],
    ["Too many issues", "oversize"],
    ["Release note missing", "noteMissing"],
    ["Work not marked merged", "unmerged"],
    ["Production cannot be proved", "unprovable"],
    ["No runner paired", "noRunner"],
    ["No runner can take it", "noRunnerOnline"],
    ["A release is running", "running"],
    ["Criteria still owed", "unearned"],
    ["Production cannot be read", "unreadable"],
    ["A check could not run", "unevaluated"],
    ["Preferred runner missing", "preference"],
    ["Some issues held back", "heldBack"],
    ["Verdicts not re-read", "uncorroborated"],
  ] as const
).map(([title, key]) => ({ re: new RegExp(`^${title}$`), key: `standing.gate.title.${key}` as ProductCopyKey }));

/** A release gate's sentence, read with the issues, counts and limits it names carried over. */
const GATE_SENTENCE: Rule[] = [
  { re: new RegExp("^This project ships when an issue closes, so there is no release to cut\\.$"), key: "standing.gate.noGate" },
  { re: new RegExp("^Nothing says where this project’s releases land\\. An admin completes its production environment in the project document\\.$"), key: "standing.gate.nowhere" },
  {
    re: new RegExp("^(?<subject>.+) (?<verb>is|are) not at the release gate, or another release already holds (?<obj>it|them)\\. Pick the issues that are waiting\\.$"),
    key: "standing.gate.claimed",
    vars: withSubject,
  },
  {
    re: new RegExp("^No issue is waiting at the release gate\\. (?<n>\\d+) (?<issues>issues?) (?<verb>stands|stand) one step short of it, at (?<their>its|their) test step\\.$"),
    key: "standing.gate.nearGate",
    vars: raw,
  },
  { re: new RegExp("^No issue is waiting at the release gate, so there is nothing to cut\\.$"), key: "standing.gate.empty" },
  {
    re: new RegExp("^(?<n>\\d+) (?<issues>issues?) (?<verb>is|are) waiting, and one release carries at most (?<limit>\\d+)\\. Split them into smaller releases, oldest merge first\\.$"),
    key: "standing.gate.oversize",
    vars: raw,
  },
  {
    re: new RegExp("^More issues are waiting, and one release carries at most (?<limit>\\d+)\\. Split them into smaller releases, oldest merge first\\.$"),
    key: "standing.gate.oversizeUncounted",
    vars: raw,
  },
  { re: new RegExp("^(?<subject>.+) (?<verb>has|have) no release note, so the release would claim a ship nobody described\\.$"), key: "standing.gate.noteMissing", vars: withSubject },
  {
    re: new RegExp("^(?<subject>.+) (?<verb>has|have) no merge Forge saw land, so nothing says (?<their>its|their) work is in this release\\.$"),
    key: "standing.gate.unmerged",
    vars: withSubject,
  },
  {
    re: new RegExp("^Production declares no probe that identifies the source commit, so a release there could never be proved\\. An admin adds one to the production environment\\.$"),
    key: "standing.gate.unprovable",
  },
  { re: new RegExp("^No runner is paired to this project, so no machine can run a release\\.$"), key: "standing.gate.noRunner" },
  { re: new RegExp("^Runners are paired, and none of them can take a release right now\\.$"), key: "standing.gate.noRunnerOnline" },
  { re: new RegExp("^Another release is already running for this project\\. Let it finish before cutting another\\.$"), key: "standing.gate.running" },
  {
    re: new RegExp("^(?<owes>.+)\\. The unattended sweep carries an issue only when every criterion holds a passing verdict\\.$"),
    key: "standing.gate.unearned",
    vars: withOwes,
  },
  {
    re: new RegExp("^Nothing can read what production serves, so no verdict can earn an issue its place in an unattended release\\.$"),
    key: "standing.gate.unreadable",
  },
  { re: new RegExp("^The (?<check>\\S+) check could not run, so this list may be missing a reason\\.$"), key: "standing.gate.unevaluated", vars: raw },
  { re: new RegExp("^No runner carries the release label this project asks for, so the release goes to the pool it has\\.$"), key: "standing.gate.preference" },
  {
    re: new RegExp("^(?<owes>.+)\\. (?<they>It is|They are) held back until (?<their>its|their) criteria are earned; the others ship\\.$"),
    key: "standing.gate.heldBack",
    vars: withOwes,
  },
  {
    re: new RegExp("^(?<subject>.+) (?<verb>carries|carry) a verdict earned where nothing could re-read production\\. It counts, and it is weaker evidence\\.$"),
    key: "standing.gate.uncorroborated",
    vars: withSubject,
  },
];

/** What a release's data change risks (core `release-batch/landing-surfaces.ts:RISK_SENTENCE`); the ref is a name. */
const RISK: Rule[] = [
  { re: new RegExp("^(?<ref>.+) is removed: data it held does not come back with a rollback$"), key: "standing.risk.dataRemoved", vars: raw },
  { re: new RegExp("^(?<ref>.+) changes shape: rows written before it are read by the new shape$"), key: "standing.risk.dataChanged", vars: raw },
  { re: new RegExp("^(?<ref>.+) is removed: a caller still using it is refused after this ships$"), key: "standing.risk.apiRemoved", vars: raw },
];

// A requirement's history (core `requirements/history-read.ts`): who a record came from when no
// person is named, and the act each record leads with; the reason, summary or note after the colon
// is what a person wrote and is carried over untouched.
const HISTORY_WHO: Rule[] = [
  { re: new RegExp("^Someone$"), key: "requirements.history.who.someone" },
  { re: new RegExp("^A signer$"), key: "requirements.history.who.signer" },
  { re: new RegExp("^An agent$"), key: "requirements.history.who.agent" },
  { re: new RegExp("^BA assistant$"), key: "requirements.history.who.assistant" },
];

const SUGGESTED: Record<string, ProductCopyKey> = {
  "a requirement draft": "requirements.history.what.requirement_draft",
  "a revision": "requirements.history.what.revision_diff",
  "a readiness check": "requirements.history.what.readiness",
  "a breakdown": "requirements.history.what.breakdown",
  "a triage": "requirements.history.what.triage",
  "a duplicate": "requirements.history.what.duplicate",
  "a change": "requirements.history.what.change",
};
const WHAT = `(?<what>${Object.keys(SUGGESTED).join("|")})`;
const REST = "(?<rest>[\\s\\S]+)";
const r = (g: Record<string, string>) => ({ r: g.r ?? "" });
const rRest = (g: Record<string, string>) => ({ r: g.r ?? "", rest: g.rest ?? "" });
const rest = (g: Record<string, string>) => ({ rest: g.rest ?? "" });
const what = (g: Record<string, string>, l: string) => ({ what: productCopy(l)(SUGGESTED[g.what ?? ""] ?? "requirements.history.what.change"), rest: g.rest ?? "" });

const HISTORY_TEXT: Rule[] = [
  { re: new RegExp(`^Wrote r(?<r>\\d+) \\(an accepted suggestion\\): ${REST}$`), key: "requirements.history.text.wroteSuggested", vars: rRest },
  { re: new RegExp(`^Wrote r(?<r>\\d+): ${REST}$`), key: "requirements.history.text.wrote", vars: rRest },
  { re: new RegExp("^Proposed r(?<r>\\d+)$"), key: "requirements.history.text.proposed", vars: r },
  { re: new RegExp("^Accepted the delivery$"), key: "requirements.history.text.deliveryAccepted" },
  { re: new RegExp(`^Accepted the delivery: ${REST}$`), key: "requirements.history.text.deliveryAcceptedWhy", vars: rest },
  { re: new RegExp("^Accepted r(?<r>\\d+)$"), key: "requirements.history.text.accepted", vars: r },
  { re: new RegExp(`^Accepted r(?<r>\\d+): ${REST}$`), key: "requirements.history.text.acceptedWhy", vars: rRest },
  { re: new RegExp(`^Returned r(?<r>\\d+): ${REST}$`), key: "requirements.history.text.returned", vars: rRest },
  { re: new RegExp(`^Deferred out of the current release \\(for (?<phase>[^)]+)\\): ${REST}$`), key: "requirements.history.text.deferredFor", vars: (g) => ({ phase: g.phase ?? "", rest: g.rest ?? "" }) },
  { re: new RegExp(`^Deferred out of the current release: ${REST}$`), key: "requirements.history.text.deferred", vars: rest },
  { re: new RegExp("^Undeferred$"), key: "requirements.history.text.undeferred" },
  { re: new RegExp(`^Undeferred: ${REST}$`), key: "requirements.history.text.undeferredWhy", vars: rest },
  { re: new RegExp("^Agreed r(?<r>\\d+)$"), key: "requirements.history.text.agreed", vars: r },
  { re: new RegExp(`^Agreed r(?<r>\\d+): ${REST}$`), key: "requirements.history.text.agreedWhy", vars: rRest },
  { re: new RegExp("^Re-pinned r(?<r>\\d+) onto the approved designs$"), key: "requirements.history.text.repinned", vars: r },
  { re: new RegExp(`^Re-pinned r(?<r>\\d+) onto the approved designs: ${REST}$`), key: "requirements.history.text.repinnedWhy", vars: rRest },
  { re: new RegExp(`^Dropped: ${REST}$`), key: "requirements.history.text.dropped", vars: rest },
  { re: new RegExp(`^Suggested ${WHAT}$`), key: "requirements.history.text.suggested", vars: what },
  { re: new RegExp(`^Accepted ${WHAT}$`), key: "requirements.history.text.acceptedSuggestion", vars: what },
  { re: new RegExp(`^Accepted ${WHAT}: ${REST}$`), key: "requirements.history.text.acceptedSuggestionWhy", vars: what },
  { re: new RegExp(`^Rejected ${WHAT}$`), key: "requirements.history.text.rejectedSuggestion", vars: what },
  { re: new RegExp(`^Rejected ${WHAT}: ${REST}$`), key: "requirements.history.text.rejectedSuggestionWhy", vars: what },
];

function apply(rules: Rule[], text: string, language: string): string | null {
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const vars = rule.vars ? rule.vars(m.groups ?? {}, language) : undefined;
    if (vars === null) continue;
    return productCopy(language)(rule.key, vars);
  }
  return null;
}

/** The English `text` in `language`; the text itself where the language is English or no pattern names it. */
function localize(rules: Rule[], text: string, language: string): string {
  if (baseOf(language) === "en" || text === "") return text;
  // several acts joined by core ("Update to ...; Update to ...") read one by one
  if (text.includes("; ")) {
    const parts = text.split("; ").map((p) => apply(rules, p, language));
    if (parts.every((p) => p !== null)) return parts.join("; ");
  }
  return apply(rules, text, language) ?? text;
}

export const standingWho = (who: string, language: string) => localize(WHO, who, language);
export const standingAct = (act: string, language: string) => localize(ACT, act, language);
export const standingEffect = (effect: string, language: string) => localize(EFFECT, effect, language);
/** A feedback item's own core sentence (a ship notice's reason, an automatic verify's) in `language`; one no pattern names reads as core wrote it. */
export const feedbackNote = (note: string, language: string) => localize(FEEDBACK_NOTE, note, language);
/** A release gate's title and sentence, and a data risk's sentence, in `language`; one no pattern names reads as core wrote it. */
export const gateTitle = (title: string, language: string) => localize(GATE_TITLE, title, language);
export const gateSentence = (sentence: string, language: string) => localize(GATE_SENTENCE, sentence, language);
export const riskSentence = (sentence: string, language: string) => localize(RISK, sentence, language);
/** A requirement history record's actor and its text, read the same way; the person's words after the act stay as written. */
export const historyWho = (who: string, language: string) => (baseOf(language) === "en" ? who : (apply(HISTORY_WHO, who, language) ?? standingWho(who, language)));
export const historyText = (text: string, language: string) => (baseOf(language) === "en" || text === "" ? text : (apply(HISTORY_TEXT, text, language) ?? text));

/** A waiting-on with its `who`, `act` and `effect` in `language`; its `rule` and `kind` as core sent them. */
export function localizeWaiting<W extends { who: string; act: string; effect?: string | undefined }>(w: W, language: string): W {
  if (baseOf(language) === "en") return w;
  const effect = w.effect === undefined ? {} : { effect: standingEffect(w.effect, language) };
  return { ...w, who: standingWho(w.who, language), act: standingAct(w.act, language), ...effect };
}

/** The sentence `text` reads as in `language` by a pattern, or null where none names it; English runs through its pattern too, which the round-trip test holds to core's sentence. */
export function standingRead(kind: keyof typeof STANDING_RULES, text: string, language: string): string | null {
  return apply(STANDING_RULES[kind] as Rule[], text, language);
}

/** Every pattern of `who`, `act` and `effect` the module reads, for the test that holds a sentence to each. */
export const STANDING_RULES = {
  who: WHO,
  act: ACT,
  effect: EFFECT,
  historyWho: HISTORY_WHO,
  history: HISTORY_TEXT,
  feedbackNote: FEEDBACK_NOTE,
  gateTitle: GATE_TITLE,
  gateSentence: GATE_SENTENCE,
  risk: RISK,
} as const;
