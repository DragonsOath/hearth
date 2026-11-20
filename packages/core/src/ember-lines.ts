import type { AnnounceItem, AnnounceKind, LineTone } from "./media";

/**
 * Ember's one-liner on a "New in your library" card. By default it comes from this written pool,
 * keyed to the kind, genre and decade of what arrived, so no AI is used and nothing leaves the
 * Hearth. (An owner may let Ember write it instead, within a daily cap; what she writes passes
 * checkLine first, and the pool is the fallback.)
 *
 * Rules every line keeps: it never names who asked for something, never mocks the title or the
 * people who like it, and never jokes about health, religion, sexuality, self-help or children's
 * content. Those always get a plain, gentle line. Lines speak as "I", so they fit whatever name
 * the owner gave Ember; the card shows that name beside the line.
 */

/** Per destination: playful lines, gentle ones, or none. */
export type { LineTone } from "./media";

interface PoolLine {
  id: string;
  text: string;
  tone: "playful" | "gentle";
  /** Only for these kinds (any kind when absent). */
  kinds?: AnnounceKind[];
  /** Only when a genre matches. */
  genre?: RegExp;
  /** Only for items from this decade (1980 = the eighties); 1950 means before 1960. */
  decade?: number;
  /** A line for a batch ("6 new albums"), not one item. */
  batch?: true;
}

const VIDEO: AnnounceKind[] = ["movie", "series", "season", "episode"];
const READ: AnnounceKind[] = ["book", "audiobook", "comic"];
const STORY: AnnounceKind[] = [...VIDEO, ...READ, "game"];

