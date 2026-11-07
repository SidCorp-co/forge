import { portSlot } from '../lib/port-slot.js';

/** An issue as a task an agreement's condition is matched against. */
export interface IssueTask {
  projectId: string;
  labels: string[];
  category: string | null;
}

/**
 * What agreements reach but do not own. Issues sit downstream (Work after Knowledge), so the module
 * names what it reads of one and the composition root fills it at boot.
 */
export interface AgreementsPorts {
  /** The issue's labels and category; null where there is no such issue. */
  issueTaskOf(issueId: string): Promise<IssueTask | null>;
}

const slot = portSlot<AgreementsPorts>('agreements', 'provideAgreementsPorts');
export const provideAgreementsPorts = slot.provide;
export const agreementsPort = slot.port;
