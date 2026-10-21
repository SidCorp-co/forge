(globalThis as { process?: unknown }).process ??= { env: { NODE_ENV: "production" } };
