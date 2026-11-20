import { CommandBox } from "../../components/devices/Pcs";
import { AuthFrame } from "./AuthFrame";

/**
 * A PC's join link opened in a browser by mistake: it belongs on the new PC, in its installer
 * command or its setup page.
 */
export function JoinInfoPage() {
  return (
    <AuthFrame eyebrow="Link another Hearth" title="This link is for the new PC">
      <p className="mb-4 text-[0.9rem] leading-relaxed text-muted">
        Paste the install command from Link another Hearth into a terminal on the new PC, or open
        the new PC's own Hearth setup page, choose "Join it instead", and paste this link there:
      </p>
      <CommandBox text={window.location.href} />
    </AuthFrame>
  );
}
