import { type JobEventInput, postJobEvents, relayAgentEvent } from "@/lib/api";

/**
 * The two WS-side batchers, both on the same 100 ms cadence but with
 * DIFFERENT flush contracts — do NOT merge their semantics:
 *
 * - RelayBatcher (agent:message → one `agent:batch` relay per session):
 *   `flush()` resolves when THIS call's drain settles. If the queue is empty
 *   it resolves immediately — even while a previous drain's relay POSTs are
 *   still in flight. Flushes are NOT serialized: a timer-driven flush and an
 *   explicit `flush()` can overlap and run their per-session relays
 *   concurrently. That's acceptable because the relay is best-effort
 *   (failures swallowed) and ordering to web chat UIs is cosmetic.
 *
 * - JobEventBatcher (stream chunks → POST /api/jobs/:id/events): flushes are
 *   serialized through a single promise chain (`jobFlushInFlight`) and
 *   `flush()` ALWAYS returns the chain tail — including when the queue is
 *   empty. Awaiting it therefore waits for EVERY previously queued POST to
 *   land, even ones drained by an earlier timer-driven flush. This is
 *   load-bearing: agent:complete awaits `flush()` before POSTing
 *   /api/jobs/:id/complete — a job_event POST still in flight when /complete
 *   moves the job terminal would get 409 JOB_TERMINATED.
 */
const FLUSH_INTERVAL = 100; // ms

export type RelayBatcher = {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous stream payloads
  enqueue: (sessionId: string, event: string, data: any) => void;
  /** Drains the pending agent:message relay batch (see contract above). */
  flush: () => Promise<void>;
  /** Unmount path: clear the pending timer WITHOUT flushing (queued items are dropped). */
  dispose: () => void;
};

/** Batch relay: accumulate agent:message events and flush periodically. */
export function createRelayBatcher(): RelayBatcher {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous stream payloads
  const relayQueue: { sessionId: string; event: string; data: any }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushRelay() {
    flushTimer = null;
    if (relayQueue.length === 0) return;
    const batch = relayQueue.splice(0, relayQueue.length);
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous stream payloads
    const bySession = new Map<string, { event: string; data: any }[]>();
    for (const item of batch) {
      let arr = bySession.get(item.sessionId);
      if (!arr) {
        arr = [];
        bySession.set(item.sessionId, arr);
      }
      arr.push({ event: item.event, data: item.data });
    }
    for (const [sid, items] of bySession) {
      try {
        await relayAgentEvent(sid, "agent:batch", { items });
      } catch {
        /* ignore */
      }
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous stream payloads
  function enqueueRelay(sessionId: string, event: string, data: any) {
    relayQueue.push({ sessionId, event, data });
    if (!flushTimer) {
      flushTimer = setTimeout(flushRelay, FLUSH_INTERVAL);
    }
  }

  return {
    enqueue: enqueueRelay,
    flush: flushRelay,
    dispose: () => {
      if (flushTimer) clearTimeout(flushTimer);
    },
  };
}

export type JobEventBatcher = {
  enqueue: (jobId: string, events: JobEventInput[]) => void;
  /**
   * Triggers any pending batch and returns the in-flight chain tail; awaiting
   * it waits for every queued POST to land (see contract above).
   */
  flush: () => Promise<void>;
  /** Unmount path: clear the pending timer WITHOUT flushing (queued items are dropped). */
  dispose: () => void;
};

/**
 * Job event batch (parallel to the relay queue): chunks bound for
 * packages/core's /api/jobs/:id/events. Same 100ms cadence; per-job batches
 * are post.
 */
export function createJobEventBatcher(): JobEventBatcher {
  const jobEventQueue = new Map<string, JobEventInput[]>();
  let jobFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Chain in-flight flushes so agent:complete can `await` the tail
  // before calling /complete — otherwise the timer-driven flush (which
  // clears the queue immediately and awaits the POST) can finish AFTER
  // /complete lands and the still-in-flight events get 409 JOB_TERMINATED.
  let jobFlushInFlight: Promise<void> = Promise.resolve();

  function flushJobEvents(): Promise<void> {
    jobFlushTimer = null;
    if (jobEventQueue.size === 0) return jobFlushInFlight;
    const drained: Array<[string, JobEventInput[]]> = Array.from(jobEventQueue.entries());
    jobEventQueue.clear();
    // Chain so back-to-back flushes serialize and `await jobFlushInFlight`
    // from agent:complete waits for every queued POST to land.
    jobFlushInFlight = jobFlushInFlight.then(async () => {
      for (const [jobId, events] of drained) {
        if (events.length === 0) continue;
        try {
          await postJobEvents(jobId, events);
        } catch (err) {
          console.error(`[job-events] flush failed for ${jobId}:`, err);
        }
      }
    });
    return jobFlushInFlight;
  }

  function enqueueJobEvents(jobId: string, events: JobEventInput[]) {
    if (events.length === 0) return;
    let arr = jobEventQueue.get(jobId);
    if (!arr) {
      arr = [];
      jobEventQueue.set(jobId, arr);
    }
    arr.push(...events);
    if (!jobFlushTimer) {
      jobFlushTimer = setTimeout(flushJobEvents, FLUSH_INTERVAL);
    }
  }

  return {
    enqueue: enqueueJobEvents,
    flush: flushJobEvents,
    dispose: () => {
      if (jobFlushTimer) clearTimeout(jobFlushTimer);
    },
  };
}
