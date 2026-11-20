import { useEffect } from "react";
import { Link } from "react-router";
import { LogOut, X } from "lucide-react";
import { useAuthStatus } from "../data/auth";
import { api } from "../data/api";
import { HomeDashboard } from "../components/home/HomeDashboard";

/**
 * The home dashboard full screen (11-04): what a wall tablet shows, without the rest of
 * Hearth around it. A paired home tablet opens here and stays here; the owner can open it too.
 */
export function HomeScreenPage() {
  const auth = useAuthStatus().data;
  const tablet = auth?.method === "home";
  // Keep the screen awake on a wall tablet, where the browser allows it.
  useEffect(() => {
    let lock: { release(): Promise<void> } | undefined;
    const nav = navigator as unknown as {
      wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> };
    };
    void nav.wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => undefined);
    return () => void lock?.release().catch(() => undefined);
  }, []);
  const params = new URLSearchParams(window.location.search);
  return (
    <main className="h-dvh bg-bg" data-testid="home-screen">
      <HomeDashboard
        kiosk
        service={params.get("service") ?? undefined}
        exit={
          tablet ? (
            <button
              type="button"
              className="hd-pill"
              onClick={() =>
                void api("POST", "/api/auth/logout").then(() => window.location.assign("/login"))
              }
            >
              <LogOut size={18} /> Unpair this tablet
            </button>
          ) : (
            <Link to="/" className="hd-pill" data-testid="home-back">
              <X size={18} /> Back to Hearth
            </Link>
          )
        }
      />
    </main>
  );
}
