-- ISS-1389 — a project holds no API key, because nothing authenticates with one.
--
-- WHAT GOES: `projects.api_key` and its partial unique index. The key was minted for the embeddable
-- widget (0034, ISS-295); the widget was swapped out in 98db903ee and the middleware that checked
-- the key has been mounted on no route since. A listing still handed every key to every reader, so
-- the column was a secret that opened nothing and leaked anyway. Every value is discarded: no route,
-- job or client reads one, and no row of any other table refers to it.
DROP INDEX "projects_api_key_uq";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "api_key";
