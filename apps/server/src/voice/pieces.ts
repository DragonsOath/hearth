/** Text in pieces Kokoro speaks well (it reads a few sentences at a time). */
export function pieces(text: string, max = 280): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > max) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Fixes to the phonemes Kokoro is handed. Kokoro learned its words from one phoneme style and the
 * phonemizer writes some differently; these words then sound stretched or odd. Each pair is what
 * the phonemizer writes and what Kokoro learned.
 * - "movies": mˈuːvɪz as mˈuviz, Kokoro's own (misaki) spelling (11-20: the owner picked it by ear).
 * - "movie", "move", "moving": mˈuːv as mˈuv (11-20, the owner: "she says movies weird").
 */
const PHONEME_FIXES: [RegExp, string][] = [
  [/mˈuːvɪz/g, "mˈuviz"],
  [/mˈuːv/g, "mˈuv"],
];

export function fixPhonemes(phonemes: string): string {
  return PHONEME_FIXES.reduce((p, [from, to]) => p.replace(from, to), phonemes);
}
