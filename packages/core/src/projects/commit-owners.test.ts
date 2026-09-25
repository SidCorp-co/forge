import { describe, expect, it } from 'vitest';
import type { WaitingCommit } from '../integrations/github/live-divergence.js';
import { commitOwners, declaredIssueSeqs } from './commit-owners.js';
import { issueRefPattern } from './live-reach.js';

const pattern = issueRefPattern(['SD']);
const declared = (subject: string, base = 'staging') => declaredIssueSeqs(subject, pattern, base);

describe('declaredIssueSeqs', () => {
  it('reads every key in the parenthesised group ending the subject', () => {
    expect(declared('fix(desk): the queue shows the owner (SD-442)')).toEqual([442]);
    expect(declared('Merge branch ISS-419-seed into staging (ISS-419, ISS-440)')).toEqual([
      419, 440,
    ]);
    expect(declared('fix(ci): widget deferral (ISS-483 review F1)')).toEqual([483]);
    expect(declared('fix(frontend): more errors cleared (ISS-475, in progress)')).toEqual([475]);
    expect(declared('fix: a squash of the change (SD-12) (#88)')).toEqual([12]);
  });

  it('never reads a key cited in the middle of the description', () => {
    expect(
      declared(
        'feat(logger): say at boot when the retention window is below the seven days ISS-401 asks for (ISS-435)',
      ),
    ).toEqual([435]);
    expect(
      declared(
        'fix(qc-agent): the seeding route can ask for the fourth outcome kind, so the card ISS-424 added has a witness (ISS-440)',
      ),
    ).toEqual([440]);
    expect(
      declared('docs(changelog): the five issues released with ISS-489 but never written up'),
    ).toEqual([]);
    expect(declared('fix(qc): address codex consult findings on ISS-486 (F1/F2/F3)')).toEqual([]);
  });

  it('never reads the body', () => {
    expect(
      declared('fix(desk): the owner (SD-442)\n\nkeeps the SD-170 decision; Refs: SD-9'),
    ).toEqual([442]);
    expect(declared('fix(desk): the owner\n\n(SD-170)')).toEqual([]);
  });

  it('lets the trailer outrank the merged branch name', () => {
    expect(declared('Merge branch ISS-439-qc-agent-outcomes into staging (ISS-423)')).toEqual([
      423,
    ]);
  });

  it("reads a merge subject's branch when it has no trailer", () => {
    expect(declared('Merge pull request #615 from SidCorp-co/ISS-1215-release-path')).toEqual([
      1215,
    ]);
    expect(
      declared("Merge branch 'SD-170' into 'staging'\n\nSee merge request sid/desk!42"),
    ).toEqual([170]);
    expect(declared('Merge branch fix/SD-12-owner into staging')).toEqual([12]);
    expect(declared('Merge branch ISS-481-ISS-482-reopen into staging')).toEqual([481]);
    expect(declared('Merge pull request #88 from sid/feature-x')).toEqual([]);
  });

  it('reads the keys opening the description after a Merge or type(scope) lead', () => {
    expect(declared('fix(contracts): ISS-506 the detail strip wraps')).toEqual([506]);
    expect(declared('Merge ISS-507: a result switch asks before it clears')).toEqual([507]);
    expect(declared('Merge ISS-502 + ISS-505: the overlay covers the header')).toEqual([502, 505]);
    expect(declared('Merge sidpeak-batch: ISS-444, ISS-459 and ISS-436')).toEqual([444, 459, 436]);
    expect(declared('SD-9 fix the owner')).toEqual([9]);
    expect(
      declared("fix(config): ISS-438's new guard counted names before ISS-430 added one"),
    ).toEqual([438]);
  });

  it('declares nothing for a merge of the base branch into another branch', () => {
    expect(declared('Merge origin/staging into the ISS-311 landing (ISS-105, ISS-267)')).toEqual(
      [],
    );
    expect(
      declared("Merge remote-tracking branch 'origin/staging' into ISS-439-qc-agent-outcomes"),
    ).toEqual([]);
    expect(declared("Merge branch 'staging' into ISS-220")).toEqual([]);
    expect(declared('Merge origin/release/rc into SD-4 (SD-4)', 'release/rc')).toEqual([]);
    expect(declared('Merge origin/main into SD-4 (SD-4)')).toEqual([4]);
  });

  it('keeps the whole-reference boundary of the key pattern', () => {
    expect(declared('fix: owner (SD-4420)')).toEqual([4420]);
    expect(declared('fix: owner (SD-442X)')).toEqual([]);
    expect(declared('fix(x): XSD-4 owner')).toEqual([]);
  });
});

const c = (sha: string, message: string, ...parents: string[]): WaitingCommit => ({
  sha,
  message,
  parents,
});
const owners = (commits: WaitingCommit[]) =>
  Object.fromEntries(
    [...commitOwners(commits, pattern, 'staging')].map(([sha, m]) => [sha, Object.fromEntries(m)]),
  );

