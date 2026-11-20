import { redactLine } from "../actions/redact";

/**
 * Transcripts are kept word for word, except anything that looks like a
 * secret: the log rules (passwords in URLs, Authorization headers, tokens,
 * long hex keys) plus Hearth's own access keys, webhook addresses,
 * and long random-looking strings such as encryption keys. A hidden
 * harmless value costs little; a stored key could cost a lot.
 */

const EXTRA: [RegExp, string][] = [
  // Hearth access keys and agent keys.
  [/\bdca?_[A-Za-z0-9_-]{16,}/g, "[hidden]"],
  // Discord and Slack webhook addresses carry their secret in the path.
  [/(https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/)[^\s"'<>]+/gi, "$1[hidden]"],
  [/(https?:\/\/hooks\.slack\.com\/services\/)[^\s"'<>]+/gi, "$1[hidden]"],
  // Private key blocks.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[hidden private key]",
  ],
];

/** Long runs of mixed letters and digits, like base64 keys. Paths and words rarely look like this. */
const RANDOM_LOOKING = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

function looksRandom(s: string): boolean {
  if (s.includes("/") && s.split("/").some((part) => part.length > 0 && part.length < 24)) {
    return false; // a path
  }
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

/**
 * Secrets written in sentences, as notes often have them: "the Plex password
 * is Hunter2!", "API key was `abc123`", "PIN set to 4821". A value is hidden
 * when it is quoted or has a digit or symbol in it; plain words ("the
 * password is stored in the vault") are left alone.
 */
const PROSE =
  /\b((?:password|passphrase|passcode|pin|pw|api key|access key|token|secret)(?:\s+(?:for|of|on)\s+[\w.' -]{1,40}?)?\s+(?:is|was|=|set to|changed to|became)\s*:?\s*)(["'`]?)([^\s"'`]+)\2/gi;

/**
 * Near a password word, within a few words: a quoted value with a digit or
 * symbol in it ("password I set was `ab1cd2`", "PIN `4821`"), or a bare word
 * mixing letters with digits or symbols ("login is admin / summer99#").
 * Paths and addresses are left alone.
 */
const NEAR = /\b(password|passphrase|passcode|pin|pw|passwd)\b([^\n]{0,60})/gi;

function looksLikeSecret(token: string, quoted: boolean): boolean {
  const t = token.replace(/^[([{<]+|[)\]}>.,;:!?]+$/g, "");
  if (t.length < 4 || t.length > 64 || t === "[hidden]") return false;
  if (/[\\/]|^https?:|^-|\.(md|json|ts|js|ps1|sh|txt|yml|yaml|conf|xml|db)$/i.test(t)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(t) || /^\d+(\.\d+){1,3}(:\d+)?$/.test(t)) return false; // dates, versions, addresses
  const digits = /\d/.test(t);
  const symbols = /[#!@$%^&*]/.test(t);
  const letters = /[A-Za-z]/.test(t);
  if (quoted) return digits || symbols;
  return (
    letters &&
    ((digits && symbols) || (digits && /[A-Za-z]{3,}\d{2,}$/.test(t)) || (symbols && t.length >= 6))
  );
}

function hideProse(text: string): string {
  const first = text.replace(PROSE, (whole, lead: string, quote: string, value: string) => {
    const bare = value.replace(/[.,;:)]+$/, "");
    if (quote || /[0-9]/.test(bare) || /[^A-Za-z]/.test(bare)) {
      return `${lead}${quote}[hidden]${quote}${value.slice(bare.length)}`;
    }
    return whole;
  });
  return first.replace(NEAR, (_whole, word: string, rest: string) => {
    const parts = rest
      .replace(/([`'"])([^`'"\n]{4,64})\1/g, (m, q: string, v: string) =>
        looksLikeSecret(v, true) && !/\s/.test(v.trim()) ? `${q}[hidden]${q}` : m,
      )
      .split(/(\s+)/);
    // About six words after the password word.
    const hidden = parts
      .slice(0, 12)
      .map((tok) => (looksLikeSecret(tok, false) ? "[hidden]" : tok))
      .join("");
    const tail = parts.slice(12).join("");
    return `${word}${hidden}${tail}`;
  });
}

export function redactTranscript(text: string): string {
  let out = text
    .split("\n")
    .map((line) => redactLine(line))
    .join("\n");
  for (const [pattern, replacement] of EXTRA) out = out.replace(pattern, replacement);
  out = hideProse(out);
  return out.replace(RANDOM_LOOKING, (m) => (looksRandom(m) ? "[hidden]" : m));
}
