import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Mic, Volume2 } from "lucide-react";
import type { SpeechFound, VoiceStatus } from "@dragon-control/core";
import { Button, Tag } from "../ui";
import { FormError } from "../../pages/auth/AuthFrame";
import {
  useFindSpeech,
  useInstallVoice,
  usePrepareBuiltinVoice,
  useUseSpeech,
  useVoiceSetup,
} from "../../data/voice";

/**
 * Voice, set up from here when it can't be heard yet. Hearth looks for speech services by itself
 * (this computer and the home network) and offers the ones it finds; when there is none, it sets
 * voice up on this computer with one button and shows the progress. Nobody needs to know what
 * Piper or Whisper are, or type an address.
 */
export function VoiceSetupNote({ status, aiName }: { status: VoiceStatus; aiName: string }) {
  return status.engine === "builtin" ? (
    <BuiltinVoiceNote status={status} aiName={aiName} />
  ) : (
    <MachineVoiceNote status={status} aiName={aiName} />
  );
}

/**
 * Standard voice: nothing to set up. The first time voice is needed it downloads once, by
 * itself, and this shows how far along it is; once ready, nothing is shown.
 */
function BuiltinVoiceNote({ status, aiName }: { status: VoiceStatus; aiName: string }) {
  const prepare = usePrepareBuiltinVoice();
  const b = status.builtin;
  const started = useRef(false);
  const start = prepare.mutate;
  useEffect(() => {
    if (b.state !== "missing" || started.current) return;
    started.current = true;
    start();
  }, [b.state, start]);
  if (b.state === "ready") return null;
  return (
    <div
      className="mb-6 rounded-xl border border-gold/50 bg-gold/5 p-4 text-[0.86rem] leading-relaxed text-muted"
      data-testid="voice-builtin-note"
    >
      {b.state === "failed" ? (
        <>
          <p className="mb-1 font-medium text-ink">
            {aiName}&apos;s voice didn&apos;t finish getting ready
          </p>
          <p className="mb-3">{b.error}</p>
          <Button onClick={() => prepare.mutate()} disabled={prepare.isPending}>
            Try again
          </Button>
        </>
      ) : (
        <>
          <p className="mb-1 flex items-center gap-2 font-medium text-ink">
            <Loader2 strokeWidth={1.5} className="h-4 w-4 animate-spin text-gold" />
            Getting {aiName}&apos;s voice ready
          </p>
          <p className="mb-2">
            This happens once: Hearth downloads its built-in voice (about {b.sizeMb} MB). You can
            choose a voice now and leave this page; it carries on.
          </p>
          <div
            role="progressbar"
            aria-label="Getting the voice ready"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={b.percent ?? 0}
            className="h-1.5 w-full overflow-hidden rounded-full bg-line"
          >
            <div
              className="h-full rounded-full bg-gold transition-[width] duration-500"
              style={{ width: `${b.percent ?? 0}%` }}
            />
          </div>
          {b.step && <p className="mt-1.5 text-[0.78rem] text-faint">{b.step}…</p>}
        </>
      )}
    </div>
  );
}

