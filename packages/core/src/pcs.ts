/**
 * The PC icons (the owner's set, in apps/web/public/pc-icons). Each PC in your Hearth gets one,
 * and its name is shown under it in the icon's color, so it is easy to see which PC a project
 * or a system is on (docs/design/ONE_ACCOUNT.md).
 */
export const PC_ICONS = [
  { id: "dragon", label: "Dragon", color: "#ff5a36" },
  { id: "mountain", label: "Mountain", color: "#3d9bff" },
  { id: "wolf", label: "Wolf", color: "#b05cff" },
  { id: "server", label: "Server", color: "#ff9124" },
  { id: "leaf", label: "Leaf", color: "#3ddc6a" },
  { id: "home", label: "Home", color: "#2ec9ea" },
  { id: "gear", label: "Gear", color: "#ff4f9a" },
  { id: "star", label: "Star", color: "#ffc72c" },
  { id: "swirl", label: "Swirl", color: "#34d1c4" },
  { id: "shield", label: "Shield", color: "#cfd6de" },
  { id: "code", label: "Code", color: "#38c8ff" },
] as const;

export type PcIconId = (typeof PC_ICONS)[number]["id"];

export const pcIcon = (id: string | null | undefined) => PC_ICONS.find((i) => i.id === id);

/** A color as stored: #rrggbb. */
export const isColor = (c: string) => /^#[0-9a-f]{6}$/i.test(c);

/**
 * Systems on another PC carry ids that say which PC they are on, so any page or panel that opens
 * one is sent to that PC through your Hearth: "pc~<pc id>~<its id there>".
 */
export const remoteId = (pc: string, id: string) => `pc~${pc}~${id}`;

const REMOTE = /^pc~([a-f0-9]{10})~(.+)$/;
export function parseRemoteId(id: string): { pc: string; id: string } | null {
  const m = REMOTE.exec(id);
  return m ? { pc: m[1]!, id: m[2]! } : null;
}

/** An API address that names a system on another PC goes to that PC: /api/on/<pc>/... */
export function routeToPc(url: string): string {
  const m = /^\/api\/(?!on\/)(.*?)pc~([a-f0-9]{10})~([^/?#]+)(.*)$/.exec(url);
  return m ? `/api/on/${m[2]}/${m[1]}${m[3]}${routeInner(m[4]!, m[2]!)}` : url;
}
// Further ids in the same address on the same PC lose their prefix too.
const routeInner = (rest: string, pc: string) => rest.split(`pc~${pc}~`).join("");
