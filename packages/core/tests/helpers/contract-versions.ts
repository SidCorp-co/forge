import { sql } from 'drizzle-orm';
import type { TestDb } from './db.js';

export async function seedContractVersion(
  db: TestDb,
  input: {
    providerId: string;
    ref: string;
    version: string;
    type?: string;
    elements?: string[] | null;
  },
): Promise<void> {
  const slug = input.ref.slice(input.ref.indexOf('/') + 1);
  const observedAt = new Date().toISOString();
  const document = {
    $schema: 'https://forge.sidcorp.co/schemas/contract-version-v1.json',
    version: 1,
    contract: input.ref,
    contractVersion: input.version,
    previous: null,
    artifact: null,
    observedAt,
    diff: { tool: 'none', classification: 'initial', changes: [] },
  };
  const elements = input.elements ?? null;
  await db.execute(sql`
    INSERT INTO contract_versions
      (provider_project_id, contract_slug, version, recorded_at, contract_type, document, classification, elements)
    VALUES (${input.providerId}, ${slug}, ${input.version}, ${observedAt}, ${input.type ?? 'openapi'},
            ${JSON.stringify(document)}::jsonb, 'initial',
            ${
              elements === null
                ? null
                : sql`ARRAY[${sql.join(
                    elements.map((e) => sql`${e}`),
                    sql`, `,
                  )}]::text[]`
            })
  `);
}
