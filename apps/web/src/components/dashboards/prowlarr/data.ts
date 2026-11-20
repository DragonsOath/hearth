import { useServarrView, type Connection, type ConnectionField } from "../radarr/data";

/**
 * What the native Prowlarr panel's own tabs read from Hearth (server: apps/prowlarr-panel.ts).
 * Connections, System and the log are the Radarr panel's shared tabs under a Prowlarr context.
 */

interface Base {
  meta: { version: string; supported: boolean };
  sample?: boolean;
}
export interface AppProfile {
  id: number;
  name: string;
  rss: boolean;
  automatic: boolean;
  interactive: boolean;
  minimumSeeders: number;
}
export interface TagRef {
  id: number;
  label: string;
}
interface Lookups {
  appProfiles: AppProfile[];
  tags: TagRef[];
}

export interface IndexerRow {
  id: number;
  name: string;
  definition: string;
  enabled: boolean;
  protocol: string;
  privacy: string;
  priority: number;
  appProfileId?: number;
  downloadClientId?: number;
  tags: number[];
  url?: string;
  categories: string[];
  failing: boolean;
  pausedUntil?: string;
  lastFailure?: string;
  queries: number;
  grabs: number;
  failedQueries: number;
  failedGrabs: number;
  avgMs?: number;
}
export interface IndexersView extends Base, Lookups {
  proxies: { id: number; name: string; tags: number[] }[];
  downloadClients: { id: number; name: string }[];
  indexers: IndexerRow[];
}
export interface HistoryRow {
  id: number;
  indexerId?: number;
  date?: string;
  event: string;
  successful: boolean;
  query?: string;
  title?: string;
  source?: string;
  host?: string;
  results?: number;
  elapsedMs?: number;
}
export interface IndexerView extends Base, Lookups {
  indexer: Connection & {
    definition: string;
    description?: string;
    privacy: string;
    appProfileId?: number;
    urls: string[];
    categories: string[];
    supportsRss: boolean;
    supportsSearch: boolean;
  };
  history: HistoryRow[];
}
export interface Definition {
  name: string;
  definition: string;
  implementation: string;
  description?: string;
  privacy: string;
  protocol: string;
  language?: string;
  needsSecret: boolean;
}
export interface DefinitionsView extends Base {
  total: number;
  matches: number;
  definitions: Definition[];
}
export interface DefinitionView extends Base, Lookups {
  definition: Definition & {
    fields: (ConnectionField & {
      advanced: boolean;
      options?: { value: unknown; name: string }[];
    })[];
  };
}
export interface SearchResult {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  age?: number;
  ageHours?: number;
  published?: string;
  seeders?: number;
  leechers?: number;
  grabs?: number;
  protocol: string;
  categories: string[];
  info?: string;
}
export interface SearchView extends Base {
  indexers: { id: number; name: string; enabled: boolean; protocol: string }[];
  query: string;
  results: SearchResult[];
}
export interface AppsView extends Base, Lookups {
  apps: (Connection & { syncLevel: string })[];
  kinds: string[];
}
export interface HistoryView extends Base {
  page: number;
  pageSize: number;
  total: number;
  records: HistoryRow[];
}
export interface TagsView extends Base {
  tags: {
    id: number;
    label: string;
    indexers: number;
    apps: number;
    proxies: number;
    notifications: number;
    downloadClients: number;
  }[];
}

export interface ProwlarrViews {
  indexers: IndexersView;
  indexer: IndexerView;
  definitions: DefinitionsView;
  definition: DefinitionView;
  search: SearchView;
  apps: AppsView;
  history: HistoryView;
  tags: TagsView;
}

export function useProwlarr<V extends keyof ProwlarrViews>(
  serviceId: string,
  view: V,
  q: Record<string, string | number | undefined> = {},
  enabled = true,
) {
  return useServarrView<ProwlarrViews[V]>("prowlarr", serviceId, view, q, enabled);
}

export const PRIVACY: Record<string, string> = {
  public: "Public",
  semiPrivate: "Semi-private",
  private: "Private",
};
export const SYNC_LEVELS: { value: string; label: string; hint: string }[] = [
  {
    value: "fullSync",
    label: "Full sync",
    hint: "Prowlarr adds, changes and removes the app's indexers to match its own.",
  },
  {
    value: "addOnly",
    label: "Add and remove only",
    hint: "Prowlarr adds and removes indexers, but leaves changes made in the app alone.",
  },
  { value: "disabled", label: "Off", hint: "Prowlarr leaves this app's indexers alone." },
];
export const EVENT_WORDS: Record<string, string> = {
  indexerQuery: "Search",
  indexerRss: "RSS",
  releaseGrabbed: "Grabbed",
  indexerAuth: "Sign-in",
  indexerInfo: "Info",
};
