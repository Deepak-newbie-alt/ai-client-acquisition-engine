import { createHash } from "node:crypto";
import { normalizeEmail } from "./email.js";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Normalization for detecting duplicate or syndicated text, not for display. */
export function normalizeTextForHash(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function textContentHash(text: string): string {
  return sha256Hex(normalizeTextForHash(text));
}

export interface OutreachContent {
  recipientEmail: string;
  subject: string;
  body: string;
}

/**
 * Hash that an approval is bound to. It covers exactly what will be sent:
 * only the recipient's case and line-ending style are normalized, so any
 * visible change to subject or body produces a different hash.
 */
export function outreachContentHash({ recipientEmail, subject, body }: OutreachContent): string {
  return sha256Hex(
    JSON.stringify([
      "outreach-v1",
      normalizeEmail(recipientEmail),
      subject,
      body.replace(/\r\n?/g, "\n"),
    ]),
  );
}
