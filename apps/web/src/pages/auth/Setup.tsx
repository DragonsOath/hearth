import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { Fingerprint } from "lucide-react";
import { Button } from "../../components/ui";
import {
  passkeysSupported,
  useAddPasskey,
  useAuthStatus,
  useJoinHub,
  useSetup,
} from "../../data/auth";
import { AuthFrame, FormError, TextField } from "./AuthFrame";
import { RecoveryKeyPanel } from "./RecoveryKey";
import { LinkPc } from "./LinkPc";

type Step = "secure" | "recovery" | "passkey";

/** After the account: the welcome, starting with connecting Ember's AI. */
const NEXT = "/welcome?step=ai";

/** "Fingerprint" on phones, "Windows Hello" or similar on computers: keep it generic and plain. */
export function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android phone";
  if (/iPhone|iPad/i.test(ua)) return "iPhone or iPad";
  if (/Windows/i.test(ua)) return "Windows computer";
  if (/Macintosh/i.test(ua)) return "Mac";
  return "This device";
}

export function SetupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const status = useAuthStatus();
  const setup = useSetup();
  const addPasskey = useAddPasskey();
  const [step, setStep] = useState<Step>("secure");
  const [code, setCode] = useState(params.get("code") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  // A new Hearth, or this PC joins one you already have (docs/design/ONE_ACCOUNT.md).
  // First: "Already have a Hearth account?" Linking needs only the Hearth API key.
  const [mode, setMode] = useState<"ask" | "new" | "link" | "join">(
    params.get("join") ? "join" : "ask",
  );
  const [joinLink, setJoinLink] = useState(params.get("join") ?? "");
  const join = useJoinHub();

  if (join.data) {
    return (
      <AuthFrame eyebrow="Joined" title={`This PC is part of ${join.data.hubName}`}>
        <p className="mb-6 text-[0.9rem] leading-relaxed text-muted" role="status">
          Its projects and systems now show up in your Hearth. Use Hearth from there, on any device.
        </p>
        <a
          href={join.data.hubUrl}
          className="flex min-h-11 w-full items-center justify-center rounded-lg bg-gold px-4 text-[0.9rem] text-bg hover:bg-gold-bright"
        >
          Open your Hearth
        </a>
      </AuthFrame>
    );
  }

  if (mode === "ask" && step === "secure" && status.data && !status.data.claimed) {
    return (
      <AuthFrame eyebrow="Welcome" title="Welcome to Hearth" stage="account">
        <p className="mb-6 text-[0.95rem] leading-relaxed text-ink">
          Have you set up Hearth on another PC before?
        </p>
        <div className="space-y-3">
          <Button
            tone="primary"
            className="w-full"
            onClick={() => setMode("link")}
            data-testid="setup-link"
          >
            Yes, link this PC to it
          </Button>
          <Button
            tone="outline"
            className="w-full"
            onClick={() => setMode("new")}
            data-testid="setup-new"
          >
            No, start a new Hearth
          </Button>
        </div>
        <p className="mt-5 text-[0.8rem] leading-relaxed text-faint">
          First time? Pick No. Nothing online is created: Hearth lives on this computer.
        </p>
      </AuthFrame>
    );
  }

  // Stays up once linked (this PC then counts as set up) to say so and point to your Hearth.
  if (mode === "link" && step === "secure") {
    return (
      <AuthFrame eyebrow="Welcome" title="Link to your Hearth" stage="account">
        <LinkPc setupCode={params.get("code") ?? ""} onBack={() => setMode("ask")} />
      </AuthFrame>
    );
  }

  if (mode === "join" && step === "secure" && !status.data?.claimed) {
    return (
      <AuthFrame eyebrow="Welcome" title="Join your Hearth" stage="account">
        <p className="mb-6 text-[0.9rem] leading-relaxed text-muted">
          This PC joins a Hearth you already have. Get a join link there: PCs and devices, Link
          another Hearth.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            join.mutate({ link: joinLink.trim(), setupCode: code.trim() });
          }}
        >
          <TextField
            id="join-link"
            label="Join link"
            hint="Starts with your Hearth's address, like http://192.168.1.10:7600/join?code=..."
            value={joinLink}
            onChange={(e) => setJoinLink(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <TextField
            id="setup-code"
            label="This PC's setup code"
            hint="Shown where Hearth was installed on this PC. It proves you are at it."
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <Button tone="primary" type="submit" className="w-full" disabled={join.isPending}>
            {join.isPending ? "Joining" : "Join"}
          </Button>
          <FormError error={join.error} />
        </form>
        <Button tone="quiet" className="mt-4 w-full" onClick={() => setMode("new")}>
          Start a new Hearth instead
        </Button>
      </AuthFrame>
    );
  }

  // Already set up and not in the middle of setting it up: sign in instead.
  if (step === "secure" && !setup.data && status.data?.claimed) {
    return <Navigate to={status.data.signedIn ? "/" : "/login"} replace />;
  }

  if (step === "recovery" && setup.data) {
    return (
      <AuthFrame eyebrow="Step 2 of 3" title="Save your recovery key" wide stage="account">
        <RecoveryKeyPanel
          recoveryKey={setup.data.recoveryKey}
          onDone={() =>
            passkeysSupported() ? setStep("passkey") : navigate(NEXT, { replace: true })
          }
          doneLabel={passkeysSupported() ? "Continue" : "Next: Connect your AI"}
        />
      </AuthFrame>
    );
  }

  if (step === "passkey") {
    const done = addPasskey.data;
    return (
      <AuthFrame eyebrow="Step 3 of 3" title="Unlock with your fingerprint" stage="account">
        {done ? (
          <>
            <p className="mb-6 text-[0.9rem] leading-relaxed text-muted" role="status">
              {done.unlocksVault
                ? "Passkey added. It signs you in and unlocks protected secrets."
                : "Passkey added. It signs you in; your password unlocks protected secrets on this device."}
            </p>
            <Button
              tone="primary"
              className="w-full"
              onClick={() => navigate(NEXT, { replace: true })}
            >
              Next: Connect your AI
            </Button>
          </>
        ) : (
          <>
            <p className="mb-6 text-[0.9rem] leading-relaxed text-muted">
              Sign in with this device's fingerprint, face, or Windows Hello instead of typing your
              password. You can add more devices later in Settings.
            </p>
            <Button
              tone="primary"
              className="w-full"
              disabled={addPasskey.isPending}
              onClick={() => addPasskey.mutate(defaultPasskeyName())}
            >
              <Fingerprint strokeWidth={1.25} className="h-5 w-5" />
              {addPasskey.isPending ? "Waiting for your device" : "Add a passkey"}
            </Button>
            <Button
              tone="quiet"
              className="mt-3 w-full"
              onClick={() => navigate(NEXT, { replace: true })}
            >
              Not now. Next: Connect your AI
            </Button>
            <FormError error={addPasskey.error} />
          </>
        )}
      </AuthFrame>
    );
  }

  return (
    <AuthFrame eyebrow="Welcome" title="Secure Hearth" stage="account">
      <p className="mb-6 text-[0.9rem] leading-relaxed text-muted">
        First, make this installation yours. Nobody else on your network can use it once this is
        done.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password !== confirm) {
            setMismatch(true);
            return;
          }
          setMismatch(false);
          setup.mutate({ code, password }, { onSuccess: () => setStep("recovery") });
        }}
      >
        <TextField
          id="setup-code"
          label="Setup code"
          hint="Shown where Hearth was installed. It proves you are at the machine."
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <TextField
          id="new-password"
          label="Password"
          type="password"
          hint="At least 12 characters. A short sentence is easy to remember and hard to guess."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
        <TextField
          id="confirm-password"
          label="Password again"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
        {mismatch && (
          <p role="alert" className="mb-4 text-[0.85rem] text-bad">
            The two passwords do not match.
          </p>
        )}
        <Button tone="primary" type="submit" className="w-full" disabled={setup.isPending}>
          {setup.isPending ? "Securing" : "Secure Hearth"}
        </Button>
        <FormError error={setup.error} />
      </form>
      <Button
        tone="quiet"
        className="mt-4 w-full"
        onClick={() => setMode("link")}
        data-testid="setup-join"
      >
        Already have Hearth on another PC? Link to it instead
      </Button>
    </AuthFrame>
  );
}
