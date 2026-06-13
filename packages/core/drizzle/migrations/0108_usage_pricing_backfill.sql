-- ISS-438 — backfill usage_records.estimated_cost for the model families whose
-- pricing the table got wrong (usage-records/pricing.ts):
--   * Opus 4.5–4.8 were priced at the legacy 4.0/4.1 rate ($15/$75) because the
--     generic 'claude-opus-4' key matched before the specific ones → 3× high.
--   * claude-fable-5 / claude-mythos-* were absent → estimated_cost = 0.
--   * claude-haiku-4-5 was priced at the 3.5 rate (0.8/4) instead of $1/$5.
-- Recompute with the same per-token math as estimateCost() (rounded to 5
-- decimals). Idempotent: re-running recomputes to the same values.

-- Opus 4.5–4.8 → $5/$25, cache read $0.5, cache write $6.25
UPDATE usage_records
SET estimated_cost = round((
      (input_tokens * 5.0 + output_tokens * 25.0 +
       cache_read_tokens * 0.5 + cache_creation_tokens * 6.25) / 1000000.0
    )::numeric, 5)
WHERE model ~* 'claude-opus-4-[5-8]';--> statement-breakpoint

-- Fable 5 / Mythos → $10/$50, cache read $1.0, cache write $12.5
UPDATE usage_records
SET estimated_cost = round((
      (input_tokens * 10.0 + output_tokens * 50.0 +
       cache_read_tokens * 1.0 + cache_creation_tokens * 12.5) / 1000000.0
    )::numeric, 5)
WHERE model ~* 'claude-(fable-5|mythos)';--> statement-breakpoint

-- Haiku 4.5 → $1/$5, cache read $0.1, cache write $1.25
UPDATE usage_records
SET estimated_cost = round((
      (input_tokens * 1.0 + output_tokens * 5.0 +
       cache_read_tokens * 0.1 + cache_creation_tokens * 1.25) / 1000000.0
    )::numeric, 5)
WHERE model ~* 'claude-haiku-4-5';
