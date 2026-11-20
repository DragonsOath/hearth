/**
 * A word as it must be typed in a terminal: left alone when it is plain, otherwise quoted, with
 * the characters a double-quoted shell string treats specially escaped. Used where Hearth shows a
 * command to copy, such as signing in as the account it runs as.
 */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9._@-]+$/.test(s) ? s : `"${s.replace(/["\\$`]/g, (c) => `\\${c}`)}"`;
}
