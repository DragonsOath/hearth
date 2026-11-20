import { describe, expect, it } from "vitest";
import { healthFix } from "./healthFix";

describe("healthFix", () => {
  it("links each fixable check to the setting that fixes it", () => {
    expect(healthFix("IndexerSearchCheck")).toMatchObject({
      tab: "config",
      sub: "connections/indexer",
    });
    expect(healthFix("DownloadClientStatusCheck")?.sub).toBe("connections/downloadclient");
    expect(healthFix("RemotePathMappingCheck")?.sub).toBe("connections/downloadclient");
    expect(healthFix("ImportListStatusCheck")?.sub).toBe("connections/importlist");
    expect(healthFix("RootFolderCheck")?.sub).toBe("media/rootfolders");
    expect(healthFix("RemovedSeriesCheck")).toMatchObject({ tab: "library", sub: null });
  });

  it("offers no link where Hearth has no setting for it", () => {
    expect(healthFix("UpdateCheck")).toBeUndefined();
    expect(healthFix("SystemTimeCheck")).toBeUndefined();
    expect(healthFix(undefined)).toBeUndefined();
  });
});
