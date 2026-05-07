-- ISS-42 C2 — complexity field on issues. Nullable (existing rows stay NULL);
-- accepts t-shirt sizes xs/s/m/l/xl. Constraint guards against typos from
-- direct SQL updates; the API layer's zod enum guards normal writes.
ALTER TABLE issues ADD COLUMN complexity text;
ALTER TABLE issues ADD CONSTRAINT issues_complexity_chk
  CHECK (complexity IS NULL OR complexity IN ('xs','s','m','l','xl'));