export const LINE_POOL: PoolLine[] = [
  // Any kind.
  { id: "any-warm", tone: "playful", text: "Fresh off the shelf and still warm." },
  { id: "any-chair", tone: "playful", text: "Pull up a chair. The fire's going." },
  { id: "any-kept", tone: "playful", text: "Just landed. I kept it warm for you." },
  {
    id: "any-glow",
    tone: "playful",
    text: "New in the library, and I'm already glowing about it.",
  },
  { id: "any-ready", tone: "gentle", text: "Something new is waiting whenever you're ready." },
  { id: "any-added", tone: "gentle", text: "Added to the library, ready when you are." },
  { id: "any-settled", tone: "gentle", text: "A new arrival, settled in and ready." },

  // Movies and shows.
  {
    id: "movie-popcorn",
    tone: "playful",
    kinds: ["movie"],
    text: "Popcorn not included, but strongly recommended.",
  },
  {
    id: "movie-lights",
    tone: "playful",
    kinds: ["movie"],
    text: "Dim the lights. This one just arrived.",
  },
  { id: "movie-night", tone: "gentle", kinds: ["movie"], text: "Ready for your next movie night." },
  {
    id: "series-evenings",
    tone: "playful",
    kinds: ["series"],
    text: "Clear your evenings. A whole new series just moved in.",
  },
  {
    id: "series-one-more",
    tone: "playful",
    kinds: ["series"],
    text: 'Fair warning: "one more episode" starts here.',
  },
  {
    id: "series-start",
    tone: "gentle",
    kinds: ["series"],
    text: "A new series to start whenever suits you.",
  },
  {
    id: "season-continues",
    tone: "playful",
    kinds: ["season"],
    text: "The story continues. No spoilers from me.",
  },
  {
    id: "season-seat",
    tone: "playful",
    kinds: ["season"],
    text: "Back for more. I saved you a seat.",
  },
  { id: "season-chapter", tone: "gentle", kinds: ["season"], text: "The next chapter is here." },
  {
    id: "episode-fresh",
    tone: "playful",
    kinds: ["episode"],
    text: "A fresh episode, still warm from the oven.",
  },
  { id: "episode-ready", tone: "gentle", kinds: ["episode"], text: "A new episode is ready." },

  // Music.
  {
    id: "album-up",
    tone: "playful",
    kinds: ["album"],
    text: "Turn it up. I'll keep the fire crackling in time.",
  },
  {
    id: "album-speakers",
    tone: "playful",
    kinds: ["album"],
    text: "Fresh tracks for the speakers.",
  },
  { id: "album-walked", tone: "playful", kinds: ["album"], text: "New sounds just walked in." },
  { id: "album-play", tone: "gentle", kinds: ["album"], text: "New music, ready to play." },

  // Books, audiobooks, comics.
  {
    id: "audiobook-read",
    tone: "playful",
    kinds: ["audiobook"],
    text: "Someone new to read to you tonight.",
  },
  {
    id: "audiobook-kettle",
    tone: "playful",
    kinds: ["audiobook"],
    text: "Headphones on, kettle on.",
  },
  {
    id: "audiobook-listen",
    tone: "gentle",
    kinds: ["audiobook"],
    text: "A new listen, ready when you are.",
  },
  {
    id: "book-chapter",
    tone: "playful",
    kinds: ["book"],
    text: 'Another one for the "just one more chapter" pile.',
  },
  {
    id: "book-heavier",
    tone: "playful",
    kinds: ["book"],
    text: "The bookshelf just got a little heavier.",
  },
  { id: "book-shelf", tone: "gentle", kinds: ["book"], text: "A new read is on the shelf." },
  {
    id: "comic-panels",
    tone: "playful",
    kinds: ["comic"],
    text: "Fresh panels, hot off the press.",
  },
  { id: "comic-pages", tone: "gentle", kinds: ["comic"], text: "New pages to flip through." },

  // Games and podcasts.
  { id: "game-controllers", tone: "playful", kinds: ["game"], text: "Controllers at the ready." },
  { id: "game-start", tone: "playful", kinds: ["game"], text: "Press start whenever you like." },
  { id: "game-play", tone: "gentle", kinds: ["game"], text: "A new game is ready to play." },
  {
    id: "podcast-commute",
    tone: "playful",
    kinds: ["podcast"],
    text: "A fresh episode for the commute.",
  },
  {
    id: "podcast-listen",
    tone: "gentle",
    kinds: ["podcast"],
    text: "A new episode is ready to listen to.",
  },

  // Story genres (films, shows, books, games).
  {
    id: "horror-light",
    tone: "playful",
    kinds: STORY,
    genre: /horror/i,
    text: "Maybe leave a light on for this one.",
  },
  {
    id: "horror-fire",
    tone: "playful",
    kinds: STORY,
    genre: /horror/i,
    text: "I'll keep the fire bright. You might want it.",
  },
  {
    id: "comedy-warm",
    tone: "playful",
    kinds: STORY,
    genre: /comedy/i,
    text: "A good laugh, freshly delivered.",
  },
  {
    id: "scifi-docked",
    tone: "playful",
    kinds: STORY,
    genre: /sci-?fi|science fiction/i,
    text: "Something from the far side of the galaxy just docked.",
  },
  {
    id: "fantasy-dragons",
    tone: "playful",
    kinds: STORY,
    genre: /fantasy/i,
    text: "Dragons optional, but I'm hopeful.",
  },
  {
    id: "doc-real",
    tone: "playful",
    kinds: STORY,
    genre: /documentary/i,
    text: "Real stories, freshly shelved.",
  },
  {
    id: "mystery-clues",
    tone: "playful",
    kinds: STORY,
    genre: /mystery|thriller|crime|detective/i,
    text: "The clues are waiting. I won't give anything away.",
  },
  {
    id: "action-buckle",
    tone: "playful",
    kinds: STORY,
    genre: /action|adventure/i,
    text: "Buckle up. This one moves.",
  },
  {
    id: "western-rode",
    tone: "playful",
    kinds: STORY,
    genre: /western/i,
    text: "A new stranger just rode into town.",
  },
  {
    id: "romance-cozy",
    tone: "playful",
    kinds: STORY,
    genre: /^romance$/i,
    text: "Something sweet for a cozy night in.",
  },
  {
    id: "history-ready",
    tone: "playful",
    kinds: STORY,
    genre: /history|war/i,
    text: "A trip back in time, ready when you are.",
  },
  {
    id: "animation-drawn",
    tone: "playful",
    kinds: VIDEO,
    genre: /animation|anime/i,
    text: "Drawn with care, delivered warm.",
  },

  // Music genres.
  {
    id: "rock-up",
    tone: "playful",
    kinds: ["album"],
    genre: /rock/i,
    text: "Turn it up. The neighbours will understand.",
  },
  {
    id: "metal-stoke",
    tone: "playful",
    kinds: ["album"],
    genre: /metal/i,
    text: "Loud enough to stoke the fire.",
  },
  {
    id: "jazz-smooth",
    tone: "playful",
    kinds: ["album"],
    genre: /jazz|blues|soul/i,
    text: "Something smooth for a slow evening.",
  },
  {
    id: "classical-timeless",
    tone: "playful",
    kinds: ["album"],
    genre: /classical|orchestra|opera/i,
    text: "Something timeless for the quiet hours.",
  },
  {
    id: "hiphop-verses",
    tone: "playful",
    kinds: ["album"],
    genre: /hip-?hop|rap/i,
    text: "Fresh verses just dropped.",
  },
  {
    id: "electronic-bpm",
    tone: "playful",
    kinds: ["album"],
    genre: /electronic|house|techno|dance|edm/i,
    text: "Beats per minute: plenty.",
  },
  {
    id: "country-boots",
    tone: "playful",
    kinds: ["album"],
    genre: /country|americana/i,
    text: "Pull on your boots. New tunes in town.",
  },
  {
    id: "folk-close",
    tone: "playful",
    kinds: ["album"],
    genre: /folk|acoustic/i,
    text: "Pull up close to the fire for this one.",
  },
  {
    id: "pop-stuck",
    tone: "playful",
    kinds: ["album"],
    genre: /\bpop\b/i,
    text: "Catchy, fresh, and already stuck in my head.",
  },

  // Game genres.
  {
    id: "rpg-party",
    tone: "playful",
    kinds: ["game"],
    genre: /rpg|role-?playing/i,
    text: "Your party is assembled. Adventure awaits.",
  },
  {
    id: "puzzle-sharp",
    tone: "playful",
    kinds: ["game"],
    genre: /puzzle/i,
    text: "A new puzzle for a sharp mind.",
  },
  {
    id: "racing-engines",
    tone: "playful",
    kinds: ["game"],
    genre: /racing|driving/i,
    text: "Engines warm. Mine always are.",
  },
  {
    id: "platform-jump",
    tone: "playful",
    kinds: ["game"],
    genre: /platform/i,
    text: "Jump right in.",
  },

  // Decades.
  { id: "decade-old", tone: "playful", decade: 1950, text: "A true classic, freshly dusted off." },
  { id: "decade-60s", tone: "playful", decade: 1960, text: "Groovy. A classic from the sixties." },
  { id: "decade-70s", tone: "playful", decade: 1970, text: "Straight out of the seventies." },
  {
    id: "decade-80s",
    tone: "playful",
    decade: 1980,
    text: "Totally rad. Straight from the eighties.",
  },
  {
    id: "decade-90s",
    tone: "playful",
    decade: 1990,
    text: "Rewind time: a pick from the nineties.",
  },
  {
    id: "decade-00s",
    tone: "playful",
    decade: 2000,
    text: "Some Y2K-era goodness, freshly added.",
  },

  // Batches ("6 new albums").
  {
    id: "batch-stack",
    tone: "playful",
    batch: true,
    text: "A whole stack just arrived. Pick a favourite.",
  },
  { id: "batch-busy", tone: "playful", batch: true, text: "The shelves are busy tonight." },
  {
    id: "batch-album",
    tone: "playful",
    batch: true,
    kinds: ["album"],
    text: "A fresh crate of records. Dig in.",
  },
  {
    id: "batch-comic",
    tone: "playful",
    batch: true,
    kinds: ["comic"],
    text: "A whole run of fresh panels.",
  },
  {
    id: "batch-ready",
    tone: "gentle",
    batch: true,
    text: "Several new arrivals, ready when you are.",
  },
];

