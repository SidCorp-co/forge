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
  vars?: (groups: Record<string, string>, language: string) => Vars;
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
  { re: new RegExp("^write the release note(?<on>.*)$"), key: "standing.act.writeReleaseNote", vars: (g) => ({ on: g.on ?? "" }) },
  { re: new RegExp("^mark the merge(?<on>.*)$"), key: "standing.act.markMerge", vars: (g) => ({ on: g.on ?? "" }) },
  { re: new RegExp("^declare a source probe on production$"), key: "standing.act.declareProbe" },
  { re: new RegExp("^pair a runner$"), key: "standing.act.pairRunner" },
  { re: new RegExp("^bring a runner online$"), key: "standing.act.runnerOnline" },
  { re: new RegExp("^a release is running$"), key: "standing.act.releaseRunning" },
  { re: new RegExp("^judge the criteria still owed$"), key: "standing.act.judgeCriteria" },
  { re: new RegExp("^give production a way to be read$"), key: "standing.act.productionReadable" },
  { re: new RegExp("^a check could not run$"), key: "standing.act.checkCouldNotRun" },
  { re: new RegExp("^label a runner for releases$"), key: "standing.act.labelRunner" },
  { re: new RegExp("^verdicts not re-read$"), key: "standing.act.verdictsNotReread" },
];

const EFFECT: Rule[] = [
  {
    re: new RegExp("^Records that this requirement follows (?<names>.+) from now on\\. Its wording and criteria do not change, and its delivery is not offered for acceptance until then\\.$"),
    key: "standing.effect.follow",
    vars: (g) => ({ names: g.names ?? "" }),
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

function apply(rules: Rule[], text: string, language: string): string | null {
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (!m) continue;
    return productCopy(language)(rule.key, rule.vars?.(m.groups ?? {}, language));
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
export const STANDING_RULES = { who: WHO, act: ACT, effect: EFFECT, feedbackNote: FEEDBACK_NOTE } as const;
