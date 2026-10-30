import { randomUUID } from "node:crypto";
import { EmailSendError, type EmailProvider, type InboundReply, type OutgoingEmail, type SentEmail } from "./types.js";

/**
 * deliver: accepted. reject: definitely not sent.
 * timeout-delivered: sent, but the caller never hears back (outcome UNKNOWN).
 * timeout-lost: not sent, and the caller never hears back (outcome UNKNOWN).
 */
export type MockSendBehavior = "deliver" | "reject" | "timeout-delivered" | "timeout-lost";

/** In-memory provider for development and tests. Never contacts anyone. */
export class MockEmailProvider implements EmailProvider {
  readonly name = "mock";
  readonly sent: (OutgoingEmail & SentEmail)[] = [];
  behavior: MockSendBehavior = "deliver";
  /** Number of send() calls, including failed ones. */
  attempts = 0;
  private readonly replies = new Map<string, InboundReply[]>();

  constructor(readonly senderAddress = "outreach@example.com") {}

  send(email: OutgoingEmail): Promise<SentEmail> {
    this.attempts++;
    if (this.behavior === "reject") {
      return Promise.reject(new EmailSendError("FAILURE", "REJECTED", "Mock provider rejected the message"));
    }
    if (this.behavior === "timeout-lost") {
      return Promise.reject(new EmailSendError("UNKNOWN", "TIMEOUT", "Mock provider timed out"));
    }
    const result = { providerMessageId: `mock-${randomUUID()}`, threadId: `thread-${randomUUID()}` };
    this.sent.push({ ...email, ...result });
    if (this.behavior === "timeout-delivered") {
      return Promise.reject(new EmailSendError("UNKNOWN", "TIMEOUT", "Mock provider timed out"));
    }
    return Promise.resolve(result);
  }

  findSent(rfcMessageId: string): Promise<SentEmail | null> {
    const found = this.sent.find((m) => m.rfcMessageId === rfcMessageId);
    return Promise.resolve(found ? { providerMessageId: found.providerMessageId, threadId: found.threadId } : null);
  }

  repliesInThread(threadId: string, after: Date): Promise<InboundReply[]> {
    return Promise.resolve((this.replies.get(threadId) ?? []).filter((r) => r.receivedAt > after));
  }

  /** Test and demo hook: simulate a reply arriving in a thread. */
  addReply(threadId: string, text: string, receivedAt = new Date()): void {
    this.replies.set(threadId, [...(this.replies.get(threadId) ?? []), { receivedAt, text }]);
  }
}
