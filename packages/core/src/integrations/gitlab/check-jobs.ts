/**
 * A GitLab check's jobs and one job's trace. A check the checks reads answer is a pipeline, and its
 * id a pipeline id; a trace is a job's. Each verb takes its own kind of id, and an id of the other
 * kind is told apart by reading it as that kind after the 404, then refused by name with the route
 * that takes it (FB-469, ISS-931), never answered as a host that failed.
 */

import type { CheckJob, CheckJobs, CheckLog, SourceHost } from '../source-host/index.js';
import { refuseCheckIdKind, SourceHostCallError } from '../source-host/index.js';
import type { GitLabClient } from './client.js';
import { checkStatusOf, conclusionOf } from './status.js';

const LOG_CAP_BYTES = 2 * 1024 * 1024;
const DEFAULT_LOG_LINES = 100;
/** A pipeline's jobs are listed a hundred a page; a list that fills every page may stand longer. */
const JOB_MAX_PAGES = 10;
const JOBS_PER_PAGE = 100;

interface JobBody {
  id?: number;
  name?: string;
  status?: string;
  stage?: string;
  web_url?: string | null;
  failure_reason?: string | null;
}

function tail(text: string, lines: number): { text: string; truncated: boolean } {
  const all = text.split('\n');
  if (all.length <= lines) return { text, truncated: false };
  return { text: all.slice(all.length - lines).join('\n'), truncated: true };
}

function notFound(err: unknown): boolean {
  return err instanceof SourceHostCallError && err.phase === 'request' && err.status === 404;
}

/** Whether GitLab answers `path` at all: a 404 is no, any other failure is the host's and thrown. */
async function answers(client: GitLabClient, path: string): Promise<boolean> {
  try {
    await client.json('GET', path);
    return true;
  } catch (err) {
    if (notFound(err)) return false;
    throw err;
  }
}

function jobOf(job: JobBody & { id: number }): CheckJob {
  return {
    jobId: job.id,
    name: job.name ?? '(unnamed job)',
    stage: job.stage ?? null,
    status: checkStatusOf(job.status),
    conclusion: conclusionOf(job.status),
    failureReason: job.failure_reason ?? null,
    detailsUrl: job.web_url ?? null,
  };
}

type CheckVerbs = Pick<SourceHost, 'checkJobs' | 'checkLog'>;

export function gitlabCheckVerbs(client: GitLabClient): CheckVerbs {
  return {
    // a check is a pipeline, and its id is a pipeline id: a job id sent here 404s on the pipeline
    // read, and is told apart by reading it as a job, so the caller is sent to the log route by name
    async checkJobs({ checkId }): Promise<CheckJobs> {
      let listed: JobBody[];
      try {
        listed = await client.pages<JobBody>(
          client.project(`/pipelines/${checkId}/jobs`),
          JOB_MAX_PAGES,
        );
      } catch (err) {
        if (notFound(err) && (await answers(client, client.project(`/jobs/${checkId}`)))) {
          throw refuseCheckIdKind(
            'CHECK_ID_IS_A_JOB',
            `${checkId} is a job on ${client.fullName}, not a pipeline, so it has no jobs to list — read its trace at \`checks/${checkId}/log\``,
          );
        }
        throw err;
      }
      const jobs = listed.flatMap((j) =>
        typeof j.id === 'number' ? [jobOf({ ...j, id: j.id })] : [],
      );
      return { checkId, jobs, truncated: listed.length >= JOB_MAX_PAGES * JOBS_PER_PAGE };
    },

    // the log takes a job id; a pipeline id (what the checks reads answer) 404s on the job read, and
    // is told apart by reading it as a pipeline, so it is refused naming the job list, not a dead host
    async checkLog({ checkRunId, lines }): Promise<CheckLog> {
      let job: JobBody;
      try {
        job = await client.json<JobBody>('GET', client.project(`/jobs/${checkRunId}`));
      } catch (err) {
        if (notFound(err) && (await answers(client, client.project(`/pipelines/${checkRunId}`)))) {
          throw refuseCheckIdKind(
            'CHECK_ID_IS_A_PIPELINE',
            `${checkRunId} is a pipeline on ${client.fullName}, not a job, and a log is a job's — list its jobs at \`checks/${checkRunId}/jobs\` and read the failed one's trace at \`checks/:jobId/log\``,
          );
        }
        throw err;
      }
      const base = {
        checkRunId,
        name: job.name ?? '(unnamed job)',
        app: 'gitlab-ci',
        status: checkStatusOf(job.status),
        conclusion: conclusionOf(job.status),
        detailsUrl: job.web_url ?? null,
        summary: job.failure_reason ?? null,
      };
      let raw: { body: string; bytes: number; truncated: boolean };
      try {
        raw = await client.text(client.project(`/jobs/${checkRunId}/trace`), LOG_CAP_BYTES, 'tail');
      } catch (err) {
        if (err instanceof SourceHostCallError) {
          return {
            ...base,
            log: null,
            truncated: false,
            refusal: `GitLab answered HTTP ${err.status} for the trace of job ${checkRunId} — a 404 is a trace GitLab has erased or a job it has removed, a 403 a permission the token does not hold on ${client.fullName}. Nothing was retried.`,
          };
        }
        throw err;
      }
      const tailed = tail(raw.body, lines ?? DEFAULT_LOG_LINES);
      return {
        ...base,
        log: tailed.text,
        truncated: tailed.truncated || raw.truncated,
        refusal: null,
      };
    },
  };
}