/**
 * Subjects the lines never joke about: health, religion, sexuality, self-help and children's
 * content. A match gets a plain, gentle line, whatever the destination's tone.
 */
const SENSITIVE =
  /\b(health|medical|medicine|wellness|fitness|diet|nutrition|mental|religio\w*|spiritual\w*|christian\w*|bible|faith|church|islam\w*|muslim|jewish|judaism|hindu\w*|buddhis\w*|lgbt\w*|queer|gay|lesbian|transgender|sexual\w*|sexuality|erotic\w*|self[- ]?help|personal development|self[- ]?improvement|parenting|child|children|children's|kids|juvenile|young readers|picture books?|family|preschool|nursery|baby|babies|grief|suicide|addiction|recovery)\b/i;

/** True when an item touches a subject that only ever gets a plain line. */
export function isSensitive(item: Pick<AnnounceItem, "title" | "genres">): boolean {
  return SENSITIVE.test([item.title, ...(item.genres ?? [])].join(" | "));
}

/** 1950 for anything before 1960, else the decade's first year. */
function decadeOf(year?: number): number | undefined {
  if (!year || year < 1900) return undefined;
  return year < 1960 ? 1950 : Math.floor(year / 10) * 10;
}

export interface PickedLine {
  id: string;
  text: string;
}

/**
 * Ember's line for one item, or for a batch of one kind. The most fitting lines win (a genre or
 * decade match over a kind match over any line), and the line used last time is skipped, so the
 * same line never runs twice in a row. `rand` picks among equals (tests pass a fixed one).
 */
export function pickLine(
  subject: { item: AnnounceItem } | { batch: AnnounceKind; items: AnnounceItem[] },
  tone: LineTone,
  opts: { last?: string; rand?: () => number } = {},
): PickedLine | undefined {
  if (tone === "off") return undefined;
  const rand = opts.rand ?? Math.random;
  const batch = "batch" in subject;
  const kind = batch ? subject.batch : subject.item.kind;
  const items = batch ? subject.items : [subject.item];
  const plain = items.some(isSensitive);
  const want = plain ? "gentle" : tone;
  const genres = batch ? [] : (subject.item.genres ?? []);
  const decade = batch ? undefined : decadeOf(subject.item.year);
  const scored = LINE_POOL.flatMap((l) => {
    if (l.tone !== want || Boolean(l.batch) !== batch) return [];
    if (l.kinds && !l.kinds.includes(kind)) return [];
    // Sensitive items: only the plain lines for any kind or this kind.
    if (plain && (l.genre || l.decade)) return [];
    let score = l.kinds ? 1 : 0;
    if (l.genre) {
      if (!genres.some((g) => l.genre!.test(g))) return [];
      score += 2;
    }
    if (l.decade !== undefined) {
      if (l.decade !== decade) return [];
      score += 2;
    }
    return [{ l, score }];
  }).filter((c) => c.l.id !== opts.last);
  if (!scored.length) return undefined;
  // Mostly the best fit, sometimes a more general line, so a genre doesn't get the same few.
  const best = Math.max(...scored.map((c) => c.score));
  const top = scored.filter((c) => c.score === best);
  const pool = best > 0 && rand() < 0.25 ? scored : top;
  const pick = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]!.l;
  return { id: pick.id, text: pick.text };
}

/** Words that mock or sneer: an AI-written line with one of these is not used. */
const MOCKING =
  /\b(stupid|dumb|lame|cringe\w*|trash|garbage|terrible|awful|worst|guilty pleasure|ugh|lol|lmao|boring|overrated|basic|pathetic|embarrassing|sad)\b/i;

/**
 * Checks a line Ember wrote before it goes on a card: one short sentence, no links or mentions,
 * nothing mocking, nothing about sensitive subjects, and no names of people who asked for
 * things (`avoid`). Returns the cleaned line, or undefined (the pool is used instead).
 */
export function checkLine(text: string, avoid: string[] = []): string | undefined {
  let t = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    // House style: no long dashes.
    .replace(/\s*[—–]\s*/g, ", ")
    .trim();
  if (!t || t.length > 140) return undefined;
  if (/https?:|www\.|@|#|<|>|\n/.test(t)) return undefined;
  if (MOCKING.test(t) || SENSITIVE.test(t)) return undefined;
  const lower = t.toLowerCase();
  if (avoid.some((n) => n.trim().length > 1 && lower.includes(n.trim().toLowerCase())))
    return undefined;
  if (!/[.!?]$/.test(t)) t += ".";
  return t;
}
