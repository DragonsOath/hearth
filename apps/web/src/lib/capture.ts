/**
 * Captures part of Hearth's own page as an image (feature request 19), with no
 * screen-sharing permission: the element is copied with its computed styles, fonts, and images,
 * drawn through an SVG into a canvas, and cropped. Other apps, other tabs, and the browser's own
 * window can never appear in it.
 *
 * What is on screen is what you get (19.5): scrolled areas keep their scroll position and pinned
 * (sticky) parts stay where they are. Sensitive elements (password fields, anything marked
 * data-sensitive) are blanked before drawing and counted (19.9).
 */

/** Elements never drawn into a capture: shown as a blank "hidden" block instead. */
export const SENSITIVE =
  '[data-sensitive], input[type="password"], [autocomplete~="current-password"], [autocomplete~="new-password"], [autocomplete="one-time-code"]';

/** Elements left out entirely (the capture controls themselves). */
const SKIP = "[data-capture-skip]";

export interface CaptureResult {
  blob: Blob;
  width: number;
  height: number;
  /** How many sensitive elements were blanked. */
  redacted: number;
  /** Names of metrics visible in the capture (elements marked data-metric-name). */
  metrics: string[];
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ---------- Fonts: embedded so the capture uses the same typefaces ---------- */

let fontCss: Promise<string> | undefined;

async function toDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/** @font-face rules for the fonts actually loaded on this page, with the files inlined. */
function embeddedFonts(): Promise<string> {
  fontCss ??= (async () => {
    const loaded = new Set<string>();
    document.fonts.forEach((f) => {
      if (f.status === "loaded")
        loaded.add(`${f.family.replace(/["']/g, "")}|${f.weight}|${f.style}|${f.unicodeRange}`);
    });
    const rules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let list: CSSRuleList;
      try {
        list = sheet.cssRules;
      } catch {
        continue; // another origin's sheet: not readable, and not ours
      }
      for (const rule of Array.from(list)) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const st = rule.style;
        const key = `${st.getPropertyValue("font-family").replace(/["']/g, "").trim()}|${st.getPropertyValue("font-weight").trim() || "400"}|${st.getPropertyValue("font-style").trim() || "normal"}|${st.getPropertyValue("unicode-range").trim() || "U+0-10FFFF"}`;
        if (!loaded.has(key)) continue;
        let css = rule.cssText;
        const urls = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]!);
        for (const u of urls) {
          const abs = new URL(u, sheet.href ?? location.href).href;
          if (new URL(abs).origin !== location.origin) continue;
          const data = await toDataUrl(abs);
          if (data) css = css.split(u).join(data);
        }
        rules.push(css);
      }
    }
    return rules.join("\n");
  })();
  return fontCss;
}

/* ---------- Copying the element as it looks ---------- */

const PSEUDO = ["::before", "::after"] as const;

function copyStyle(from: Element, to: HTMLElement | SVGElement) {
  const cs = getComputedStyle(from);
  let text = "";
  for (let i = 0; i < cs.length; i++) {
    const p = cs.item(i);
    text += `${p}:${cs.getPropertyValue(p)};`;
  }
  to.setAttribute("style", text);
}

interface CloneState {
  rules: string[];
  redacted: number;
  n: number;
}

/**
 * CSS pictures (panel artwork, frames, masks) are fetched and written in as data: an image drawn
 * through SVG can't load anything itself, so without this they came out blank (11-07).
 */
const IMAGE_PROPS = [
  "background-image",
  "border-image-source",
  "mask-image",
  "-webkit-mask-image",
  "list-style-image",
] as const;
const inlined = new Map<string, Promise<string | undefined>>();
async function inlineUrls(value: string): Promise<string> {
  const urls = [...value.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]!);
  let out = value;
  for (const u of urls) {
    if (u.startsWith("data:")) continue;
    let abs: string;
    try {
      abs = new URL(u, location.href).href;
    } catch {
      continue;
    }
    if (new URL(abs).origin !== location.origin) continue;
    if (!inlined.has(abs)) inlined.set(abs, toDataUrl(abs));
    const data = await inlined.get(abs)!;
    if (data) out = out.split(u).join(data);
  }
  return out;
}
async function inlineImages(cs: CSSStyleDeclaration, to: HTMLElement | SVGElement) {
  for (const prop of IMAGE_PROPS) {
    const v = cs.getPropertyValue(prop);
    if (v && v.includes("url(")) to.style.setProperty(prop, await inlineUrls(v));
  }
}

/**
 * A border-image frame (the panels' painted frames) drawn as a picture: the browser can't draw
 * border-image inside an SVG image, so it came out as pale bands and a dark block (11-07).
 * The nine slices are drawn onto a canvas the element's size and used as its background.
 */
