import { useState } from "react";
import { useNavigate } from "react-router";
import type { AppViewProps } from "../panels/registry";
import { useSetPin } from "../../data/home";
import { Button } from "../ui";
import { HomeDashboard } from "./HomeDashboard";

/**
 * Home Assistant's Home tab: the home dashboard as a wall tablet shows it, with Full screen, and
 * the owner's own settings for it (the unlock PIN). Pairing a tablet is in Devices.
 */
export function HomeTab({ serviceId }: AppViewProps) {
  const navigate = useNavigate();
  const setPin = useSetPin();
  const [pin, setPinText] = useState("");
  const [msg, setMsg] = useState<string>();
  return (
    <div className="space-y-4">
      <HomeDashboard
        service={serviceId}
        onFullScreen={() => navigate(`/home-screen?service=${encodeURIComponent(serviceId)}`)}
      />
      <form
        className="flex flex-wrap items-end gap-2 rounded-2xl border border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setPin.mutate(pin, {
            onSuccess: () => {
              setPinText("");
              setMsg("The unlock PIN is set.");
            },
            onError: (er) => setMsg(er.message),
          });
        }}
        data-testid="home-pin-form"
      >
        <label className="grid gap-1 text-[0.8rem] text-muted">
          Unlock PIN (4 to 8 digits): opening doors and turning the alarm off ask for it
          <input
            className="min-h-11 w-40 rounded-lg border border-line-strong bg-bg px-3 text-[1rem] tracking-widest text-ink"
            inputMode="numeric"
            type="password"
            autoComplete="new-password"
            value={pin}
            onChange={(e) => setPinText(e.target.value.replace(/\D/g, "").slice(0, 8))}
            aria-label="Unlock PIN"
            data-testid="home-pin-input"
          />
        </label>
        <Button type="submit" disabled={setPin.isPending || pin.length < 4}>
          Set the PIN
        </Button>
        {msg && (
          <span className="text-[0.82rem] text-muted" role="status">
            {msg}
          </span>
        )}
      </form>
    </div>
  );
}
