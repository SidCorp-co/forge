// The migrate process's entry: the error-tracking port is installed before db/migrate.ts runs, so
// a failed boot migration and the drift it finds reach the operator's tracker through the port.
import './error-tracking-init.js';
import { migrateAtBoot } from './db/migrate.js';

process.exit(await migrateAtBoot(process.env.DATABASE_URL));