const frames = new Map<string, Promise<string | undefined>>();
async function frameAsBackground(
  el: Element,
  cs: CSSStyleDeclaration,
  to: HTMLElement | SVGElement,
): Promise<void> {
  const src = cs.getPropertyValue("border-image-source");
  if (!src || src === "none" || !src.includes("url(")) return;
  const url = /url\(["']?([^"')]+)["']?\)/.exec(src)?.[1];
  if (!url) return;
  const rect = el.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w < 2 || h < 2) return;
  const sliceRaw = cs.getPropertyValue("border-image-slice");
  const fill = /\bfill\b/.test(sliceRaw);
  const nums = sliceRaw
    .replace("fill", "")
    .trim()
    .split(/\s+/)
    .map((x) => parseFloat(x))
    .filter((x) => Number.isFinite(x));
  const sl = [
    nums[0] ?? 0,
    nums[1] ?? nums[0] ?? 0,
    nums[2] ?? nums[0] ?? 0,
    nums[3] ?? nums[1] ?? nums[0] ?? 0,
  ];
  const bw = [
    parseFloat(cs.borderTopWidth) || 0,
    parseFloat(cs.borderRightWidth) || 0,
    parseFloat(cs.borderBottomWidth) || 0,
    parseFloat(cs.borderLeftWidth) || 0,
  ];
  const key = `${url}|${w}x${h}|${sl.join(",")}|${bw.join(",")}|${fill}`;
  if (!frames.has(key))
    frames.set(
      key,
      (async () => {
        const data = url.startsWith("data:") ? url : await inlineUrls(`url(${url})`);
        const d = /url\(([^)]+)\)/.exec(data)?.[1] ?? data;
        try {
          const img = await loadImage(d.replace(/^["']|["']$/g, ""));
          const c = document.createElement("canvas");
          const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
          c.width = Math.round(w * scale);
          c.height = Math.round(h * scale);
          const ctx = c.getContext("2d")!;
          ctx.scale(scale, scale);
          const [st, sr, sb, sL] = sl as [number, number, number, number];
          const [t, r, b, l] = bw as [number, number, number, number];
          const iw = img.naturalWidth;
          const ih = img.naturalHeight;
          const part = (
            sx: number,
            sy: number,
            sw: number,
            sh: number,
            dx: number,
            dy: number,
            dw: number,
            dh: number,
          ) => {
            if (sw > 0 && sh > 0 && dw > 0 && dh > 0)
              ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
          };
          const mw = iw - sL - sr;
          const mh = ih - st - sb;
          // Corners, edges, then the middle (when the slice says fill).
          part(0, 0, sL, st, 0, 0, l, t);
          part(iw - sr, 0, sr, st, w - r, 0, r, t);
          part(0, ih - sb, sL, sb, 0, h - b, l, b);
          part(iw - sr, ih - sb, sr, sb, w - r, h - b, r, b);
          part(sL, 0, mw, st, l, 0, w - l - r, t);
          part(sL, ih - sb, mw, sb, l, h - b, w - l - r, b);
          part(0, st, sL, mh, 0, t, l, h - t - b);
          part(iw - sr, st, sr, mh, w - r, t, r, h - t - b);
          if (fill) part(sL, st, mw, mh, l, t, w - l - r, h - t - b);
          return c.toDataURL("image/png");
        } catch {
          return undefined;
        }
      })(),
    );
  const png = await frames.get(key)!;
  to.style.setProperty("border-image", "none");
  to.style.setProperty("border-color", "transparent");
  to.style.setProperty("border-style", "none");
  // The frame's room is kept as padding, so what is inside stays where it was.
  to.style.setProperty("padding-top", `${(parseFloat(cs.paddingTop) || 0) + bw[0]!}px`);
  to.style.setProperty("padding-right", `${(parseFloat(cs.paddingRight) || 0) + bw[1]!}px`);
  to.style.setProperty("padding-bottom", `${(parseFloat(cs.paddingBottom) || 0) + bw[2]!}px`);
  to.style.setProperty("padding-left", `${(parseFloat(cs.paddingLeft) || 0) + bw[3]!}px`);
  if (png) {
    to.style.setProperty("background-image", `url(${png})`);
    to.style.setProperty("background-size", "100% 100%");
    to.style.setProperty("background-repeat", "no-repeat");
    to.style.setProperty("background-origin", "border-box");
  }
}

/** Gradient-filled text (background-clip: text) can't be drawn either: it gets a solid colour. */
function solidText(cs: CSSStyleDeclaration, to: HTMLElement | SVGElement) {
  const clip =
    cs.getPropertyValue("-webkit-background-clip") || cs.getPropertyValue("background-clip");
  if (clip !== "text") return;
  to.style.setProperty("background-image", "none");
  to.style.setProperty("-webkit-background-clip", "border-box");
  to.style.setProperty("background-clip", "border-box");
  const color = cs.color;
  const clear = !color || color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color);
  to.style.setProperty("-webkit-text-fill-color", clear ? "#f4e9dc" : color);
  if (clear) to.style.setProperty("color", "#f4e9dc");
}

