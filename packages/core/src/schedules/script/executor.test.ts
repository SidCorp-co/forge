import { describe, expect, it } from 'vitest';
import { runScheduleScript } from './executor.js';

// These spawn a REAL worker thread running the REAL vm sandbox — no mocking.
// This is the actual security boundary (AC #3/#4), so it's worth exercising
// end-to-end rather than stubbing the executor away.

describe('runScheduleScript', () => {
  it('captures ctx.log output and ctx.notify payloads on success', async () => {
    const result = await runScheduleScript({
      script: `ctx.log("hello", 42); ctx.notify({title: "t1", body: "b1"});`,
    });
    expect(result.status).toBe('success');
    expect(result.output).toBe('hello 42');
    expect(result.notifications).toEqual([{ title: 't1', body: 'b1' }]);
  });

  it('a thrown error records status=failed with the error message, never throws', async () => {
    const result = await runScheduleScript({ script: `throw new Error("boom")` });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toMatch(/boom/);
  });

  it('an infinite loop is hard-killed at the timeout, never hangs the caller', async () => {
    const result = await runScheduleScript({ script: 'while (true) {}', timeoutMs: 500 });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toBe('timeout');
  }, 10_000);

  it('fs/process/require are unreachable — denial surfaces as a caught error, not a crash', async () => {
    const result = await runScheduleScript({
      script: `
        const denied = [];
        try { require("fs"); } catch (e) { denied.push("require"); }
        try { process.exit(1); } catch (e) { denied.push("process"); }
        ctx.log(denied.join(","));
      `,
    });
    expect(result.status).toBe('success');
    expect(result.output).toBe('require,process');
  });

  it('ctx.http.fetch rejects non-https URLs', async () => {
    const result = await runScheduleScript({
      script: `await ctx.http.fetch("http://example.com");`,
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toMatch(/https/);
  });

  it('ctx.params is readable but frozen (mutation attempts fail)', async () => {
    const result = await runScheduleScript({
      script: `
        let mutated = false;
        try { ctx.params.x = 2; mutated = (ctx.params.x === 2); } catch (e) { /* strict-mode throw is also acceptable */ }
        ctx.log(JSON.stringify({ x: ctx.params.x, mutated }));
      `,
      params: { x: 1 },
    });
    expect(result.status).toBe('success');
    expect(JSON.parse(result.output)).toEqual({ x: 1, mutated: false });
  });

  it('output is truncated past the cap so a runaway logger cannot blow up the run record', async () => {
    const result = await runScheduleScript({
      script: `for (let i = 0; i < 5000; i++) { ctx.log("x".repeat(20)); }`,
    });
    expect(result.status).toBe('success');
    expect(result.output.length).toBeLessThan(17_000);
    expect(result.output.endsWith('[truncated]')).toBe(true);
  });
});
