import type { JobStatus } from '../db/schema.js';

/**
 * The named answers about `jobStatuses`. One question has one answer: a caller
 * asks by importing the name, never by writing the tuple again.
 */

/** The job is not over: it holds a runner slot, waits for one, or waits for a person. */
export const LIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'dispatched', 'running', 'held'];

/**
 * status-tuple: differs — `held` is a job waiting on a person, not on a runner,
 * so a reader counting work the pipeline is moving must exclude it while a
 * reader counting occupied slots must not. Merging this into
 * {@link LIVE_JOB_STATUSES} would add `held` to three call sites that exclude
 * it today, which is a change of behaviour rather than of spelling.
 */
export const UNHELD_LIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'dispatched', 'running'];

/** The job is out with a runner, so it occupies one of that runner's slots. */
export const OCCUPYING_JOB_STATUSES: readonly JobStatus[] = ['dispatched', 'running'];

/** The job is over. Nothing further will run for it, whichever exit it took. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['done', 'failed', 'cancelled'];