/** The colour actually behind an element: its own, or the nearest ancestor's that isn't clear. */
function backdropOf(el: Element): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    if (c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c)) return c;
  }
  return "#0b0a09";
}

/**
 * A deep copy of `node` with every style written inline, pseudo-elements kept, form values kept,
 * canvases and images inlined, sensitive elements blanked, scroll positions and sticky
 * positions reproduced.
 */
async function cloneNode(node: Node, st: CloneState): Promise<Node | undefined> {
  if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
  if (!(node instanceof Element)) return undefined;
  if (node.matches(SKIP)) return undefined;
  const rect = node.getBoundingClientRect();
  const cs = getComputedStyle(node);
  if (cs.display === "none") return undefined;

  if (node.matches(SENSITIVE)) {
    st.redacted++;
    const block = document.createElement("div");
    block.setAttribute(
      "style",
      `display:${cs.display === "inline" ? "inline-block" : cs.display};width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;background:#2a2622;border:1px dashed #6b6255;border-radius:6px;color:#a39b8e;font:12px sans-serif;display:flex;align-items:center;justify-content:center;margin:${cs.margin};`,
    );
    block.textContent = "hidden";
    return block;
  }

  // A sealed frame (a custom code panel) can't be read from here: it draws itself on request
  // (11-19, the owner: "the screen captures don't work in tasterr").
  if (node instanceof HTMLIFrameElement && node.hasAttribute("data-hearth-snapshot")) {
    const src = await new Promise<string | undefined>((resolve) => {
      const t = window.setTimeout(() => resolve(undefined), 4_000);
      node.dispatchEvent(
        new CustomEvent("hearth-snapshot", {
          detail: {
            resolve: (v?: string) => {
              window.clearTimeout(t);
              resolve(v);
            },
          },
        }),
      );
    });
    if (src?.startsWith("data:image/")) {
      const img = document.createElement("img");
      img.src = src;
      copyStyle(node, img);
      img.style.objectFit = "cover";
      img.style.objectPosition = "top left";
      return img;
    }
  }

  if (node instanceof HTMLCanvasElement) {
    const img = document.createElement("img");
    try {
      img.src = node.toDataURL();
    } catch {
      img.alt = "";
    }
    copyStyle(node, img);
    return img;
  }

  const copy = node.cloneNode(false) as HTMLElement;
  copy.removeAttribute("id");
  copyStyle(node, copy);
  await inlineImages(cs, copy);
  await frameAsBackground(node, cs, copy);
  solidText(cs, copy);

  if (node instanceof HTMLImageElement && node.currentSrc) {
    const data = await toDataUrl(node.currentSrc);
    if (data) (copy as HTMLImageElement).src = data;
    copy.removeAttribute("srcset");
  }
  if (node instanceof HTMLInputElement) {
    if (node.type === "checkbox" || node.type === "radio") {
      if (node.checked) copy.setAttribute("checked", "");
    } else copy.setAttribute("value", node.value);
  }
  if (node instanceof HTMLTextAreaElement) copy.textContent = node.value;
  if (node instanceof HTMLSelectElement) {
    const span = document.createElement("span");
    copyStyle(node, span);
    span.textContent = node.selectedOptions[0]?.textContent ?? "";
    // Drawn like the menu it is: the choice centred in its box, with the arrow.
    span.style.display = "flex";
    span.style.alignItems = "center";
    span.style.justifyContent = "space-between";
    span.style.gap = "6px";
    const arrow = document.createElement("span");
    arrow.textContent = "▾";
    arrow.setAttribute("style", "opacity:0.7;font-size:0.9em");
    span.appendChild(arrow);
    return span;
  }

  // ::before / ::after: kept through a rule on a class unique to this copy.
  for (const pseudo of PSEUDO) {
    const ps = getComputedStyle(node, pseudo);
    const content = ps.getPropertyValue("content");
    if (!content || content === "none" || content === "normal") continue;
    const cls = `dc-cap-${st.n++}`;
    copy.classList.add(cls);
    let text = "";
    for (let i = 0; i < ps.length; i++) {
      const p = ps.item(i);
      const v = ps.getPropertyValue(p);
      text += `${p}:${v.includes("url(") ? await inlineUrls(v) : v};`;
    }
    st.rules.push(`.${cls}${pseudo}{${text}}`);
  }

  // Pinned (sticky) elements: placed where they appear now, not where the flow would put them.
  if (cs.position === "sticky" && node instanceof HTMLElement) {
    const before = node.style.position;
    node.style.position = "relative";
    const natural = node.getBoundingClientRect();
    node.style.position = before;
    const dx = rect.left - natural.left;
    const dy = rect.top - natural.top;
    copy.style.position = "relative";
    copy.style.top = "auto";
    copy.style.left = "auto";
    copy.style.right = "auto";
    copy.style.bottom = "auto";
    if (dx || dy) copy.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  const kids: Node[] = [];
  for (const child of Array.from(node.childNodes)) {
    const c = await cloneNode(child, st);
    if (c) kids.push(c);
  }
  // A scrolled area keeps showing what is scrolled into view.
  if (node.scrollTop || node.scrollLeft) {
    copy.style.overflow = "hidden";
    const shift = document.createElement("div");
    shift.setAttribute(
      "style",
      `transform:translate(${-node.scrollLeft}px, ${-node.scrollTop}px);width:${node.scrollWidth}px;height:${node.scrollHeight}px;position:relative;`,
    );
    // Children keep the layout they had inside the scrolled box.
    shift.style.display = cs.display;
    shift.style.flexDirection = cs.flexDirection;
    shift.style.gridTemplateColumns = cs.gridTemplateColumns;
    shift.style.gap = cs.gap;
    for (const k of kids) shift.appendChild(k);
    copy.appendChild(shift);
  } else {
    for (const k of kids) copy.appendChild(k);
  }
  return copy;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The capture could not be drawn."));
    img.src = src;
  });
}

