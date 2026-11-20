import type { WorkerLinter } from "harper.js";
import { changeable } from "./writing";

/**
 * Enhanced writing help: Harper, an open-source grammar checker that runs as
 * WebAssembly in a background worker in this browser. Nothing typed is sent
 * anywhere for this; the checker is served by Hearth itself and is
 * only downloaded the first time Enhanced is used on a device.
 *
 * Suggestions are offered, never applied by themselves, and never touch what
 * `changeable` protects (code, paths, addresses, commands, your systems' names).
 */

export interface GrammarSuggestion {
  start: number;
  end: number;
  /** The text the suggestion replaces, to check it is still there when applied. */
  original: string;
  message: string;
  kind: string;
  /** Up to three replacements; empty means "remove it". */
  replacements: string[];
}

let linter: Promise<WorkerLinter> | undefined;
let known = new Set<string>();

function load(): Promise<WorkerLinter> {
  linter ??= (async () => {
    const [{ WorkerLinter, Dialect }, { binary }] = await Promise.all([
      import("harper.js"),
      import("harper.js/binary"),
    ]);
    const l = new WorkerLinter({ binary, dialect: Dialect.American });
    await l.setup();
    return l;
  })().catch((error: unknown) => {
    // Let a later attempt try again (for example after the connection comes back).
    linter = undefined;
    throw error;
  });
  return linter;
}

/** Grammar and spelling suggestions for `text`, filtered by the same protections as Basic. */
export async function checkGrammar(
  text: string,
  vocabulary: string[],
): Promise<GrammarSuggestion[]> {
  if (!text.trim()) return [];
  const l = await load();
  // Your systems' names are words, not misspellings.
  const fresh = vocabulary.map((v) => v.toLowerCase()).filter((v) => !known.has(v));
  if (fresh.length) {
    await l.importWords(fresh);
    known = new Set([...known, ...fresh]);
  }
  const lints = await l.lint(text);
  const out: GrammarSuggestion[] = [];
  for (const lint of lints) {
    const span = lint.span();
    const start = span.start;
    const end = span.end;
    if (!changeable(text, start, end, vocabulary)) continue;
    const replacements = lint
      .suggestions()
      .slice(0, 3)
      .map((s) => s.get_replacement_text());
    if (!replacements.length) continue;
    out.push({
      start,
      end,
      original: text.slice(start, end),
      message: lint.message(),
      kind: lint.lint_kind_pretty(),
      replacements,
    });
  }
  return out;
}

/** Applies one replacement if the text it was made for is still in place. */
export function applySuggestion(
  text: string,
  s: GrammarSuggestion,
  replacement: string,
): string | undefined {
  if (text.slice(s.start, s.end) !== s.original) return undefined;
  return text.slice(0, s.start) + replacement + text.slice(s.end);
}
