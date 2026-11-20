import { existsSync } from "node:fs";
import PDFDocument from "pdfkit";
import { isBookShelf } from "@dragon-control/core";
import type { CatalogItem, ShelfKind } from "./scan";

/**
 * The collection PDF: a dark, gold-accented library inventory. A cover with totals and a
 * contents page whose every shelf and year is a link, then each shelf on its own pages, grouped
 * by year (newest first, "Year unknown" last), titles in columns with their sizes. Made with
 * pdfkit, so no browser is needed on any computer.
 *
 * The PDF standard fonts cover English and Western European letters. Titles in other scripts
 * (Japanese, Cyrillic, Greek, ...) use a font the computer already has when one is found;
 * otherwise those letters print as "?".
 */

export interface CatalogShelf {
  name: string;
  kind: ShelfKind;
  items: CatalogItem[];
}

export interface CatalogDocument {
  title: string;
  /** "October 25, 2026". */
  made: string;
  shelves: CatalogShelf[];
  /** Folders a shelf could not finish (too big or too slow), said in the footer. */
  partial?: string[];
}

const C = {
  bg: "#12151c",
  panel: "#1a1f2b",
  line: "#262c3a",
  ink: "#ede8dc",
  body: "#d7d2c4",
  muted: "#8b93a8",
  faint: "#6b7180",
  gold: "#d9a441",
};
const SERIF = "Times-Roman";
const SANS = "Helvetica";
const MONO = "Courier";
const PAGE = { w: 612, h: 792, x: 43, top: 40, bottom: 40 };
const WIDTH = PAGE.w - PAGE.x * 2;

/** Fonts other scripts can fall back to, if this computer has one. */
const UNICODE_FONTS = [
  "C:\\Windows\\Fonts\\segoeui.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/google-noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
];

