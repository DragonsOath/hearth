import { pageTitle } from "@dragon-control/core";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { CaptureButton } from "../capture/Capture";

/** The element the screen camera captures: the whole app (AppShell's outer frame). */
export const SCREEN_ID = "hearth-screen";

/**
 * The camera in the top bar (11-17): the same capture as each panel's camera, for the whole Hearth
 * screen. Whole screen, Pick an item anywhere, or Draw a region; then mark it up, copy, save, or
 * attach it to the conversation. Hearth draws it from its own page, so no screen-sharing prompt,
 * nothing outside Hearth, and sensitive fields are left out.
 */
export function ScreenCapture() {
  const { pathname } = useLocation();
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => {
    target.current = document.getElementById(SCREEN_ID);
  });
  return (
    <CaptureButton
      target={target}
      screen
      wholeLabel="Whole screen"
      context={{ panel: pageTitle(pathname) }}
    />
  );
}
