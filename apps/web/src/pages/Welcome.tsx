import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePcs } from "../data/pcs";
import { PcEditor } from "../components/devices/Pcs";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AI_AVATAR_PATH,
  AI_NAME_PATTERN,
  ARCHETYPES,
  currentLook,
  aiDisplayName,
  DEFAULT_AI_NAME,
  type VoiceConfig,
  type VoiceProfile,
  type VoiceStatus,
} from "@dragon-control/core";
import { useUpdateSettings, useWorkspace } from "../data/api";
import {
  speaker,
  useChooseAiLook,
  useSaveVoice,
  useSpeaker,
  useVoice,
  voiceConfigOf as configOf,
} from "../data/voice";
import { useSavedTheme } from "../components/AppShell";
import { NameField } from "../components/settings/NameField";
import { OwnerAvatarField } from "../components/shell/OwnerAvatar";
import { AiNameField, PersonalityControls } from "../components/settings/AiStyle";
import { ThemePicker } from "../components/settings/ThemePicker";
import { AiPictureUpload, LookPicker, avatarSrc, lookFit } from "../components/settings/LookPicker";
import { Button, Wordmark, cx } from "../components/ui";
import { FormError } from "./auth/AuthFrame";
import { MeetButton } from "../components/GettingStarted";
import { VoiceSetupNote } from "../components/settings/VoiceSetupNote";
import { EngineChoice } from "./VoiceSettings";
import { ConnectAiStep, aiConnected } from "../components/onboarding/ConnectAi";
import { OnboardingStages, type OnboardingStage } from "../components/onboarding/Stages";

/**
 * The first-run welcome, after the owner creates the account: connecting Ember's AI, then
 * "Make it yours" (seven short steps), then a finish. Also from Settings. Every step saves
 * through the same settings the Settings page uses, as it goes, so leaving halfway keeps what
 * was chosen, and the step reached is saved too, so a closed browser resumes there. Finishing or
 * skipping marks it done, and it is not offered again. Steps are named, so a new one (connecting
 * your homelab's services, say) is one more entry in STEPS.
 */

/**
 * Each built-in character introducing itself, in its own voice: what "Hear it" plays, and the
 * line under its name. Personality only: every one has the same tools, rules, and approvals.
 */
const VOICE_LINES: Record<string, string> = {
  warden:
    "I have kept watch over a great many hoards. Yours will be no different: calm, careful, and nothing changes without your word.",
  operator:
    "Situation first, then the plan, then the details. I'll keep your systems running and tell you exactly when something needs you.",
  enchantress:
    "Ah, a new adventure. We'll puzzle it out together, and I'll make the tricky bits feel like a bit of fun.",
  scholar:
    "Every problem has a reason, and I do so enjoy finding it. I'll explain the why, gently, and suggest the careful next step.",
  companion:
    "Hello! Companion unit online. I give short, cheerful status reports, and I only press the buttons you approve.",
};

const STEPS = [
  { id: "ai", stage: "ai", label: "Connect your AI" },
  { id: "hello", stage: "yours", label: "Hello" },
  { id: "you", stage: "yours", label: "You" },
  { id: "pc", stage: "yours", label: "This PC" },
  { id: "name", stage: "yours", label: "Your AI's name" },
  { id: "voice", stage: "yours", label: "Its voice" },
  { id: "look", stage: "yours", label: "Its look" },
  { id: "personality", stage: "yours", label: "Personality" },
  { id: "theme", stage: "yours", label: "Theme" },
] as const satisfies readonly { id: string; stage: OnboardingStage; label: string }[];
type StepId = (typeof STEPS)[number]["id"];
/** "Make it yours": counted on its own ("Step 4 of 7: Its voice"). */
const YOURS = STEPS.filter((s) => s.stage === "yours");
const isStep = (v: string | null | undefined): v is StepId => STEPS.some((s) => s.id === v);
/** Older links and saved places used numbers for the "Make it yours" steps. */
const fromNumber = (v: string | null) => YOURS[Number(v) - 1]?.id;

