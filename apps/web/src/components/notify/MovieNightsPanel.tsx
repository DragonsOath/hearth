import { Link } from "react-router";
import { Settings } from "lucide-react";
import { WorkspaceFrame, type TabDef } from "../command/WorkspaceFrame";
import { ToolImage } from "../panels/ToolImage";
import { MovieNights } from "./MovieNights";

/**
 * Movie nights as its own panel (11-12, the owner: "the invite system through Discord should be in a
 * panel, not buried in the settings"). Planning a night, who's coming, changing or cancelling it
 * live here; the Discord bot and where invitations go stay in Settings, one link away.
 */
export function MovieNightsPanel({ onClose }: { onClose: () => void }) {
  const tabs: TabDef<"nights">[] = [{ id: "nights", label: "Nights" }];
  return (
    <WorkspaceFrame
      label="Movie nights"
      testId="movie-nights-panel"
      icon={<ToolImage id="movie-nights" />}
      title="Movie nights"
      subtitle="Pick a movie and a time, and Hearth invites your friends, with reminders and a guest list."
      tabs={tabs}
      tab="nights"
      onTab={() => undefined}
      onClose={onClose}
      capture={{ panel: "Movie nights", tab: "nights" }}
      help={["movie-nights"]}
    >
      <div className="space-y-6">
        <MovieNights inPanel />
        <p className="border-t border-line pt-4 text-[0.82rem] text-muted">
          <Link
            to="/notifications#media-announcements"
            className="inline-flex min-h-11 items-center gap-1.5 text-gold hover:underline"
            data-testid="movie-nights-setup"
          >
            <Settings strokeWidth={1.5} className="h-4 w-4" aria-hidden />
            Discord bot and who gets invited
          </Link>{" "}
          are set up in Notifications.
        </p>
      </div>
    </WorkspaceFrame>
  );
}
