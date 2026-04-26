// Minimal line-level diff for SKILL.md override vs global. Computes the LCS of
// two line arrays and emits a unified-diff-style sequence of {kind, text} ops.
// Good enough for a few hundred lines of markdown; not production-grade.

export type DiffOp = {
  kind: 'add' | 'del' | 'eq';
  text: string;
};

export function lineDiff(a: string, b: string): DiffOp[] {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  const n = A.length;
  const m = B.length;

  // LCS DP table — O(n*m) memory; fine for skill markdown sizes.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (A[i] === B[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ kind: 'eq', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', text: A[i] });
      i++;
    } else {
      ops.push({ kind: 'add', text: B[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: A[i++] });
  while (j < m) ops.push({ kind: 'add', text: B[j++] });
  return ops;
}
