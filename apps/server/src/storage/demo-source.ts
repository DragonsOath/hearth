import type { FileEntry } from "@dragon-control/core";
import { NotFoundError } from "../store/errors";
import { extensionOf, joinRelative, sortEntries, type FileSource } from "./source";

/**
 * Made-up folder trees for the sample environment, so browsing can be
 * tried without your own systems. Titles are public-domain classics or
 * invented, sizes and dates are deterministic.
 */
interface Node {
  name: string;
  kind: "folder" | "file";
  size?: number;
  mtime: number;
  children?: Node[];
}

const GB = 1e9;
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 8, 1);

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
const pick = (seed: string, min: number, max: number) =>
  min + ((hash(seed) % 10_000) / 10_000) * (max - min);
const file = (name: string, size: number, seed = name): Node => ({
  name,
  kind: "file",
  size: Math.round(size),
  mtime: BASE - Math.round(pick(seed + "t", 1, 900)) * DAY,
});
const folder = (name: string, children: Node[]): Node => ({
  name,
  kind: "folder",
  children,
  mtime: Math.max(BASE - 400 * DAY, ...children.map((c) => c.mtime)),
});

const films = [
  "Metropolis (1927)",
  "Nosferatu (1922)",
  "The General (1926)",
  "Sherlock Jr. (1924)",
  "The Kid (1921)",
  "Modern Times (1936)",
  "City Lights (1931)",
  "It Happened One Night (1934)",
  "His Girl Friday (1940)",
  "Night of the Living Dead (1968)",
  "Charade (1963)",
  "The Cabinet of Dr. Caligari (1920)",
  "Safety Last! (1923)",
  "Battleship Potemkin (1925)",
  "The Gold Rush (1925)",
  "Steamboat Bill, Jr. (1928)",
  "Sunrise (1927)",
  "M (1931)",
  "Frankenstein (1931)",
  "Dracula (1931)",
  "King Kong (1933)",
  "Duck Soup (1933)",
  "The 39 Steps (1935)",
  "Bringing Up Baby (1938)",
  "The Lady Vanishes (1938)",
  "Stagecoach (1939)",
  "Rebecca (1940)",
  "The Philadelphia Story (1940)",
  "Citizen Kane (1941)",
  "Casablanca (1942)",
  "Double Indemnity (1944)",
  "Notorious (1946)",
  "The Third Man (1949)",
  "Sunset Boulevard (1950)",
  "Rashomon (1950)",
  "Roman Holiday (1953)",
  "Rear Window (1954)",
  "Seven Samurai (1954)",
  "Vertigo (1958)",
  "North by Northwest (1959)",
  "Some Like It Hot (1959)",
  "Psycho (1960)",
];

const shows = [
  "The Lighthouse Keepers",
  "Northern Stations",
  "Copper and Salt",
  "The Long Table",
  "Glass Harbor",
  "Field Notes",
  "Midnight Cartographers",
  "The Archivists",
];

const authors: [string, string[]][] = [
  ["Jane Austen", ["Pride and Prejudice", "Emma", "Persuasion"]],
  ["Arthur Conan Doyle", ["A Study in Scarlet", "The Hound of the Baskervilles"]],
  ["Mary Shelley", ["Frankenstein"]],
  ["Herman Melville", ["Moby-Dick"]],
  ["Jules Verne", ["Twenty Thousand Leagues Under the Seas", "Around the World in Eighty Days"]],
  ["Charlotte Bronte", ["Jane Eyre"]],
  ["Mark Twain", ["The Adventures of Tom Sawyer", "Adventures of Huckleberry Finn"]],
];

const months = [
  "01 January",
  "02 February",
  "03 March",
  "04 April",
  "05 May",
  "06 June",
  "07 July",
  "08 August",
  "09 September",
  "10 October",
  "11 November",
  "12 December",
];

function moviesTree(): Node[] {
  return films.map((title) =>
    folder(title, [
      file(`${title}.mkv`, pick(title, 4 * GB, 62 * GB)),
      file(`${title}.en.srt`, pick(title + "s", 40_000, 120_000)),
      ...(hash(title) % 3 === 0 ? [file("poster.jpg", pick(title + "p", 200_000, 900_000))] : []),
    ]),
  );
}