const SAMPLE = "Hello. I have checked your systems, and everything is running. I will keep watch.";

/** Saves a voice change (a saved name is never changed by it; the server sees to that). */
function useApplyVoice() {
  const save = useSaveVoice();
  const apply = (next: VoiceConfig) => save.mutateAsync(next);
  return { apply, error: save.error, pending: save.isPending };
}

function Lead({ children }: { children: ReactNode }) {
  return <p className="mb-6 text-[0.92rem] leading-relaxed text-muted">{children}</p>;
}

/** The first choice: help building a first homelab, or an existing one. Both continue here. */
function HelloStep({ onPick }: { onPick: (journey: "build" | "existing") => void }) {
  const ws = useWorkspace();
  const picked = ws.data?.journey;
  const card = (journey: "build" | "existing", title: string, line: string) => (
    <button
      type="button"
      onClick={() => onPick(journey)}
      aria-pressed={picked === journey}
      className={cx(
        "flex min-h-24 w-full flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors",
        picked === journey ? "border-gold bg-gold/10" : "border-line-strong hover:border-gold/60",
      )}
      data-testid={`welcome-path-${journey}`}
    >
      <span className="text-[1.05rem] text-ink">{title}</span>
      <span className="text-[0.85rem] leading-relaxed text-muted">{line}</span>
    </button>
  );
  return (
    <>
      <Lead>
        Tell me what you&apos;d like to build, and I&apos;ll help you plan it. First, where are you
        starting from?
      </Lead>
      <div className="grid gap-3 sm:grid-cols-2">
        {card(
          "build",
          "Help me build my first homelab",
          "New to this? Pick an AI companion, say what you'd love to do, and get a plan that suits your computer. No experience needed.",
        )}
        {card(
          "existing",
          "I already have a homelab",
          "Already run apps like Plex or Radarr? Hearth finds them and helps you look after them.",
        )}
      </div>
      <p className="mt-4 text-[0.8rem] text-faint">
        Hearth is free. You bring your own AI (Ollama is free and runs at home) and, for automatic
        downloads, your own VPN.
      </p>
      <p className="mt-2 text-[0.8rem] text-faint">
        Either way, you can stop any time and pick up where you left off.
      </p>
    </>
  );
}

function YouStep() {
  const ws = useWorkspace();
  return (
    <>
      <Lead>
        Both are optional. Your AI uses your name when it talks to you; leave it empty and it says
        &ldquo;you&rdquo;.
      </Lead>
      <div className="mb-6 max-w-sm">
        <NameField
          current={ws.data?.ownerName ?? ""}
          field="ownerName"
          label="Your name"
          placeholder="Optional"
          showLabel
        />
      </div>
      <p className="mb-2 text-[0.85rem] text-ink">Your picture</p>
      <div className="flex">
        <OwnerAvatarField />
      </div>
    </>
  );
}

/** This PC's name and icon: they mark its projects and systems everywhere, on every device. */
function PcStep() {
  const pcs = usePcs();
  const data = pcs.data;
  if (!data) return <p className="text-muted">Loading…</p>;
  if (data.joinedTo)
    return (
      <Lead>
        This PC belongs to the Hearth on {data.joinedTo.name}; its name and icon are set there.
      </Lead>
    );
  return (
    <>
      <Lead>
        Name this PC and pick its icon. They mark its projects in the War Room and its systems
        everywhere, so when you add more PCs you can tell at a glance which one each is on.
      </Lead>
      <PcEditor
        bare
        pc={{ ...data.hub, online: true }}
        others={data.pcs}
        title=""
        onDone={() => undefined}
      />
    </>
  );
}

function NameStep({ placeholder, onValue }: { placeholder: string; onValue: (v: string) => void }) {
  return (
    <>
      <Lead>
        Give your AI administrator a name, or leave it empty and it is called {placeholder}. You can
        change it any time in Settings; only the name changes, never what it may do.
      </Lead>
      <AiNameField placeholder={placeholder} onValueChange={onValue} />
    </>
  );
}

