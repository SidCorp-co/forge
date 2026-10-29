**Releases given up on under the old shared-checkout rule are retried after an upgrade.** A daemon start re-arms each once, names it in the journal, and `forge-runner status` counts them.
