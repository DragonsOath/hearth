import { useState } from "react";
import { useOllama, usePrepareOllama, useSaveOllama, type OllamaModel } from "../../data/ollama";
import { Button, Tag } from "../ui";
import { FormError } from "../../pages/auth/AuthFrame";

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

function state(m: OllamaModel): { tone: "gold" | "warn" | "neutral"; text: string } {
  if (!m.tools) return { tone: "neutral", text: "Can't use tools" };
  if (!m.contextOk) return { tone: "warn", text: "Needs a Hearth copy" };
  return { tone: "neutral", text: "Ready" };
}

/**
 * Settings, Ember, Ollama (and the Lair's AI choice): where Ollama is and which model Hearth uses.
 * Ollama runs through Claude Code, so it gets the same tools, Full access and memory; only the
 * model is local and free. A model whose memory window is too small gets a copy with a bigger
 * one, made in Ollama by Hearth: the original model and Ollama's own settings stay as they were.
 */
export function OllamaSetting() {
  // Undefined until the owner types: the saved address shows meanwhile.
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const [checked, setChecked] = useState<string | undefined>(undefined);
  const status = useOllama(checked);
  const save = useSaveOllama();
  const prepare = usePrepareOllama();
  const data = status.data;

  if (status.isError && !data)
    return (
      <p className="text-[0.88rem] text-faint">
        Available when the War Room is set up on this computer.
      </p>
    );

  const address = typed ?? data?.url ?? "";
  const url = address.trim() || data?.url || "";
  const busy = save.isPending || prepare.isPending;
  return (
    <div className="space-y-4" data-testid="ollama-setting">
      <p className="text-[0.84rem] leading-relaxed text-muted">
        Free AI on your own hardware. Hearth runs the same Claude Code with an Ollama model as its
        brain, so it has the same tools, asking rules, guide and memory as Claude Code, in the War
        Room and the Lair. No Claude account or plan is used. It is slower, depending on your
        graphics card and memory, and smaller models make more mistakes.
      </p>
      <form
        className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setChecked(url);
        }}
      >
        <div>
          <label htmlFor="ollama-url" className="mb-1 block text-[0.82rem] text-muted">
            Ollama address (this computer, or another one on your network)
          </label>
          <input
            id="ollama-url"
            value={address}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Address and port"
            className={field}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button type="submit" disabled={status.isFetching}>
          {status.isFetching ? "Checking…" : "Check"}
        </Button>
      </form>

      {data && !data.reachable && (
        <p role="alert" className="text-[0.84rem] text-bad" data-testid="ollama-problem">
          {data.problem}
        </p>
      )}
      {data?.reachable && (
        <div className="space-y-3">
          <p className="text-[0.84rem] text-muted" data-testid="ollama-found">
            Ollama {data.version} found. {data.problem ?? "Choose the model Hearth uses."}
            {data.model ? (
              <>
                {" "}
                Using <span className="text-ink">{data.model}</span>.
              </>
            ) : null}
          </p>
          <ul className="grid gap-2">
            {data.models.map((m) => {
              const st = state(m);
              const inUse = m.name === data.model;
              return (
                <li
                  key={m.name}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3"
                  data-testid="ollama-model"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[0.9rem] text-ink">
                      <span className="break-all">{m.name}</span>
                      <Tag tone={inUse ? "gold" : st.tone}>{inUse ? "In use" : st.text}</Tag>
                    </p>
                    <p className="mt-0.5 text-[0.78rem] text-faint">
                      {m.sizeGb} GB
                      {m.context
                        ? ` · memory window ${Math.round(m.context / 1024)}k`
                        : " · Ollama's default memory window"}
                      {!m.tools ? " · it can only talk, not act" : ""}
                    </p>
                  </div>
                  {!inUse && m.tools && m.contextOk && (
                    <Button
                      disabled={busy}
                      onClick={() => save.mutate({ url: data.url, model: m.name })}
                    >
                      Use this model
                    </Button>
                  )}
                  {!inUse && m.tools && !m.contextOk && (
                    <Button
                      disabled={busy}
                      onClick={() => prepare.mutate(m.name)}
                      title="Makes a copy of this model in Ollama with a 32k memory window, which Claude Code needs. The original model and Ollama's settings are not changed, and nothing is downloaded."
                    >
                      {prepare.isPending && prepare.variables === m.name
                        ? "Making the copy…"
                        : "Make a Hearth copy and use it"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {data.model && (
            <Button
              disabled={busy}
              onClick={() => save.mutate({ url: data.url, model: null })}
              data-testid="ollama-stop"
            >
              Stop using Ollama
            </Button>
          )}
        </div>
      )}
      <FormError error={save.error ?? prepare.error} />
    </div>
  );
}