describe('commitOwners', () => {
  it('gives a commit declaring nothing the issues of the merge that brought it in', () => {
    const got = owners([
      c('m1', 'Merge branch ISS-478-ISS-479-chat into staging (ISS-478, ISS-479)', 'live', 'b2'),
      c('b2', 'fix(chat): stop reading the wall clock in render', 'b1'),
      c('b1', 'fix(chat): remove a dead AudioContext leak', 'live'),
    ]);
    expect(got.b2).toEqual({ 478: 'merged_in', 479: 'merged_in' });
    expect(got.b1).toEqual({ 478: 'merged_in', 479: 'merged_in' });
    expect(got.m1).toEqual({ 478: 'declares_issue', 479: 'declares_issue' });
  });

  it("keeps a carried commit that cites its own merge's issue mid-description as that issue's work", () => {
    const got = owners([
      c('m1', 'Merge branch SD-450-seed into staging (SD-458, SD-450)', 'live', 'b1'),
      c('b1', 'docs(runbook): the compose table SD-450 added named one variable', 'live'),
    ]);
    expect(got.b1).toEqual({ 458: 'merged_in', 450: 'merged_in' });
  });

  it('never gives a commit that declares its own key the issues only its merge declares', () => {
    const got = owners([
      c('m1', 'Merge branch ISS-429-log-bool into staging (ISS-429, ISS-432)', 'live', 'b2'),
      c('b2', 'docs(runbook): convert the UTC hour (ISS-432)', 'b1'),
      c('b1', 'docs(runbook): LOG_FILE_ENABLED is read lowercase (ISS-429)', 'live'),
    ]);
    expect(got.b2).toEqual({ 432: 'declares_issue' });
    expect(got.b1).toEqual({ 429: 'declares_issue' });
  });

  it('leaves what the first parent already holds to the merges that brought it in', () => {
    const got = owners([
      c('m2', 'Merge branch SD-2-b into staging (SD-2)', 'm1', 'b2'),
      c('b2', 'wip on b', 'm1'),
      c('m1', 'Merge branch SD-1-a into staging (SD-1)', 'live', 'a1'),
      c('a1', 'wip on a', 'live'),
    ]);
    expect(got.a1).toEqual({ 1: 'merged_in' });
    expect(got.b2).toEqual({ 2: 'merged_in' });
  });

  it('never gives a merge the commits its branch was cut from', () => {
    const got = owners([
      c('m1', 'Merge branch SD-2-b into staging (SD-2)', 'direct', 'b1'),
      c('b1', 'wip on b', 'direct'),
      c('direct', 'chore: a commit made on staging itself', 'live'),
    ]);
    expect(got.b1).toEqual({ 2: 'merged_in' });
    expect(got.direct).toBeUndefined();
  });

  it("walks through a base-into-branch merge and gives its own commit the outer merge's issues", () => {
    const got = owners([
      c('m2', 'Merge branch ISS-439-outcomes into staging (ISS-423)', 'base2', 's1'),
      c('s1', "Merge remote-tracking branch 'origin/staging' into ISS-439-outcomes", 'b1', 'base2'),
      c('base2', 'docs: on staging already (SD-9)', 'live'),
      c('b1', 'fix(qc-agent): bound the rationale', 'live'),
    ]);
    expect(got.s1).toEqual({ 423: 'merged_in' });
    expect(got.b1).toEqual({ 423: 'merged_in' });
    expect(got.base2).toEqual({ 9: 'declares_issue' });
  });

  it('lets a declaring merge met inside another keep its own side', () => {
    const got = owners([
      c('outer', 'Merge branch SD-2-b into staging (SD-2)', 'live', 'inner'),
      c('inner', 'Merge branch SD-1-a into SD-2-b (SD-1)', 'b1', 'a1'),
      c('a1', 'wip on a', 'live'),
      c('b1', 'wip on b', 'live'),
    ]);
    expect(got.a1).toEqual({ 1: 'merged_in' });
    expect(got.b1).toEqual({ 2: 'merged_in' });
  });

  it('stops the walk at a parent the reading did not list', () => {
    const got = owners([c('m1', 'Merge branch SD-1-a into staging', 'live', 'gone')]);
    expect(got).toEqual({ m1: { 1: 'declares_issue' } });
  });

  it('computes once per reading and pattern, and again for another base branch', () => {
    const commits = [c('b1', 'fix: owner (SD-1)', 'live')];
    expect(commitOwners(commits, pattern, 'staging')).toBe(
      commitOwners(commits, pattern, 'staging'),
    );
    expect(commitOwners(commits, pattern, 'develop')).not.toBe(
      commitOwners(commits, pattern, 'staging'),
    );
  });
});
