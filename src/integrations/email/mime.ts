import type { OutgoingEmail } from "./types.js";

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// eslint-disable-next-line no-control-regex
const LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f]/;

function assertHeaderSafe(name: string, value: string): void {
  // CR/LF in a header value would let content inject extra headers or recipients.
  if (LINE_BREAK_OR_CONTROL.test(value)) throw new Error(`Unsafe characters in ${name} header`);
}

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeaderValue(value: string): string {
  return PRINTABLE_ASCII.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatAddress(name: string | null, address: string): string {
  if (!name) return address;
  const display = PRINTABLE_ASCII.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : encodeHeaderValue(name);
  return `${display} <${address}>`;
}

const wrap = (s: string, width: number) => s.match(new RegExp(`.{1,${width}}`, "g"))?.join("\r\n") ?? "";

/** Builds a plain-text RFC 5322 message with a base64-encoded UTF-8 body. */
export function buildMimeMessage(email: OutgoingEmail, date = new Date()): string {
  assertHeaderSafe("To", email.to);
  assertHeaderSafe("Subject", email.subject);
  assertHeaderSafe("From", `${email.from.name ?? ""}${email.from.address}`);
  assertHeaderSafe("Message-ID", email.rfcMessageId);
  if (email.listUnsubscribe) assertHeaderSafe("List-Unsubscribe", email.listUnsubscribe);

  const headers = [
    `From: ${formatAddress(email.from.name, email.from.address)}`,
    `To: ${email.to}`,
    `Subject: ${encodeHeaderValue(email.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${email.rfcMessageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    ...(email.listUnsubscribe ? [`List-Unsubscribe: ${email.listUnsubscribe}`] : []),
  ];
  const body = Buffer.from(email.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  return `${headers.join("\r\n")}\r\n\r\n${wrap(body, 76)}\r\n`;
}
