import { z } from "zod";
import { notFound } from "./errors.js";

const noControlChars = (s: string) => !/\p{Cc}/u.test(s);

/** Trimmed single-line text without control characters. */
export const safeText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine(noControlChars, "must not contain control characters");

/** Multi-line text: allows newlines and tabs, nothing else from the control range. */
export const safeMultilineText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => noControlChars(s.replace(/[\n\t]/g, "")), "must not contain control characters");

const idParam = z.object({ id: z.uuid() });

/** Route `:id` as a UUID; anything else is reported as not found. */
export function parseId(params: unknown): string {
  const parsed = idParam.safeParse(params);
  if (!parsed.success) throw notFound("Resource");
  return parsed.data.id;
}