/** Most pixels in one capture, so the image stays well under the 5 MB attachment limit. */
const MAX_PIXELS = 6_000_000;

/**
 * Captures `el` as it looks now. `region` (in page pixels, relative to the element) crops it.
 */
export async function captureElement(el: HTMLElement, region?: Region): Promise<CaptureResult> {
  const rect = el.getBoundingClientRect();
  const st: CloneState = { rules: [], redacted: 0, n: 0 };
  const copy = (await cloneNode(el, st)) as HTMLElement;
  // The copy sits where the element is, at its visible size.
  copy.style.margin = "0";
  copy.style.width = `${rect.width}px`;
  copy.style.height = `${rect.height}px`;
  copy.style.transform = "none";
  const fonts = await embeddedFonts();
  const w = Math.ceil(rect.width);
  const h = Math.ceil(rect.height);
  // Fonts and pseudo-element rules travel inside the image, as a real style element.
  const wrap = document.createElement("div");
  wrap.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const style = document.createElement("style");
  // Scrollbars carry nothing worth seeing (and phones do not show them): left out.
  const plain = "*{scrollbar-width:none !important}*::-webkit-scrollbar{display:none !important}";
  style.textContent = [fonts, plain, ...st.rules].join("\n");
  wrap.append(style, copy);
  const xhtml = new XMLSerializer().serializeToString(wrap);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

  const crop = region
    ? {
        x: Math.max(0, region.x),
        y: Math.max(0, region.y),
        width: Math.min(region.width, w - Math.max(0, region.x)),
        height: Math.min(region.height, h - Math.max(0, region.y)),
      }
    : { x: 0, y: 0, width: w, height: h };
  let scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  while (crop.width * crop.height * scale * scale > MAX_PIXELS && scale > 0.5) scale -= 0.25;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width * scale));
  canvas.height = Math.max(1, Math.round(crop.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = backdropOf(el);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("The capture could not be saved."))),
      "image/png",
    ),
  );

  // Metric names inside the captured area, for the context sent with it.
  const area = region
    ? new DOMRect(rect.left + crop.x, rect.top + crop.y, crop.width, crop.height)
    : rect;
  const metrics = [
    ...new Set(
      Array.from(el.querySelectorAll<HTMLElement>("[data-metric-name]"))
        .filter((m) => {
          const r = m.getBoundingClientRect();
          return (
            r.right > area.left && r.left < area.right && r.bottom > area.top && r.top < area.bottom
          );
        })
        .map((m) => m.dataset.metricName!)
        .filter(Boolean),
    ),
  ].slice(0, 40);
  return { blob, width: canvas.width, height: canvas.height, redacted: st.redacted, metrics };
}
