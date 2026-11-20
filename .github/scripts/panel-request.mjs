/**
 * Whether an issue is a clear request for a new panel (it then belongs on the panel request
 * board, where it can be upvoted). Only a clear request matches: a title that asks for a panel
 * for an app, with no sign of a problem in one that exists. Anything unsure stays an issue.
 */

const ASKS =
  /^\s*(\[\s*panel(\s+request)?\s*\]|panel(\s+request)?\s*[:-]|(please\s+)?(add|request(ing)?|new|support|create|make)\s+(a\s+|an\s+)?(full\s+)?panel\s+(for|to)\b|panel\s+request\b|(feature\s+request\s*[:-]\s*)?panel\s+for\b)/i;

const PROBLEM =
  /\b(bug|broken|break|breaks|error|errors|crash\w*|fail\w*|wrong|missing|not\s+(work\w*|load\w*|show\w*)|doesn'?t|does\s+not|can'?t|cannot|won'?t|issue\s+with|fix|regression|blank|empty|stuck)\b/i;

/** @param {string} title @param {string} [body] @param {string[]} [labels] */
export function isPanelRequest(title, body = "", labels = []) {
  if (labels.some((l) => /bug/i.test(l))) return false;
  if (!ASKS.test(title)) return false;
  return !PROBLEM.test(title) && !PROBLEM.test(body.slice(0, 2000));
}