/** Windows-1252: what the PDF standard fonts can print. */
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const printable = (s: string) =>
  [...s].every((ch) => {
    const c = ch.codePointAt(0)!;
    return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || CP1252_EXTRA.includes(ch);
  });

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)}G` : `${Math.max(1, Math.round(gb * 1024))}M`;
}

export function byYear(items: CatalogItem[]): { year: string; items: CatalogItem[] }[] {
  const groups = new Map<string, CatalogItem[]>();
  for (const it of items) {
    const key = it.y ? String(it.y) : "Year unknown";
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return [...groups]
    .sort(([a], [b]) =>
      a === "Year unknown" ? 1 : b === "Year unknown" ? -1 : Number(b) - Number(a),
    )
    .map(([year, list]) => ({
      year,
      items: list.sort((a, b) =>
        a.t.localeCompare(b.t, undefined, { numeric: true, sensitivity: "base" }),
      ),
    }));
}

const sortKey = (s: string) => s.replace(/^(?:the|a|an)\s+/i, "");
const nat = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * Books by author, A to Z, the way the folders name them ("Frank Herbert" is under F). Books
 * with no author go by title. Within a letter: author, then title. Anything else is under "#".
 */
export function byAuthor(items: CatalogItem[]): { year: string; items: CatalogItem[] }[] {
  const groups = new Map<string, CatalogItem[]>();
  for (const it of items) {
    const ch = sortKey(it.a ?? it.t)
      .charAt(0)
      .normalize("NFD")
      .charAt(0)
      .toUpperCase();
    const key = /[A-Z]/.test(ch) ? ch : "#";
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return [...groups]
    .sort(([a], [b]) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)))
    .map(([year, list]) => ({
      year,
      items: list.sort(
        (a, b) => nat(sortKey(a.a ?? a.t), sortKey(b.a ?? b.t)) || nat(sortKey(a.t), sortKey(b.t)),
      ),
    }));
}

const groupsOf = (shelf: CatalogShelf) =>
  isBookShelf(shelf.kind) ? byAuthor(shelf.items) : byYear(shelf.items);

/** How a title reads in the list: books carry their author. */
const listed = (it: CatalogItem) => (it.a ? `${it.t} · ${it.a}` : it.t);

export function renderCatalogPdf(
  doc: CatalogDocument,
  opts: { unicodeFont?: string | null } = {},
): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "LETTER",
    margins: { top: PAGE.top, bottom: 0, left: PAGE.x, right: PAGE.x },
    autoFirstPage: false,
    info: { Title: doc.title, Creator: "Hearth", Producer: "Hearth" },
  });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    pdf.on("end", () => resolve(Buffer.concat(chunks))),
  );

  const fallbackPath =
    opts.unicodeFont === null
      ? undefined
      : (opts.unicodeFont ?? UNICODE_FONTS.find((f) => existsSync(f)));
  let unicode = false;
  if (fallbackPath) {
    try {
      pdf.registerFont("Unicode", fallbackPath);
      unicode = true;
    } catch {
      unicode = false;
    }
  }
  /** The font to print a title in, and the text (unprintable letters as "?" when no font). */
  const safe = (s: string, font: string): [string, string] =>
    printable(s)
      ? [font, s]
      : unicode
        ? ["Unicode", s]
        : [font, s.replace(/[^\x20-\x7e\xa0-\xff]/g, "?")];

  const newPage = () => {
    pdf.addPage();
    pdf.rect(0, 0, PAGE.w, PAGE.h).fill(C.bg);
    pdf.y = PAGE.top;
  };
  const room = () => PAGE.h - PAGE.bottom - pdf.y;

  const fit = (text: string, font: string, size: number, width: number) => {
    pdf.font(font).fontSize(size);
    if (pdf.widthOfString(text) <= width) return text;
    let s = text;
    while (s.length > 1 && pdf.widthOfString(`${s}…`) > width) s = s.slice(0, -1);
    return `${s.trimEnd()}…`;
  };

  const all = doc.shelves.flatMap((s) => s.items);
  const count = (kind: ShelfKind) =>
    doc.shelves.filter((s) => s.kind === kind).reduce((n, s) => n + s.items.length, 0);
  const tb = all.reduce((n, i) => n + i.s, 0) / 1024 ** 4;
  const hasBooks = doc.shelves.some((s) => isBookShelf(s.kind) && s.items.length);
  const hasVideo = doc.shelves.some((s) => !isBookShelf(s.kind) && s.items.length);

  // ---- Cover and contents
  newPage();
  pdf.addNamedDestination("contents");
  // Bookmarks (the side panel in most PDF viewers): Contents, then each folder and its years.
  pdf.outline.addItem("Contents");
  const [titleFont, titleText] = safe(doc.title.toUpperCase(), SERIF);
  pdf.font(titleFont).fontSize(27).fillColor(C.ink).text(titleText, PAGE.x, pdf.y, {
    width: WIDTH,
    characterSpacing: 1,
  });
  pdf
    .moveDown(0.2)
    .font(SANS)
    .fontSize(11)
    .fillColor(C.muted)
    .text(
      `Complete library inventory, organized by ${
        hasBooks ? (hasVideo ? "year, and books by author" : "author") : "year"
      }. Made ${doc.made}.`,
      PAGE.x,
      pdf.y,
      { width: WIDTH },
    );
  pdf.moveDown(1);

  // Movies and shows always (an empty count still says something); books when there are any.
  const kinds: [ShelfKind, string][] = [
    ["movies", "MOVIES"],
    ["shows", "SHOWS"],
    ["audiobooks", "AUDIOBOOKS"],
    ["ebooks", "EBOOKS"],
  ];
  const stats: [string, string][] = [
    [all.length.toLocaleString("en-US"), "TITLES TOTAL"],
    ...kinds
      .filter(([k]) => !isBookShelf(k) || count(k))
      .map(([k, name]): [string, string] => [count(k).toLocaleString("en-US"), name]),
    [tb >= 10 ? tb.toFixed(1) : tb.toFixed(2), "TERABYTES"],
  ];
  const boxY = pdf.y;
  const boxW = (WIDTH - (stats.length - 1)) / stats.length;
  stats.forEach(([num, label], i) => {
    const x = PAGE.x + i * (boxW + 1);
    pdf.rect(x, boxY, boxW, 50).fill(C.panel);
    pdf
      .font(MONO)
      .fontSize(20)
      .fillColor(C.gold)
      .text(num, x + 12, boxY + 9, { width: boxW - 20, lineBreak: false });
    pdf
      .font(SANS)
      .fontSize(7.5)
      .fillColor(C.muted)
      .text(label, x + 12, boxY + 35, {
        width: boxW - 20,
        characterSpacing: 0.5,
        lineBreak: false,
      });
  });
  pdf.y = boxY + 50 + 24;

  pdf
    .font(SERIF)
    .fontSize(14)
    .fillColor(C.ink)
    .text("CONTENTS", PAGE.x, pdf.y, { characterSpacing: 1.1 });
  pdf
    .moveTo(PAGE.x, pdf.y + 2)
    .lineTo(PAGE.x + WIDTH, pdf.y + 2)
    .lineWidth(1.5)
    .stroke(C.gold);
  pdf.y += 14;

  for (const shelf of doc.shelves) {
    if (!shelf.items.length) continue;
    const id = `shelf-${slug(shelf.name) || "x"}`;
    const groups = groupsOf(shelf);
    if (room() < 60) newPage();
    const y = pdf.y;
    const [f, name] = safe(shelf.name, SERIF);
    pdf
      .font(f)
      .fontSize(13)
      .fillColor(C.gold)
      .text(name, PAGE.x, y, { goTo: id, lineBreak: false });
    const nameW = pdf.widthOfString(name);
    pdf
      .font(MONO)
      .fontSize(9)
      .fillColor(C.faint)
      .text(`${shelf.items.length.toLocaleString("en-US")} titles`, PAGE.x + nameW + 8, y + 3, {
        lineBreak: false,
      });
    pdf.y = y + 20;
    // Year pills, wrapping; each links to its year. (pdfkit moves its cursor after every text
    // call, so the row's y is kept here.)
    let x = PAGE.x;
    let rowY = pdf.y;
    pdf.font(MONO).fontSize(8);
    for (const g of groups) {
      const label = `${g.year} ${g.items.length}`;
      const w = pdf.widthOfString(label) + 12;
      if (x + w > PAGE.x + WIDTH) {
        x = PAGE.x;
        rowY += 18;
        if (PAGE.h - PAGE.bottom - rowY < 20) {
          newPage();
          rowY = pdf.y;
        }
      }
      pdf.roundedRect(x, rowY, w, 14, 2).fillAndStroke(C.panel, C.line);
      pdf.fillColor(C.body).text(g.year, x + 6, rowY + 3.5, { lineBreak: false });
      const yw = pdf.widthOfString(`${g.year} `);
      pdf
        .fillColor(C.faint)
        .text(String(g.items.length), x + 6 + yw, rowY + 3.5, { lineBreak: false });
      pdf.goTo(x, rowY, w, 14, `${id}-${slug(g.year)}`);
      x += w + 5;
    }
    pdf.y = rowY + 30;
  }

  // ---- Shelves
  const back = "BACK TO CONTENTS";
  for (const shelf of doc.shelves) {
    if (!shelf.items.length) continue;
    const id = `shelf-${slug(shelf.name) || "x"}`;
    const cols = shelf.kind === "movies" ? 3 : 2;
    const gap = 20;
    const colW = (WIDTH - gap * (cols - 1)) / cols;
    const LINE = 12.5;

    newPage();
    pdf.addNamedDestination(id);
    const mark = pdf.outline.addItem(
      `${shelf.name} (${shelf.items.length.toLocaleString("en-US")})`,
    );
    const [hf, heading] = safe(shelf.name.toUpperCase(), SERIF);
    // Later pages of this folder: its name and a way back to the contents at the top, so a
    // big library never needs scrolling back to find them.
    const nextPage = () => {
      newPage();
      const y = pdf.y;
      pdf
        .font(hf)
        .fontSize(9)
        .fillColor(C.gold)
        .text(heading, PAGE.x, y, { characterSpacing: 0.8, lineBreak: false, goTo: id });
      pdf.font(SANS).fontSize(8).fillColor(C.gold);
      const w = pdf.widthOfString(back);
      pdf.text(back, PAGE.x + WIDTH - w, y + 1, { lineBreak: false, goTo: "contents" });
      pdf
        .moveTo(PAGE.x, y + 14)
        .lineTo(PAGE.x + WIDTH, y + 14)
        .lineWidth(0.5)
        .stroke(C.line);
      pdf.y = y + 24;
    };
    pdf
      .font(hf)
      .fontSize(18)
      .fillColor(C.gold)
      .text(heading, PAGE.x, pdf.y, { characterSpacing: 0.9 });
    pdf
      .moveTo(PAGE.x, pdf.y + 1)
      .lineTo(PAGE.x + WIDTH, pdf.y + 1)
      .lineWidth(2)
      .stroke(C.gold);
    pdf.y += 8;
    const countY = pdf.y;
    pdf
      .font(SANS)
      .fontSize(9.5)
      .fillColor(C.muted)
      .text(`${shelf.items.length.toLocaleString("en-US")} titles`, PAGE.x, countY, {
        lineBreak: false,
      });
    pdf.font(SANS).fontSize(8).fillColor(C.gold);
    const bw = pdf.widthOfString(back);
    pdf.text(back, PAGE.x + WIDTH - bw, countY + 1, { lineBreak: false, goTo: "contents" });
    pdf.y = countY + 22;

    for (const g of groupsOf(shelf)) {
      let rest = g.items;
      let first = true;
      while (rest.length) {
        if (room() < 26 + LINE * 2) nextPage();
        // Year bar.
        const barY = pdf.y;
        pdf.rect(PAGE.x, barY, WIDTH, 18).fill(C.panel);
        pdf.rect(PAGE.x, barY, 3, 18).fill(C.gold);
        if (first) {
          pdf.addNamedDestination(`${id}-${slug(g.year)}`);
          mark.addItem(`${g.year} (${g.items.length})`);
        }
        pdf
          .font(MONO)
          .fontSize(12)
          .fillColor(C.ink)
          .text(g.year, PAGE.x + 9, barY + 3.5, { lineBreak: false });
        const yw = pdf.widthOfString(`${g.year} `);
        pdf
          .fontSize(10)
          .fillColor(C.faint)
          .text(`(${g.items.length}${first ? "" : ", continued"})`, PAGE.x + 9 + yw, barY + 5, {
            lineBreak: false,
          });
        pdf.y = barY + 24;

        // As many rows as fit on this page, filled column by column like a printed index.
        const rowsFit = Math.max(1, Math.floor((room() - 4) / LINE));
        const take = Math.min(rest.length, rowsFit * cols);
        const chunk = rest.slice(0, take);
        rest = rest.slice(take);
        const rows = Math.ceil(chunk.length / cols);
        const top = pdf.y;
        chunk.forEach((it, i) => {
          const col = Math.floor(i / rows);
          const row = i % rows;
          const x = PAGE.x + col * (colW + gap);
          const y = top + row * LINE;
          const size = formatSize(it.s);
          pdf.font(MONO).fontSize(7.5);
          const sw = pdf.widthOfString(size);
          const [tf, raw] = safe(listed(it), SANS);
          const text = fit(raw, tf, 9, colW - sw - 6);
          pdf.fillColor(C.body).text(text, x, y, { lineBreak: false });
          const tw = pdf.widthOfString(text);
          pdf
            .font(MONO)
            .fontSize(7.5)
            .fillColor(C.faint)
            .text(size, x + tw + 4, y + 1.2, { lineBreak: false });
        });
        pdf.y = top + rows * LINE + 8;
        first = false;
      }
    }
  }

  // ---- Footer
  if (room() < 60) newPage();
  pdf.y += 10;
  pdf
    .moveTo(PAGE.x, pdf.y)
    .lineTo(PAGE.x + WIDTH, pdf.y)
    .lineWidth(0.5)
    .stroke(C.line);
  pdf.y += 8;
  const shelvesText = doc.shelves.map((s) => s.name).join(", ");
  pdf
    .font(SANS)
    .fontSize(8)
    .fillColor(C.faint)
    .text(
      `Made by Hearth from what is on disk in ${shelvesText}. Make a new one any time from Storage & Files, Collection PDF.` +
        (doc.partial?.length
          ? ` Not finished (too large or too slow to read in time): ${doc.partial.join(", ")}.`
          : "") +
        (hasVideo
          ? ' Titles with no year in their folder name, and that Sonarr does not know, are under "Year unknown".'
          : "") +
        (hasBooks ? " Books are listed by author, taken from the folder each book is in." : ""),
      PAGE.x,
      pdf.y,
      { width: WIDTH, lineGap: 2 },
    );

  pdf.end();
  return done;
}
