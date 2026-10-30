export interface OutgoingEmail {
  from: { name: string | null; address: string };
  to: string;
  subject: string;
  body: string;
  /** Generated before sending so an uncertain send can be looked up later. */
  rfcMessageId: string;
  listUnsubscribe: string | null;
}

export interface SentEmail {
  providerMessageId: string;
  threadId: string | null;
}

export interface InboundReply {
  receivedAt: Date;
  /** Short text (e.g. a snippet) used only for opt-out detection; never stored. */
  text: string;
}

/**
 * FAILURE: the provider definitely did not accept the message (safe to treat
 * as not sent). UNKNOWN: it may or may not have been sent (timeout, 5xx,
 * dropped connection); the caller must reconcile, never resend blindly.
 */
export class EmailSendError extends Error {
  constructor(
    readonly outcome: "FAILURE" | "UNKNOWN",
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

export interface EmailProvider {
  readonly name: string;
  readonly senderAddress: string;
  /** Sends exactly once; never retries internally. Throws EmailSendError. */
  send(email: OutgoingEmail): Promise<SentEmail>;
  /** Looks up a previously sent message by its Message-ID header. */
  findSent(rfcMessageId: string): Promise<SentEmail | null>;
  /** Messages in the thread from anyone other than the sender, received after `after`. */
  repliesInThread(threadId: string, after: Date): Promise<InboundReply[]>;
}
