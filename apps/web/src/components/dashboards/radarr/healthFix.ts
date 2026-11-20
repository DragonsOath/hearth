/**
 * Where a Radarr or Sonarr health warning gets fixed inside Hearth (UX rule 5: link straight to
 * the control that fixes it). Keyed by the app's own health check name (`source`), which both
 * apps share. Checks with no setting in Hearth (an app update, the system clock, a proxy) have no
 * link: Ask Ember and the app's help page still apply.
 */
export interface HealthFix {
  tab: string;
  sub: string | null;
  label: string;
}

const INDEXERS: HealthFix = { tab: "config", sub: "connections/indexer", label: "Open indexers" };
const CLIENTS: HealthFix = {
  tab: "config",
  sub: "connections/downloadclient",
  label: "Open download clients",
};
const LISTS: HealthFix = {
  tab: "config",
  sub: "connections/importlist",
  label: "Open import lists",
};
const NOTIFY: HealthFix = {
  tab: "config",
  sub: "connections/notification",
  label: "Open connections",
};
const ROOTS: HealthFix = { tab: "config", sub: "media/rootfolders", label: "Open root folders" };
const MEDIA: HealthFix = { tab: "config", sub: "media", label: "Open files and naming" };
const LIBRARY: HealthFix = { tab: "library", sub: null, label: "Open the library" };

const BY_SOURCE: Record<string, HealthFix> = {
  IndexerStatusCheck: INDEXERS,
  IndexerLongTermStatusCheck: INDEXERS,
  IndexerRssCheck: INDEXERS,
  IndexerSearchCheck: INDEXERS,
  IndexerJackettAllCheck: INDEXERS,
  DownloadClientCheck: CLIENTS,
  DownloadClientStatusCheck: CLIENTS,
  DownloadClientRootFolderCheck: CLIENTS,
  DownloadClientSortingCheck: CLIENTS,
  DownloadClientRemovesCompletedDownloadsCheck: CLIENTS,
  ImportMechanismCheck: CLIENTS,
  RemotePathMappingCheck: CLIENTS,
  ImportListStatusCheck: LISTS,
  ImportListRootFolderCheck: LISTS,
  ImportListMissingRootCheck: LISTS,
  NotificationStatusCheck: NOTIFY,
  RootFolderCheck: ROOTS,
  MountCheck: ROOTS,
  RecyclingBinCheck: MEDIA,
  RemovedMovieCheck: LIBRARY,
  RemovedSeriesCheck: LIBRARY,
};

export function healthFix(source: string | undefined): HealthFix | undefined {
  return source ? BY_SOURCE[source] : undefined;
}
