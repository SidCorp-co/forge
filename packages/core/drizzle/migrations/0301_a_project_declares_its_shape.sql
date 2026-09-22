-- ISS-1189 — a project declares its release shape, and every reader reads that declaration.
--
-- Two axes, each written once here so nothing has to be inferred afterwards.
--
-- `projects.preview_shape` says where a `standard` project's work is exercised before it reaches
-- live: `deployed` (a preview deployment somebody opens) or `local` (the run's own box, which is
-- the normal shape for a one-box project, not a degraded one). Until now the only answer available
-- was whether `environments.preview` happened to be null, which every reader derived for itself
-- and none could be told it had derived wrongly.
--
-- `states.awaiting_release.mode` says whether releasing is automatic. `release-sweep.ts` read
-- `pipelineConfig.autoProdDeploy` for that, whose own question is whether a live-reaching deploy
-- skips its human-confirm gate. The two are different and one boolean was answering both, so the
-- second UPDATE below carries every project's existing answer onto the field that now holds it —
-- without it, a project releasing automatically today would silently stop.
--
-- The abort is deliberate and comes first. A stored preview side naming live's host is not
-- representable under a column that says what the preview side IS: deriving `deployed` for it
-- would leave the contradiction standing under a field claiming to have answered it. forge-dev
-- carried exactly that value until 2026-09-22 (preview and live on forge-beta.sidcorp.co and
-- forge-beta-api.sidcorp.co, labelled "Beta Version (Staging Here)"), so the row this refuses is
-- one that really existed. Clear the preview side on each project named, then run again.
--
-- Running it backwards: DROP COLUMN "preview_shape" and delete `mode` from
-- agent_config -> 'pipelineConfig' -> 'states' -> 'awaiting_release' on every project this wrote
-- it to. Both are additive here, so code that predates them runs unchanged against this schema.
DO $shape$
DECLARE
  offenders text;
BEGIN
  WITH sides AS (
    SELECT
      p.slug,
      ARRAY(
        SELECT lower(substring(u FROM '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)'))
          FROM unnest(
            ARRAY[
              p.environments -> 'preview' ->> 'url',
              p.environments -> 'preview' ->> 'apiUrl'
            ] || COALESCE((
              SELECT array_agg(e ->> 'url')
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(p.environments -> 'preview' -> 'urls') = 'array'
                       THEN p.environments -> 'preview' -> 'urls'
                       ELSE '[]'::jsonb END
                ) e
            ), ARRAY[]::text[])
          ) AS u
         WHERE u IS NOT NULL
           AND substring(u FROM '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)') IS NOT NULL
      ) AS preview_hosts,
      ARRAY(
        SELECT lower(substring(u FROM '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)'))
          FROM unnest(ARRAY[
            p.environments -> 'live' ->> 'url',
            p.environments -> 'live' ->> 'apiUrl'
          ]) AS u
         WHERE u IS NOT NULL
           AND substring(u FROM '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)') IS NOT NULL
      ) AS live_hosts
      FROM projects p
     WHERE jsonb_typeof(p.environments -> 'preview') = 'object'
  )
  SELECT string_agg(format('%s (shares %s)', slug, shared), ', ' ORDER BY slug)
    INTO offenders
    FROM (
      SELECT slug, (SELECT string_agg(DISTINCT h, ' and ')
                      FROM unnest(preview_hosts) h
                     WHERE h = ANY(live_hosts)) AS shared
        FROM sides
       WHERE preview_hosts && live_hosts
    ) t;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'ISS-1189: a project''s preview side names the same host as its live side, which preview_shape cannot represent: ' || offenders,
      HINT = 'That configuration says the preview IS production, so a run sent to "the preview" would exercise live. Clear environments.preview to null on each project named (its work is exercised locally), or point the preview side at a host live does not serve, then run this migration again.';
  END IF;
END
$shape$;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "preview_shape" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_preview_shape_chk";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_preview_shape_chk"
  CHECK ("preview_shape" IN ('deployed', 'local'));--> statement-breakpoint
UPDATE "projects"
   SET "preview_shape" = 'deployed'
 WHERE jsonb_typeof("environments" -> 'preview') = 'object'
   AND (
     COALESCE("environments" -> 'preview' ->> 'url', '') <> ''
     OR COALESCE("environments" -> 'preview' ->> 'apiUrl', '') <> ''
     OR (jsonb_typeof("environments" -> 'preview' -> 'urls') = 'array'
         AND jsonb_array_length("environments" -> 'preview' -> 'urls') > 0)
   );--> statement-breakpoint
UPDATE "projects"
   SET "agent_config" = jsonb_set(
         jsonb_set(
           jsonb_set(
             "agent_config",
             '{pipelineConfig,states}',
             COALESCE("agent_config" -> 'pipelineConfig' -> 'states', '{}'::jsonb),
             true
           ),
           '{pipelineConfig,states,awaiting_release}',
           COALESCE("agent_config" -> 'pipelineConfig' -> 'states' -> 'awaiting_release', '{}'::jsonb),
           true
         ),
         '{pipelineConfig,states,awaiting_release,mode}',
         '"auto"'::jsonb,
         true
       )
 WHERE jsonb_typeof("agent_config" -> 'pipelineConfig') = 'object'
   AND "agent_config" -> 'pipelineConfig' ->> 'autoProdDeploy' = 'true';