function showsTree(): Node[] {
  return shows.map((show) => {
    const seasons = 1 + (hash(show) % 4);
    return folder(
      show,
      Array.from({ length: seasons }, (_, s) =>
        folder(
          `Season ${s + 1}`,
          Array.from({ length: 8 + (hash(show + s) % 5) }, (_, e) => {
            const name = `${show} - S${String(s + 1).padStart(2, "0")}E${String(e + 1).padStart(2, "0")}.mkv`;
            return file(name, pick(name, 0.9 * GB, 3.8 * GB));
          }),
        ),
      ),
    );
  });
}

function photosTree(): Node[] {
  return [2022, 2023, 2024, 2025, 2026].map((year) =>
    folder(
      String(year),
      months.slice(0, year === 2026 ? 9 : 12).map((m) =>
        folder(
          m,
          Array.from({ length: 6 + (hash(`${year}${m}`) % 30) }, (_, i) => {
            const name = `IMG_${year}${m.slice(0, 2)}${String(i + 1).padStart(4, "0")}.jpg`;
            return file(name, pick(name, 2.1e6, 9.8e6));
          }),
        ),
      ),
    ),
  );
}

function booksTree(): Node[] {
  return authors.map(([author, titles]) =>
    folder(
      author,
      titles.map((t) =>
        folder(t, [
          file(`${t}.m4b`, pick(t, 180e6, 1.4 * GB)),
          file("cover.jpg", pick(t + "c", 150_000, 600_000)),
        ]),
      ),
    ),
  );
}

export const DEMO_TREES: Record<string, () => Node[]> = {
  movies: moviesTree,
  shows: showsTree,
  photos: photosTree,
  books: booksTree,
};

function totals(node: Node): { bytes: number; files: number; folders: number } {
  if (node.kind === "file") return { bytes: node.size ?? 0, files: 1, folders: 0 };
  return (node.children ?? []).reduce(
    (acc, c) => {
      const t = totals(c);
      return {
        bytes: acc.bytes + t.bytes,
        files: acc.files + t.files,
        folders: acc.folders + t.folders + (c.kind === "folder" ? 1 : 0),
      };
    },
    { bytes: 0, files: 0, folders: 0 },
  );
}

export function demoSource(tree: keyof typeof DEMO_TREES, rootPath: string): FileSource {
  const root: Node = folder(rootPath.split("/").pop() ?? rootPath, DEMO_TREES[tree]!());

  const find = (segments: string[]): Node => {
    let node = root;
    for (const s of segments) {
      const next = node.children?.find((c) => c.name === s);
      if (!next) throw new NotFoundError("That item no longer exists.");
      node = next;
    }
    return node;
  };

  return {
    displayPath: (segments) => [rootPath, ...segments].join("/"),

    async list(segments, limit) {
      const node = find(segments);
      if (node.kind !== "folder") throw new NotFoundError("That is a file, not a folder.");
      const entries: FileEntry[] = (node.children ?? []).map((c) => ({
        name: c.name,
        path: joinRelative([...segments, c.name]),
        kind: c.kind,
        sizeBytes: c.kind === "file" ? c.size : totals(c).bytes,
        modifiedAt: new Date(c.mtime).toISOString(),
        itemCount: c.kind === "folder" ? c.children?.length : undefined,
      }));
      sortEntries(entries);
      return { entries: entries.slice(0, limit), total: entries.length };
    },

    async properties(segments) {
      const node = find(segments);
      const t = totals(node);
      return {
        name: node.name,
        kind: node.kind,
        displayPath: [rootPath, ...segments].join("/"),
        extension: node.kind === "file" ? extensionOf(node.name) : undefined,
        sizeBytes: t.bytes,
        files: node.kind === "folder" ? t.files : undefined,
        folders: node.kind === "folder" ? t.folders : undefined,
        complete: true,
        createdAt: new Date(node.mtime - 30 * DAY).toISOString(),
        modifiedAt: new Date(node.mtime).toISOString(),
        accessedAt: new Date(BASE).toISOString(),
        readOnly: false,
      };
    },
  };
}
