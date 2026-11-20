import { ApiError } from "../../data/api";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";

/**
 * Why approving did not go through. A protected change (VPN, Caddy, networking) needs a fresh
 * "it's you": confirm here and the approval is sent again.
 */
export function ApprovalError({
  error,
  onConfirmed,
  className,
}: {
  error: Error | null;
  onConfirmed: () => void;
  className?: string;
}) {
  if (!error) return null;
  if (error instanceof ApiError && error.status === 403)
    return (
      <div className={className} data-testid="approve-confirm">
        <ConfirmIdentity reason={error.message} onConfirmed={onConfirmed} />
      </div>
    );
  return (
    <p role="alert" className={className ? `${className} text-bad` : "text-bad"}>
      {error.message}
    </p>
  );
}
