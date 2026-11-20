import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import {
  useQuery,
  type DefaultError,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";

/**
 * A panel's lifecycle as the desk sees it (native panels Phase 1). One shared signal for
 * everything that cares whether a panel can be seen: its own refreshing now, and Ember Show &
 * Tell's presenter later, so there is never a second, competing idea of "on screen".
 *
 * - visible: on screen.
 * - covered: still mounted (so its scroll, choices and half-typed input survive) but hidden
 *   behind an expanded panel. It makes no background requests until it is visible again.
 *
 * Panels that do not fit on the desk are not covered: they are unmounted and wait as chips.
 * Outside the desk (pages, the phone's single panel) everything counts as visible.
 */
export type PanelVisibility = "visible" | "covered";

export interface PanelLifecycle {
  /** The panel's key ("service:radarr"), when inside a desk panel. */
  panel?: string;
  visibility: PanelVisibility;
}

const OUTSIDE: PanelLifecycle = { visibility: "visible" };
const LifecycleContext = createContext<PanelLifecycle>(OUTSIDE);

export function PanelLifecycleProvider({
  value,
  children,
}: {
  value: PanelLifecycle;
  children: ReactNode;
}) {
  return <LifecycleContext.Provider value={value}>{children}</LifecycleContext.Provider>;
}

export function usePanelLifecycle(): PanelLifecycle {
  return useContext(LifecycleContext);
}

/** True while the panel this component is in can be seen (always true outside the desk). */
export function usePanelVisible(): boolean {
  return useContext(LifecycleContext).visibility === "visible";
}

/**
 * useQuery for data a panel keeps fresh on its own. While the panel is covered it stops
 * refreshing (no interval, no refresh on window focus); when it is shown again it refreshes
 * once straight away, then carries on at its normal rate.
 */
export function useLiveQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>): UseQueryResult<TData, TError> {
  const visible = usePanelVisible();
  const q = useQuery({
    ...options,
    ...(visible ? {} : { refetchInterval: false, refetchOnWindowFocus: false }),
  });
  const wasVisible = useRef(visible);
  const { refetch } = q;
  // A query switched off (enabled: false) is not fetched on reveal either.
  const enabled = typeof options.enabled === "boolean" ? options.enabled : true;
  useEffect(() => {
    if (visible && !wasVisible.current && enabled) void refetch();
    wasVisible.current = visible;
  }, [visible, enabled, refetch]);
  return q;
}
