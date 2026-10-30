import type { Db } from "../../lib/db.js";
import { emailDomain, normalizeEmail } from "../../lib/email.js";

export interface SuppressionEntry {
  scope: "EMAIL" | "DOMAIN";
  value: string;
}

/** Builds a matcher over suppression records: an address is suppressed by its exact email or its domain. */
export function suppressionMatcher(records: readonly SuppressionEntry[]): (email: string) => boolean {
  const set = new Set(records.map((r) => `${r.scope}:${r.value}`));
  return (email) => {
    const normalized = normalizeEmail(email);
    return set.has(`EMAIL:${normalized}`) || set.has(`DOMAIN:${emailDomain(normalized)}`);
  };
}

export async function isSuppressed(db: Pick<Db, "suppressionRecord">, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const match = await db.suppressionRecord.findFirst({
    where: {
      OR: [
        { scope: "EMAIL", value: normalized },
        { scope: "DOMAIN", value: emailDomain(normalized) },
      ],
    },
    select: { id: true },
  });
  return match !== null;
}
