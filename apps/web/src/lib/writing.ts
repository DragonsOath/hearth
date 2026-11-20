/**
 * Basic writing assistance for the Ember message box, entirely in the
 * browser (nothing typed leaves the device for this).
 *
 * Conservative on purpose: it only re-spells words on a known-typo list,
 * capitalizes sentence starts and a lone "i", and tidies spaces around
 * punctuation. It never touches anything that looks technical: code in
 * backticks, URLs, paths, emails, commands and flags, words joined to digits,
 * dots, or symbols, words with inner capitals, ALL CAPS, and the names of your
 * own systems.
 *
 * Only text before `upTo` (the caret) is considered, so what is being typed
 * right now is left alone; the word touching the caret is fixed only with
 * `includeLast` (after a pause, or when a sentence has just ended).
 */

/** Enhanced adds grammar suggestions from Harper (lib/grammar.ts), also in the browser. */
export type WritingMode = "off" | "basic" | "enhanced";

export interface Correction {
  from: string;
  to: string;
}

export interface CorrectResult {
  text: string;
  /** How many characters the text before the caret grew or shrank by. */
  delta: number;
  changes: Correction[];
}

/** Common English typos (lowercase). Only these words are ever re-spelled. */
const TYPOS: Record<string, string> = {
  teh: "the",
  hte: "the",
  taht: "that",
  thta: "that",
  waht: "what",
  whta: "what",
  wich: "which",
  whcih: "which",
  jsut: "just",
  becuase: "because",
  beacuse: "because",
  becasue: "because",
  recieve: "receive",
  recieved: "received",
  recieving: "receiving",
  seperate: "separate",
  seperately: "separately",
  definately: "definitely",
  definatly: "definitely",
  occured: "occurred",
  occuring: "occurring",
  untill: "until",
  wierd: "weird",
  adress: "address",
  acess: "access",
  accross: "across",
  enviroment: "environment",
  dependancy: "dependency",
  dependancies: "dependencies",
  succesful: "successful",
  sucessful: "successful",
  succesfully: "successfully",
  neccessary: "necessary",
  necesary: "necessary",
  begining: "beginning",
  beleive: "believe",
  calender: "calendar",
  comming: "coming",
  existance: "existence",
  foward: "forward",
  happend: "happened",
  immediatly: "immediately",
  independant: "independent",
  knowlege: "knowledge",
  libary: "library",
  maintainance: "maintenance",
  noticable: "noticeable",
  persistant: "persistent",
  posible: "possible",
  prefered: "preferred",
  probaly: "probably",
  realy: "really",
  recomend: "recommend",
  recomended: "recommended",
  refered: "referred",
  relevent: "relevant",
  remeber: "remember",
  shoud: "should",
  similiar: "similar",
  thier: "their",
  tommorow: "tomorrow",
  tomorow: "tomorrow",
  truely: "truly",
  usualy: "usually",
  alot: "a lot",
  aswell: "as well",
  wether: "whether",
  writting: "writing",
  wroking: "working",
  workign: "working",
  agian: "again",
  allready: "already",
  alredy: "already",
  basicly: "basically",
  buisness: "business",
  completly: "completely",
  enought: "enough",
  finaly: "finally",
  freind: "friend",
  grammer: "grammar",
  interupt: "interrupt",
  isntall: "install",
  intall: "install",
  lenght: "length",
  managment: "management",
  occassionally: "occasionally",
  paralel: "parallel",
  peice: "piece",
  priviledge: "privilege",
  publically: "publicly",
  sence: "sense",
  strenght: "strength",
  suprise: "surprise",
  temperture: "temperature",
  threshhold: "threshold",
  servce: "service",
  sevice: "service",
  contianer: "container",
  conatiner: "container",
  configuation: "configuration",
  configration: "configuration",
  passowrd: "password",
  pasword: "password",
  netwrok: "network",
  newtork: "network",
  certifcate: "certificate",
  certficate: "certificate",
  stoped: "stopped",
  runing: "running",
  restaritng: "restarting",
  downlaod: "download",
  dowload: "download",
  uplaod: "upload",
  udpate: "update",
  upadte: "update",
  probelm: "problem",
  porblem: "problem",
  problme: "problem",
  dont: "don't",
  doesnt: "doesn't",
  didnt: "didn't",
  isnt: "isn't",
  wasnt: "wasn't",
  werent: "weren't",
  havent: "haven't",
  hasnt: "hasn't",
  couldnt: "couldn't",
  shouldnt: "shouldn't",
  wouldnt: "wouldn't",
  arent: "aren't",
  thats: "that's",
  whats: "what's",
  theres: "there's",
  youre: "you're",
  theyre: "they're",
  im: "I'm",
  ive: "I've",
};

