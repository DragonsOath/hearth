import { appKindOf } from "@dragon-control/core";
import { useWorkspace } from "../../../data/api";

/** "Emby" or "Jellyfin": the shared panel says which server it is (Emby speaks Jellyfin's API). */
export function useServerWord(serviceId: string): "Emby" | "Jellyfin" {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  return service && appKindOf(service) === "emby" ? "Emby" : "Jellyfin";
}