function VoiceLoading({ status }: { status: ReturnType<typeof useVoice> }) {
  if (status.isPending)
    return <p className="text-[0.9rem] text-muted">Checking the speech machine…</p>;
  return <FormError error={status.error} />;
}

function LookStep() {
  const status = useVoice();
  const look = useChooseAiLook();
  // Shown as chosen straight away, while it saves.
  const [picked, setPicked] = useState<string | null>(null);
  if (!status.data) return <VoiceLoading status={status} />;
  const error = look.error;
  const pending = look.pending;
  const active = { avatar: look.current };
  // The look goes on the voice chosen in the step before; with none chosen, on the look's own
  // archetype's voice.
  const choose = (path: string) => {
    setPicked(path);
    look.choose(path).catch(() => setPicked(null));
  };
  return (
    <>
      <Lead>
        Pick a picture for your AI. It appears beside its name everywhere. Any picture goes with any
        voice.
      </Lead>
      <LookPicker value={picked ?? active?.avatar} onPick={choose} disabled={pending} />
      <div className="mt-6 border-t border-line pt-5">
        <p className="mb-2 text-[0.85rem] text-ink">Or use a picture of your own</p>
        <AiPictureUpload onChosen={() => choose(AI_AVATAR_PATH)} />
      </div>
      <FormError error={error} />
    </>
  );
}

/** Why a voice cannot be heard here, or nothing when it can. */
function previewBlocked(s: VoiceStatus, p: VoiceProfile): string | undefined {
  if (s.engine === "builtin")
    return s.builtin.state === "ready"
      ? undefined
      : "The voice is getting ready (above). You can choose now.";
  if (!s.configured)
    return "To hear it, set up voice above (it takes a click). You can choose now.";
  if (!s.tts.ok) return "To hear it, fix the speech service above. You can choose now.";
  if (!s.tts.voices.includes(p.voice))
    return "This voice isn't on the speech service yet: set up voice above to add it. You can choose now.";
  return undefined;
}