/** Commands and tools that often start a line in lower case on purpose. */
const COMMANDS = new Set(
  "docker git ssh scp sudo curl wget systemctl journalctl pnpm npm npx node yarn apt pip python python3 ls cd cat grep tail head less rm mv cp mkdir chmod chown kubectl helm tar gpg rsync ping nslookup dig sqlite3 make bash sh powershell winget brew caddy tailscale".split(
    " ",
  ),
);

/** "e.g. this" does not start a new sentence. */
const ABBREVIATION_END = /\b(e\.g|i\.e|etc|vs|approx|incl)\.$/i;

/** Spans never changed: code, URLs, paths, emails, flags, variables, to-do numbers. */
const PROTECTED = new RegExp(
  [
    "```[\\s\\S]*?(?:```|$)", // fenced code (to the end if unclosed)
    "`[^`\\n]*`?", // inline code
    "\\b[a-z][a-z0-9+.-]*://\\S+", // URLs with a scheme
    "\\bwww\\.\\S+",
    "\\S+@\\S+", // emails, user@host
    "\\S*[\\\\/]\\S*", // anything with a slash: paths, ratios, "and/or"
    "(?<![\\w-])--?[A-Za-z][\\w-]*", // command flags
    "\\$\\{?\\w+\\}?", // variables
    "#\\d+", // to-do numbers
  ].join("|"),
  "g",
);

const JOINER = /[0-9_.@:=]/;

function technical(word: string, vocabulary: Set<string>): boolean {
  return (
    /[a-z][A-Z]/.test(word) || // camelCase / PascalCase inner capital
    (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) || // ALL CAPS
    vocabulary.has(word.toLowerCase())
  );
}

function withCase(original: string, fixed: string): string {
  if (fixed.startsWith("I'")) return fixed;
  return /^[A-Z]/.test(original) ? fixed[0]!.toUpperCase() + fixed.slice(1) : fixed;
}

/**
 * Corrects the finished part of `text` (before `upTo`). `ignore` holds words the
 * owner undid in this message, so they are never changed again.
 */
