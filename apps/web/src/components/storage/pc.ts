import { createContext, useContext } from "react";

/**
 * Which PC the Storage & Files panel is showing: "" for this one, or a joined PC's id. Every read
 * in the panel goes to that PC through this Hearth (/api/on/<pc>/...), so each PC shows its own
 * drives, files and arrays.
 */
export const StoragePc = createContext<string>("");

/** The PC being shown ("" is this one). */
export const useStoragePc = () => useContext(StoragePc);

/** "/api/files/list" on the PC being shown. */
export function onPc(pc: string, path: string): string {
  return pc ? `/api/on/${encodeURIComponent(pc)}/${path.replace(/^\/api\//, "")}` : path;
}

/** The address maker for the PC being shown. */
export function useOnPc(): (path: string) => string {
  const pc = useStoragePc();
  return (path) => onPc(pc, path);
}