function VoiceStep() {
  const ws = useWorkspace();
  const status = useVoice();
  const speaking = useSpeaker();
  const [playing, setPlaying] = useState<string | null>(null);
  // Shown as chosen straight away, while it saves.
  const [picked, setPicked] = useState<string | null>(null);
  const { apply, error, pending } = useApplyVoice();
  useEffect(() => () => speaker.stop(), []);
  if (!status.data) return <VoiceLoading status={status} />;
  const s = status.data;
  const aiName = aiDisplayName(ws.data?.aiName);
  // Both choices, explained: Standard (built in, recommended) or Advanced (a speech machine).
  const choice = (
    <EngineChoice
      status={s}
      busy={pending}
      welcome
      aiName={aiName}
      onChoose={(engine) => void apply({ ...configOf(s), engine }).catch(() => undefined)}
    />
  );
  if (s.engine === "builtin")
    return (
      <>
        <Lead>
          {aiName} can talk to you, and you can talk back. Pick how its voice works. You can change
          this any time.
        </Lead>
        {choice}
        <VoiceSetupNote status={s} aiName={aiName} />
      </>
    );
  const offered = ARCHETYPES.flatMap((a) => {
    const p = s.profiles.find((x) => x.id === a.profileId);
    return p ? [{ a, p }] : [];
  });
  const choose = (p: VoiceProfile) => {
    setPicked(p.id);
    if (p.id === s.active) return;
    // Each voice keeps its own look; the next step picks one (any look goes with any voice).
    apply({ ...configOf(s), active: p.id }).catch(() => setPicked(null));
  };
  return (
    <>
      {choice}
      <Lead>
        Each character has its own voice and way of talking. Underneath, they&apos;re all equally
        capable and follow exactly the same rules. Press &ldquo;Hear&rdquo; to meet one.
      </Lead>
      <VoiceSetupNote status={s} aiName={aiName} />
      <ul className="space-y-3" data-testid="welcome-voices">
        {offered.map(({ a, p }) => {
          const on = (picked ?? s.active) === p.id;
          const blocked = previewBlocked(s, p);
          const radio = `voice-${p.id}`;
          return (
            <li
              key={p.id}
              className={cx(
                "rounded-xl border p-3 sm:p-4",
                on ? "border-gold bg-gold/10" : "border-line",
              )}
              data-testid="welcome-voice"
            >
              <div className="flex items-start gap-3">
                <img
                  src={avatarSrc(currentLook(p.avatar), ws.data?.aiAvatarAt)}
                  alt=""
                  width={56}
                  height={56}
                  className={`h-14 w-14 shrink-0 ${lookFit(currentLook(p.avatar))}`}
                />
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={radio}
                    className="flex min-h-11 cursor-pointer items-center gap-2"
                  >
                    <input
                      id={radio}
                      type="radio"
                      name="welcome-voice"
                      checked={on}
                      disabled={pending}
                      onChange={() => choose(p)}
                      className="h-4 w-4 accent-[var(--color-gold)]"
                    />
                    <span className="text-[0.95rem] text-ink">
                      {a.label}
                      {p.name !== a.label && <span className="text-muted"> ({p.name})</span>}
                    </span>
                  </label>
                  <p className="text-[0.82rem] leading-relaxed text-muted italic">
                    &ldquo;{VOICE_LINES[p.id]}&rdquo;
                  </p>
                  {p.effect === "voicebox" && (
                    <p className="mt-1 text-[0.78rem] text-faint">Speaks through its voice box.</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      disabled={Boolean(blocked) || speaking.status !== "idle"}
                      aria-describedby={blocked ? `${radio}-why` : undefined}
                      onClick={() => {
                        setPlaying(p.id);
                        void speaker.say(VOICE_LINES[p.id] ?? SAMPLE, p.id);
                      }}
                    >
                      {playing === p.id && speaking.status === "loading"
                        ? "Getting it…"
                        : playing === p.id && speaking.status === "playing"
                          ? "Playing…"
                          : `Hear ${a.label}`}
                    </Button>
                    {playing === p.id && speaking.status === "playing" && (
                      <Button tone="quiet" onClick={() => speaker.stop()}>
                        Stop
                      </Button>
                    )}
                  </div>
                  {blocked && (
                    <p id={`${radio}-why`} className="mt-1.5 text-[0.78rem] text-faint">
                      {blocked}
                    </p>
                  )}
                  {playing === p.id && speaking.error && (
                    <p role="alert" className="mt-1.5 text-[0.78rem] text-bad">
                      {speaking.error}
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <FormError error={error} />
    </>
  );
}

function PersonalityStep() {
  return (
    <>
      <Lead>
        Personality changes how your AI talks, never what it may do: its permissions and your
        approvals stay exactly the same, whatever you pick.
      </Lead>
      <PersonalityControls />
    </>
  );
}

function Finished({
  onOpen,
  beforeMeet,
  busy,
}: {
  onOpen: (to?: string) => void;
  beforeMeet: () => Promise<void>;
  busy: boolean;
}) {
  const ws = useWorkspace();
  const name = aiDisplayName(ws.data?.aiName);
  const building = ws.data?.journey !== "existing";
  const connected = aiConnected(ws.data);
  const service = ws.data?.agents.find((a) => a.id === ws.data?.operator.agentId)?.name;
  return (
    <>
      <p
        className={cx(
          "mb-4 rounded-xl border p-3 text-[0.88rem]",
          connected ? "border-live/40 text-ink" : "border-line-strong text-muted",
        )}
        data-testid="welcome-ai-status"
      >
        {connected
          ? `${name} is connected to ${service ?? "its AI service"}.`
          : `${name} is waiting for an AI service. Everything else in Hearth works without one, and you can connect it any time from the AI Agent page.`}
      </p>
      <Lead>
        Everything you chose is saved, and you can change any of it in Settings.{" "}
        {building
          ? `When you're ready, tell ${name} what you'd love to do, and it works out a plan that suits your computer.`
          : `When you're ready, ${name} finds what already runs on this computer${connected ? ", or introduces itself and checks up on your server" : ""}.`}
      </Lead>
      <div className="flex flex-wrap items-start gap-3" data-testid="welcome-paths">
        {/* A beginner came to build: that is the bright button (11-20 blind test). */}
        {building ? (
          <>
            <Button tone="primary" disabled={busy} onClick={() => onOpen("/plan")}>
              Build my setup
            </Button>
            <Button tone="outline" disabled={busy} onClick={() => onOpen()}>
              Enter Hearth
            </Button>
          </>
        ) : (
          <>
            <Button tone="primary" disabled={busy} onClick={() => onOpen()}>
              Enter Hearth
            </Button>
            <Button tone="outline" disabled={busy} onClick={() => onOpen("/discover")}>
              Find what I already run
            </Button>
          </>
        )}
        {connected && <MeetButton before={beforeMeet} tone="outline" />}
      </div>
      <p className="mt-5 text-[0.82rem] text-faint">
        {building ? "Already run apps after all? " : "New to this after all? "}
        <button
          type="button"
          className="text-gold underline underline-offset-2"
          disabled={busy}
          onClick={() => onOpen(building ? "/discover" : "/plan")}
        >
          {building ? "Find what I already run" : "Build my setup"}
        </button>
      </p>
    </>
  );
}

export function WelcomePage() {
  useSavedTheme();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const settings = useUpdateSettings();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const raw = params.get("step");
  const done = raw === "done";
  // Where to be: the step in the address, an old numbered one, else where an unfinished welcome
  // was left (the server forgets that once it is finished or skipped), else the start.
  const id: StepId = isStep(raw)
    ? raw
    : (fromNumber(raw) ?? (isStep(ws.data?.onboardingStep) ? ws.data.onboardingStep : "ai"));
  const index = STEPS.findIndex((s) => s.id === id);
  const current = STEPS[index]!;
  const yoursAt = YOURS.findIndex((s) => s.id === id);
  const heading = useRef<HTMLHeadingElement>(null);
  const [aiName, setAiName] = useState<string | null>(null);
  const markDone = settings.mutateAsync;
  const saveStep = settings.mutate;
  const savedStep = ws.data?.onboardingStep;
  const finished = Boolean(ws.data?.onboardingDoneAt);

  // Each step starts with its heading, so a screen reader announces where you are.
  useEffect(() => heading.current?.focus(), [id, done]);
  // Reaching the end counts as done, even if this tab is closed now.
  useEffect(() => {
    if (done && !finished && ws.data) void markDone({ onboardingDone: true });
  }, [done, finished, ws.data, markDone]);
  // The step reached is saved, so closing the browser resumes here (until finished).
  useEffect(() => {
    if (ws.data && !done && !finished && savedStep !== id) saveStep({ onboardingStep: id });
  }, [ws.data, done, finished, savedStep, id, saveStep]);

  if (!ws.data) return <div className="min-h-dvh bg-bg" aria-busy="true" />;

  // Until a name is typed, the AI is called Ember, whichever voice or look is chosen.
  const placeholder = DEFAULT_AI_NAME;
  const go = (next: StepId | "done") => setParams({ step: next });
  const nextOf = (from: number): StepId | "done" => STEPS[from + 1]?.id ?? "done";

  const next = async () => {
    // The name step: a typed name is kept; an empty box keeps Ember.
    if (id === "name" && aiName !== null) {
      const typed = aiName.trim();
      if (typed && AI_NAME_PATTERN.test(typed) && typed !== ws.data?.aiName)
        await settings.mutateAsync({ aiName: typed });
    }
    go(nextOf(index));
  };
  // The app only opens once the workspace knows the welcome is done (it would send you back).
  const finish = async () => {
    await markDone({ onboardingDone: true });
    await queryClient.invalidateQueries({ queryKey: ["workspace"] });
  };
  const leave = async (to = "/") => {
    await finish();
    navigate(to, { replace: true });
  };

  const name = aiDisplayName(ws.data.aiName);
  const titles: Record<StepId, string> = {
    ai: `Connect ${name}'s AI`,
    hello: "Welcome to Hearth",
    you: "Let's start with you",
    pc: "This PC",
    name: "Your AI's name",
    voice: `${name}'s voice`,
    look: `${name}'s look`,
    personality: "Personality",
    theme: "Theme",
  };
  const title = done ? "All set" : titles[id];
  const stage: OnboardingStage = done ? "finish" : current.stage;
  const connected = aiConnected(ws.data);

  return (
    <main id="main" className="min-h-dvh bg-bg px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Wordmark />
          {!done && (
            <Button tone="quiet" disabled={settings.isPending} onClick={() => void leave()}>
              Skip setup
            </Button>
          )}
        </div>

        <OnboardingStages current={stage} className="mb-6" />
        <p className="eyebrow mb-2">
          {stage === "ai" ? "Connect your AI" : stage === "finish" ? "Finish" : "Make it yours"}
        </p>
        {!done && stage === "yours" && (
          <div className="mb-6">
            <p className="mb-2 text-[0.82rem] text-muted" data-testid="welcome-progress">
              Step {yoursAt + 1} of {YOURS.length}: {current.label}
            </p>
            <div
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin={1}
              aria-valuemax={YOURS.length}
              aria-valuenow={yoursAt + 1}
              aria-valuetext={`Step ${yoursAt + 1} of ${YOURS.length}`}
              className="h-1.5 w-full overflow-hidden rounded-full bg-line"
            >
              <div
                className="h-full rounded-full bg-gold transition-[width] duration-300"
                style={{ width: `${((yoursAt + 1) / YOURS.length) * 100}%` }}
              />
            </div>
          </div>
        )}

        <section className="rounded-2xl border border-line bg-panel p-5 sm:p-8">
          <h1
            ref={heading}
            tabIndex={-1}
            className="mb-4 font-display text-[1.9rem] leading-tight text-ink focus:outline-none sm:text-[2.2rem]"
          >
            {title}
          </h1>
          {done ? (
            <Finished
              busy={settings.isPending}
              onOpen={(to) => void leave(to)}
              beforeMeet={finish}
            />
          ) : id === "ai" ? (
            <ConnectAiStep />
          ) : id === "hello" ? (
            <HelloStep
              onPick={(journey) => void settings.mutateAsync({ journey }).then(() => go("you"))}
            />
          ) : id === "you" ? (
            <YouStep />
          ) : id === "pc" ? (
            <PcStep />
          ) : id === "name" ? (
            <NameStep placeholder={placeholder} onValue={setAiName} />
          ) : id === "voice" ? (
            <VoiceStep />
          ) : id === "look" ? (
            <LookStep />
          ) : id === "personality" ? (
            <PersonalityStep />
          ) : (
            <ThemePicker bare />
          )}
          <FormError error={settings.error} />
        </section>

        {!done && (
          <nav aria-label="Setup steps" className="mt-6 flex items-center justify-between gap-3">
            <Button disabled={index === 0} onClick={() => go(STEPS[index - 1]!.id)}>
              Back
            </Button>
            {id === "ai" ? (
              <div className="flex flex-wrap items-center justify-end gap-3">
                {!connected && (
                  <Button tone="quiet" onClick={() => go(nextOf(index))} data-testid="ai-skip">
                    Skip for now
                  </Button>
                )}
                <Button
                  tone="primary"
                  disabled={!connected}
                  title={connected ? undefined : "Connect an AI service, or skip for now"}
                  onClick={() => go(nextOf(index))}
                >
                  Next
                </Button>
              </div>
            ) : (
              <Button tone="primary" disabled={settings.isPending} onClick={() => void next()}>
                {index === STEPS.length - 1 ? "Finish" : "Next"}
              </Button>
            )}
          </nav>
        )}
      </div>
    </main>
  );
}