export function correct(
  text: string,
  opts: {
    upTo?: number;
    includeLast?: boolean;
    vocabulary?: Iterable<string>;
    ignore?: Set<string>;
  } = {},
): CorrectResult {
  const upTo = Math.min(opts.upTo ?? text.length, text.length);
  const vocabulary = new Set([...(opts.vocabulary ?? [])].map((v) => v.toLowerCase()));
  const ignore = opts.ignore ?? new Set<string>();
  const head = text.slice(0, upTo);
  const tail = text.slice(upTo);

  // Mark characters that must not change.
  const locked = new Uint8Array(head.length);
  for (const m of head.matchAll(PROTECTED)) locked.fill(1, m.index, m.index + m[0].length);
  if (!opts.includeLast) {
    const last = /\S+$/.exec(head);
    if (last) locked.fill(1, last.index, head.length);
  }

  const changes: Correction[] = [];
  let out = "";
  let i = 0;
  let sentenceStart = true;
  while (i < head.length) {
    const ch = head[i]!;

    if (locked[i]) {
      let j = i;
      while (j < head.length && locked[j]) j++;
      const run = head.slice(i, j);
      out += run;
      // Technical text never gets a capital, even at a sentence start.
      if (/\S/.test(run)) sentenceStart = false;
      i = j;
      continue;
    }

    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < head.length && !locked[j] && /[A-Za-z'-]/.test(head[j]!)) j++;
      let word = head.slice(i, j);
      // Joined to digits, dots, or symbols on either side (host.name, v2, a_b): technical.
      const glued =
        (j < head.length && JOINER.test(head[j]!) && /[A-Za-z0-9_]/.test(head[j + 1] ?? "")) ||
        (i > 0 && JOINER.test(head[i - 1]!) && /[A-Za-z0-9_]/.test(head[i - 2] ?? ""));
      if (!glued && !technical(word, vocabulary)) {
        const fix = TYPOS[word.toLowerCase()];
        if (fix && !ignore.has(word)) {
          const fixed = withCase(word, fix);
          changes.push({ from: word, to: fixed });
          word = fixed;
        } else if (word === "i" && !ignore.has(word)) {
          changes.push({ from: "i", to: "I" });
          word = "I";
        }
        if (
          sentenceStart &&
          /^[a-z]/.test(word) &&
          !COMMANDS.has(word.toLowerCase()) &&
          !ignore.has(word)
        ) {
          const cap = word[0]!.toUpperCase() + word.slice(1);
          changes.push({ from: word, to: cap });
          word = cap;
        }
      }
      out += word;
      sentenceStart = false;
      i = j;
      continue;
    }

    const prev = head[i - 1] ?? "";
    const next = head[i + 1] ?? "";
    // Two spaces between words: one.
    if (ch === " " && next === " " && /\S/.test(prev) && /\S/.test(head[i + 2] ?? "")) {
      i++;
      continue;
    }
    // "word ," -> "word,"
    if (
      ch === " " &&
      /[,.!?;:]/.test(next) &&
      /[A-Za-z]/.test(prev) &&
      /^(\s|)$/.test(head[i + 2] ?? "")
    ) {
      i++;
      continue;
    }

    out += ch;
    if (/[.!?]/.test(ch) && /\s/.test(next || tail[0] || "x")) {
      sentenceStart = ch !== "." || !ABBREVIATION_END.test(out);
    } else if (ch === "\n") {
      sentenceStart = true;
    }
    i++;
  }

  if (out === head) return { text, delta: 0, changes: [] };
  return { text: out + tail, delta: out.length - head.length, changes };
}

/**
 * Whether the text from `start` to `end` may be suggested for a change: the
 * same protections as `correct`. Nothing inside code, URLs, paths, emails,
 * flags, variables, or to-do numbers, and no word that is technical, joined
 * to digits or symbols, or one of your systems' names.
 */
export function changeable(
  text: string,
  start: number,
  end: number,
  vocabulary: Iterable<string> = [],
): boolean {
  if (start < 0 || end > text.length || start >= end) return false;
  for (const m of text.matchAll(PROTECTED)) {
    if (m.index < end && m.index + m[0].length > start) return false;
  }
  const vocab = new Set([...vocabulary].map((v) => v.toLowerCase()));
  // Every whole word the span touches, widened to its neighbours.
  let a = start;
  let b = end;
  while (a > 0 && /\S/.test(text[a - 1]!)) a--;
  while (b < text.length && /\S/.test(text[b]!)) b++;
  for (const m of text.slice(a, b).matchAll(/\S+/g)) {
    const token = m[0].replace(/^[("'[]+|[)"'\],.!?;:]+$/g, "");
    if (!token) continue;
    if (/[0-9_@=]/.test(token) || /[A-Za-z][.:][A-Za-z0-9]/.test(token)) return false;
    for (const w of token.split(/[^A-Za-z']+/)) {
      if (w && technical(w, vocab)) return false;
    }
    if (COMMANDS.has(token.toLowerCase())) return false;
  }
  return true;
}
