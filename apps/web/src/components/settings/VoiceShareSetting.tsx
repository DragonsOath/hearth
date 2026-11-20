import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "../ui";
import { api } from "../../data/api";
import { useAddresses } from "../../data/devices";

interface ShareState {
  on: boolean;
  port: number;
  listening: boolean;
  problem: string | null;
  voice: string;
}

/** The host Home Assistant should use: this Hearth's home-network address, when known. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Hearth's Standard voice in Home Assistant: Hearth offers it the way a Piper speech server does
 * (Wyoming), so it shows up in Home Assistant's voice choices.
 */
export function VoiceShareSetting({ ready }: { ready: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["voice-share"],
    queryFn: () => api<ShareState>("GET", "/api/voice/share"),
  });
  const set = useMutation({
    mutationFn: (on: boolean) => api<ShareState>("PUT", "/api/voice/share", { on }),
    onSuccess: (s) => qc.setQueryData(["voice-share"], s),
  });
  const addresses = useAddresses().data?.addresses ?? [];
  const host = hostOf(addresses.find((a) => a.kind === "home")?.url) ?? "this computer's address";
  const s = q.data;
  if (!s) return null;
  return (
    <div className="mb-6 rounded-xl border border-line p-4" data-testid="voice-share">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-[0.95rem] text-ink">Use this voice in Home Assistant</p>
          <p className="text-[0.82rem] leading-relaxed text-muted">
            Home Assistant can speak with Hearth&apos;s Standard voice, like any other voice it has.
            It only receives the words to say.
          </p>
        </div>
        <Switch
          checked={s.on}
          onChange={(on) => set.mutate(on)}
          label="Use this voice in Home Assistant"
        />
      </div>
      {s.on && s.listening && (
        <div
          className="mt-3 text-[0.82rem] leading-relaxed text-muted"
          data-testid="voice-share-steps"
        >
          <p className="mb-1 text-ink">In Home Assistant:</p>
          <ol className="list-decimal space-y-0.5 pl-5">
            <li>Settings, Devices &amp; services, Add integration, Wyoming Protocol.</li>
            <li>
              Host <span className="font-mono text-ink">{host}</span>, port{" "}
              <span className="font-mono text-ink">{s.port}</span>.
            </li>
            <li>
              Settings, Voice assistants: pick an assistant, and under Text-to-speech choose Hearth.
            </li>
          </ol>
          {!ready && (
            <p className="mt-2 text-amber">
              The Standard voice is still getting ready here; Home Assistant can use it once it is.
            </p>
          )}
        </div>
      )}
      {s.on && s.problem && (
        <p role="alert" className="mt-3 text-[0.82rem] text-bad">
          {s.problem}
        </p>
      )}
      {set.error && (
        <p role="alert" className="mt-3 text-[0.82rem] text-bad">
          {set.error instanceof Error ? set.error.message : String(set.error)}
        </p>
      )}
    </div>
  );
}
