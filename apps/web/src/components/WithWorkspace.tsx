import type { ReactNode } from "react";
import { useWorkspace } from "../data/api";
import type { Workspace } from "@dragon-control/core";
import { ErrorState, PageSkeleton } from "./ui";

/** Handles loading and failure once so every page only renders the happy path. */
export function WithWorkspace({ children }: { children: (ws: Workspace) => ReactNode }) {
  const { data, error, refetch, isFetching } = useWorkspace();
  if (error && !isFetching) {
    return <ErrorState message={error.message} onRetry={() => void refetch()} />;
  }
  if (!data) return <PageSkeleton />;
  return <>{children(data)}</>;
}
