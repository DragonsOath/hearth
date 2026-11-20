/**
 * Ember Thread Looks (11-17, the owner's "Ember Thread Looks" doc): a small Ember picture picked
 * when a conversation starts. Each has a one-word name that hints at what the thread is for, and
 * the thread is named that by default (Sprocket for fixing something, Vinyl for music). Only a
 * picture and a default name: Ember's own name, picture, persona, voice and behaviour never change
 * with it, and it shows only on the thread (the conversation list and the chat's header).
 * Not the Ember Personas. Free for everyone.
 */
export interface ThreadLook {
  /** Stored on the conversation; also the picture's file name (/thread-looks/<id>.webp). */
  id: string;
  /** The thread's default name. */
  name: string;
  /** What the picture shows (only to match the art). */
  picture: string;
  /** What the thread is for, shown under the name in the picker. */
  for: string;
}

export const THREAD_LOOKS: readonly ThreadLook[] = [
  { id: "sprocket", name: "Sprocket", picture: "Mechanic", for: "Something's broken, fix it" },
  {
    id: "brick",
    name: "Brick",
    picture: "Builder",
    for: "Projects, the Forge, setting new things up",
  },
  { id: "page", name: "Page", picture: "Librarian", for: "Media, Curator, what to watch" },
  { id: "vinyl", name: "Vinyl", picture: "DJ", for: "Music, playlists, Ember Radio" },
  { id: "popcorn", name: "Popcorn", picture: "Host", for: "Movie nights and friends" },
  { id: "warden", name: "Warden", picture: "Guard", for: "Security, the vault, access" },
  { id: "tutor", name: "Tutor", picture: "Teacher", for: "How-to questions, Show & Tell" },
  {
    id: "ranger",
    name: "Ranger",
    picture: "Scout",
    for: "Look around and explain, change nothing",
  },
  { id: "herald", name: "Herald", picture: "Messenger", for: "Notifications and Discord" },
  { id: "ember", name: "Ember", picture: "Plain", for: "No particular task" },
  {
    id: "sleuth",
    name: "Sleuth",
    picture: "Detective",
    for: '"Why did this happen?", logs and incidents',
  },
  { id: "doc", name: "Doc", picture: "Doctor", for: "Health checks, memory, CPU, disks" },
  { id: "keeper", name: "Keeper", picture: "Archivist", for: "Backups, restores, Lab Blueprint" },
  { id: "sprout", name: "Sprout", picture: "Gardener", for: "Old files, tidying storage" },
  { id: "anvil", name: "Anvil", picture: "Smith", for: "Panel Builder and custom panels" },
  { id: "benson", name: "Benson", picture: "Butler", for: "Home automation, lights, the house" },
  {
    id: "parcel",
    name: "Parcel",
    picture: "Courier",
    for: "Downloads, Sonarr and Radarr, requests",
  },
  { id: "pixel", name: "Pixel", picture: "Gamer", for: "RomM and game nights" },
  { id: "quill", name: "Quill", picture: "Bard", for: "Audiobooks, ebooks, Kavita" },
  {
    id: "lantern",
    name: "Lantern",
    picture: "Night Watch",
    for: '"Keep an eye on this", watches and briefs',
  },
  {
    id: "owl",
    name: "Owl",
    picture: "Scholar",
    for: "Research and comparing apps before installing",
  },
  { id: "dolly", name: "Dolly", picture: "Mover", for: "Migrations and linking another Hearth" },
];

export const THREAD_LOOK_IDS = THREAD_LOOKS.map((l) => l.id) as readonly string[];

export function threadLook(id: string | null | undefined): ThreadLook | undefined {
  return id ? THREAD_LOOKS.find((l) => l.id === id) : undefined;
}

/** Where a look's picture is served (the web app's public folder). */
export function threadLookImage(id: string): string {
  return `/thread-looks/${id}.webp`;
}

/**
 * A new thread's name from its look: the look's name, or with a number when a thread already has
 * it ("Sprocket 2"), so two Sprocket threads can be told apart.
 */
export function lookThreadName(look: ThreadLook, taken: readonly string[]): string {
  const names = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!names.has(look.name.toLowerCase())) return look.name;
  for (let n = 2; n < 1000; n++) {
    const name = `${look.name} ${n}`;
    if (!names.has(name.toLowerCase())) return name;
  }
  return look.name;
}
