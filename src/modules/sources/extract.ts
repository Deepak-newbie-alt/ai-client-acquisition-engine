import * as cheerio from "cheerio";

export interface ExtractedPage {
  title: string | null;
  text: string;
  truncated: boolean;
  /** The page opts out of AI processing via a robots meta "noai" directive. */
  noAi: boolean;
}

const REMOVED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "form",
  "nav",
  "footer",
  "aside",
  "[hidden]",
  '[aria-hidden="true"]',
].join(", ");

const BLOCK_ELEMENTS = "p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article, blockquote, pre, dd, dt";

// Zero-width and bidirectional control characters are a common way to hide
// instructions from human reviewers; other control characters have no place
// in extracted prose.
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])/i;

/**
 * Converts untrusted HTML into plain text. Cheerio only parses; no script is
 * ever executed. Hidden elements are dropped so that text invisible to a human
 * reader is not passed to the model.
 */
export function extractPageText(html: string, maxChars = 20_000): ExtractedPage {
  const $ = cheerio.load(html);

  const robotsMeta = $('meta[name="robots" i], meta[name="googlebot" i]')
    .map((_, el) => $(el).attr("content") ?? "")
    .get()
    .join(",")
    .toLowerCase();
  const noAi = /\bnoai\b/.test(robotsMeta);

  const title = clean($("title").first().text()) || null;

  $(REMOVED_ELEMENTS).remove();
  $("[style]").each((_, el) => {
    if (HIDDEN_STYLE.test($(el).attr("style") ?? "")) $(el).remove();
  });

  const main = $("main").first();
  const article = $("article").first();
  const root = main.length ? main : article.length ? article : $("body");

  root.find("br").replaceWith("\n");
  root.find(BLOCK_ELEMENTS).each((_, el) => {
    $(el).prepend("\n").append("\n");
  });

  const text = root
    .text()
    .replace(INVISIBLE_CHARS, "")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const truncated = text.length > maxChars;
  return { title, text: truncated ? text.slice(0, maxChars) : text, truncated, noAi };
}

function clean(s: string): string {
  return s.replace(INVISIBLE_CHARS, "").replace(/\s+/g, " ").trim().slice(0, 300);
}