function MachineVoiceNote({ status, aiName }: { status: VoiceStatus; aiName: string }) {
  const missing = status.profiles.filter((p) => !status.tts.voices.includes(p.voice)).length;
  const ready = status.configured && status.tts.ok && missing === 0;
  const setup = useVoiceSetup(!ready);
  const find = useFindSpeech();
  const use = useUseSpeech();
  const install = useInstallVoice();
  const qc = useQueryClient();
  const looked = useRef(false);
  const job = setup.data?.install;

  // Look as soon as voice is needed: nothing to press first.
  const findMutate = find.mutate;
  useEffect(() => {
    if (ready || looked.current) return;
    looked.current = true;
    findMutate();
  }, [ready, findMutate]);

  // An install that finished: voice is now pointed at this computer.
  useEffect(() => {
    if (job?.status === "done") void qc.invalidateQueries({ queryKey: ["voice"] });
  }, [job?.status, qc]);

  if (ready) return null;

  const heading = !status.configured
    ? "Set up voice"
    : !status.tts.ok
      ? "The speech service isn't answering"
      : "Some voices aren't on the speech service yet";
  const found = (find.data?.found ?? []).filter((f) => f.tts || f.stt);
  const machine = setup.data?.machine;
  const canInstall = Boolean(setup.data?.docker && machine && machine.level !== "none");
  const running = job?.status === "running";

  return (
    <div
      className="mb-6 space-y-4 rounded-xl border border-gold/50 bg-gold/5 p-4 text-[0.86rem] leading-relaxed text-muted"
      data-testid="voice-setup-note"
    >
      <div>
        <p className="mb-1 font-medium text-ink">{heading}</p>
        <p>
          {aiName} speaks and listens through two small speech programs. Hearth can use ones already
          running at home, or set them up on this computer for you. Until then, voice previews
          can&apos;t play.
        </p>
      </div>

      {running && job && (
        <div
          className="flex gap-3 rounded-lg border border-line p-3"
          data-testid="voice-install-progress"
        >
          <Loader2 strokeWidth={1.5} className="h-5 w-5 shrink-0 animate-spin text-gold" />
          <div>
            <p className="text-ink">{job.step}…</p>
            <p className="text-[0.8rem]">{job.detail}</p>
            <p className="mt-1 text-[0.76rem] text-faint">
              You can leave this page; it carries on.
            </p>
          </div>
        </div>
      )}
      {job?.status === "failed" && (
        <p className="text-bad" role="alert" data-testid="voice-install-failed">
          {job.step} didn&apos;t finish: {job.detail}
        </p>
      )}
      {job?.status === "done" && (
        <p className="flex items-center gap-2 text-ink" data-testid="voice-install-done">
          <CheckCircle2 strokeWidth={1.5} className="h-5 w-5 text-live" /> {job.detail}
        </p>
      )}

      {!running && (
        <>
          <section>
            <p className="mb-2 text-ink">Speech services Hearth found</p>
            {find.isPending ? (
              <p className="flex items-center gap-2" data-testid="voice-finding">
                <Loader2 strokeWidth={1.5} className="h-4 w-4 animate-spin" />
                Looking on this computer and your home network…
              </p>
            ) : found.length ? (
              <ul className="space-y-2" data-testid="voice-found">
                {found.map((f) => (
                  <FoundRow
                    key={f.host}
                    f={f}
                    current={status.host === f.host}
                    busy={use.isPending}
                    onUse={() => use.mutate(f.host)}
                  />
                ))}
              </ul>
            ) : find.isSuccess ? (
              <p data-testid="voice-none-found">None on this computer or your home network.</p>
            ) : null}
            {!find.isPending && (
              <Button tone="quiet" className="mt-2" onClick={() => find.mutate()}>
                Look again
              </Button>
            )}
          </section>

          <section className="border-t border-line pt-4">
            <p className="mb-1 text-ink">Or set up voice on this computer</p>
            {canInstall ? (
              <>
                <p>
                  Hearth downloads its five voices (about 320 MB) and starts the two speech programs
                  in Docker (about 1.5 GB more), then switches voice on. It takes a few minutes and
                  changes nothing else on this computer.
                  {machine && <> This computer: {machine.summary}</>}
                </p>
                <Button
                  tone={found.length ? "outline" : "primary"}
                  className="mt-3"
                  disabled={install.isPending}
                  onClick={() => install.mutate()}
                  data-testid="voice-install"
                >
                  {job?.status === "failed" ? "Try again" : "Set up voice on this computer"}
                </Button>
              </>
            ) : machine && machine.level === "none" ? (
              <p>
                This computer can&apos;t run voice ({machine.short.join("; ") || machine.summary}).
                Use a speech service on another computer at home instead.
              </p>
            ) : setup.data && !setup.data.docker ? (
              <p>
                This computer doesn&apos;t have Docker, which voice needs to run here. Use a speech
                service on another computer at home instead.
              </p>
            ) : (
              <p>Checking what this computer can run…</p>
            )}
          </section>
        </>
      )}
      <FormError error={find.error ?? use.error ?? install.error ?? setup.error} />
    </div>
  );
}

function FoundRow({
  f,
  current,
  busy,
  onUse,
}: {
  f: SpeechFound;
  current: boolean;
  busy: boolean;
  onUse: () => void;
}) {
  const where = f.host === "127.0.0.1" ? "This computer" : (f.name ?? f.host);
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
      <div className="min-w-0 flex-1">
        <p className="text-ink">
          {where}
          {f.name && f.host !== "127.0.0.1" && (
            <span className="text-[0.78rem] text-faint"> ({f.host})</span>
          )}
        </p>
        <p className="flex flex-wrap gap-x-3 text-[0.8rem]">
          <span className="inline-flex items-center gap-1">
            <Volume2 strokeWidth={1.5} className="h-3.5 w-3.5" />
            {f.tts
              ? `Speaks: ${f.tts.voices} voices${f.tts.hearthVoices ? `, ${f.tts.hearthVoices} of Hearth's five` : ""}`
              : "Doesn't speak"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Mic strokeWidth={1.5} className="h-3.5 w-3.5" />
            {f.stt ? "Listens" : "Doesn't listen"}
          </span>
        </p>
      </div>
      {current ? (
        <Tag tone="neutral">In use</Tag>
      ) : (
        <Button tone="primary" disabled={busy} onClick={onUse} data-testid={`voice-use-${f.host}`}>
          Use this
        </Button>
      )}
    </li>
  );
}
