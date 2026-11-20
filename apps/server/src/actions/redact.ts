/**
 * Log lines are shown to you and, later, to an AI agent. Apps sometimes
 * print secrets (API keys in URLs, tokens in headers), so anything that
 * looks like one is hidden before a line leaves this module. It errs on
 * the side of hiding: a hidden harmless value costs nothing.
 */

const HIDDEN = "[hidden]";

// Terminal colour codes start with the ESC control character; matching it is the point.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const RULES: [RegExp, string][] = [
  // user:password@ in URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${HIDDEN}@`],
  // An Authorization header hides everything after it
  [/(\b(?:proxy-)?authorization["']?\s*[:=]\s*)[^\r\n]+/gi, `$1${HIDDEN}`],
  // Bearer xxx / Basic xxx elsewhere
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${HIDDEN}`],
  // key=value, key: value, "key":"value" (also with escaped quotes) for secret-sounding keys
  [
    /((?:api[_-]?key|apikey|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|pass|session[_-]?id|cookie)\\?["']?\s*[:=]\s*\\?["']?)([^\s"'&,;}\\]+)/gi,
    `$1${HIDDEN}`,
  ],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN],
  // Long hex strings (API keys are often 32+ hex characters)
  [/\b[a-f0-9]{32,}\b/gi, HIDDEN],
];

export function redactLine(line: string): string {
  let out = line.replace(ANSI, "");
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
