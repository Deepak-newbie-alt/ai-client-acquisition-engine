import { z } from "zod";

const emailSchema = z.email();

/**
 * Lowercases and trims an address for comparison and suppression lookups.
 * Provider-specific rewriting (dots, "+tags") is deliberately not applied:
 * it is not universally valid and would merge distinct mailboxes.
 */
export function normalizeEmail(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return emailSchema.safeParse(normalizeEmail(email)).success;
}

export function emailDomain(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  if (at < 1 || at === normalized.length - 1) throw new Error("Invalid email address");
  return normalized.slice(at + 1);
}
