import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "../../components/ui";
import { usePair } from "../../data/auth";
import { AuthFrame, FormError, TextField } from "./AuthFrame";

/**
 * Signing a device in with a code from Add a device. The QR code opens this page with the code
 * in the address, so scanning it is all it takes; the code can also be typed.
 */
export function PairPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const pair = usePair();
  const given = params.get("code") ?? "";
  const [code, setCode] = useState(given);
  const tried = useRef(false);

  // A speaker link (Add a speaker) opens the home screen ready to play here.
  const next = params.get("next") === "speaker" ? "/home-screen?speaker=1" : "/";
  const submit = (c: string) =>
    pair.mutate(c.trim(), { onSuccess: () => navigate(next, { replace: true }) });

  // Opened from the QR: sign in straight away, once.
  useEffect(() => {
    if (given && !tried.current) {
      tried.current = true;
      submit(given);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [given]);

  return (
    <AuthFrame eyebrow="Add a device" title="Sign in this device">
      <p className="mb-6 text-[0.9rem] leading-relaxed text-muted">
        {pair.isPending
          ? "Signing in…"
          : "Type the code shown under Add a device on your Hearth (Settings, PCs and devices)."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(code);
        }}
      >
        <TextField
          id="pair-code"
          label="Code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          placeholder="Pairing code"
          data-testid="pair-code"
        />
        <Button tone="primary" type="submit" disabled={pair.isPending || !code.trim()}>
          Sign in
        </Button>
      </form>
      <FormError error={pair.error} />
    </AuthFrame>
  );
}
