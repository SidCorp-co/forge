// The migrate process's entry: the error-tracking port is installed before db/migrate.ts runs, so
// the drift it finds reaches the operator's tracker through the port.
import './error-tracking-init.js';
import './db/migrate.js';
