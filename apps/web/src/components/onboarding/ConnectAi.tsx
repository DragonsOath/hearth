import { useState } from "react";
import { CheckCircle2, CircleDashed, ExternalLink, XCircle } from "lucide-react";
import type {
  AgentCheck,
  AgentConnectionTest,
  ClaudeSignInStart,
  Workspace,
} from "@dragon-control/core";
import { useAiName, useWorkspace } from "../../data/api";
import {
  useCancelClaudeSignIn,
  useClaudeSignOut,
  useClaudeStatus,
  useConnectAgent,
  useDisconnectAgent,
  useFinishClaudeSignIn,
  useStartClaudeSignIn,
  useTestAgent,
} from "../../data/agent";
import { Button, Tag, cx } from "../ui";
import { FormError } from "../../pages/auth/AuthFrame";
import { OllamaSetting } from "../settings/OllamaSetting";

/**
 * "Connect your AI": the welcome's first step after the account, and the same thing later from
 * the AI Agent page. Which AI services appear, and which can be connected, comes from Hearth's
 * own catalog (the server): an option is only offered as working when the server can connect to
 * it. The words for each service live here; a service the server adds later and these words do
 * not know yet still appears, with its catalog description and the same test and connect.
 */

type Agent = Workspace["agents"][number];

interface ServiceWords {
  /** What it is and what it lets Ember do. */
  what: string;
  /** How it is paid for, specific to how Hearth connects to it. */
  costs?: string[];
  /** Shown when it cannot be connected yet: why, plainly. */
  notYet?: string;
}

const SERVICE_WORDS: Record<string, ServiceWords> = {
  "claude-code": {
    what: "Anthropic's Claude, through its Claude Code program on this computer. Claude does the thinking: understanding your questions, investigating problems, and proposing fixes. Hearth runs Claude Code with its own shell, files, and web access switched off, so Ember can only use Hearth's tools.",
    costs: [
      "You connect Claude Code to your Anthropic account from this page. Claude Code keeps the sign-in on this computer; Hearth never sees your password or its keys.",
      "Signed in with a Claude subscription that includes Claude Code, Ember's requests count against your plan's usage limits. Signed in with an Anthropic Console (API) account, they're billed per use to that account.",
      "Anthropic decides which plans include Claude Code, and sets the limits and prices. They can change, so check Anthropic's current plans.",
    ],
  },
  codex: {
    what: "OpenAI's Codex, through its program on this computer, with Hearth's tools, the same as in the War Room.",
    costs: [
      "Codex uses the ChatGPT or OpenAI account it is signed in with on this computer; its requests count against that plan's limits.",
      "Codex always has its own shell (as in the War Room). What it asks you before acting is your choice, in Settings, Ember.",
    ],
  },
  "openai-compatible": {
    what: "A hosted or local model that speaks the OpenAI API.",
    notYet:
      "Not available yet. Hearth can't run Ember on these yet; they appear here so you know they're planned.",
  },
  ollama: {
    what: "Free models on your own hardware, through Ollama. Hearth runs the same Claude Code with the Ollama model as its brain, so Ember has the same tools and access as with Claude, and no Claude account is needed.",
    costs: [
      "No per-request charge and no account: it uses your own processor, graphics card, memory, and electricity.",
      "Slower than Claude, depending on your hardware, and smaller models make more mistakes. A model needs to be able to use tools.",
    ],
  },
};

function Row({ check, label, waiting }: { check?: AgentCheck; label: string; waiting?: string }) {
  const icon = !check ? (
    <CircleDashed strokeWidth={1.5} className="h-5 w-5 shrink-0 text-faint" />
  ) : check.ok ? (
    <CheckCircle2 strokeWidth={1.5} className="h-5 w-5 shrink-0 text-live" />
  ) : (
    <XCircle strokeWidth={1.5} className="h-5 w-5 shrink-0 text-bad" />
  );
  return (
    <li className="flex gap-3">
      {icon}
      <div className="min-w-0">
        <p className="text-[0.88rem] text-ink">
          {label}
          <span className="sr-only">
            {!check ? ": not tested" : check.ok ? ": passed" : ": did not pass"}
          </span>
        </p>
        <p className="text-[0.8rem] leading-relaxed text-muted">{check?.detail ?? waiting}</p>
      </div>
    </li>
  );
}

/** The plain-English part about money and usage, before anything is connected. */
export function AiCostsNote() {
  return (
    <details className="mb-6 rounded-xl border border-line bg-bg/40 p-4" data-testid="ai-costs">
      <summary className="cursor-pointer text-[0.9rem] text-ink">
        Before you connect: what AI costs, in plain English
      </summary>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-[0.84rem] leading-relaxed text-muted">
        <li>
          Hearth doesn&apos;t include an AI subscription. Ember uses the AI service you connect.
        </li>
        <li>
          Every question you ask, and every step Ember takes while working on something, is a
          request to that service. Investigating a problem or planning a fix can take several
          requests, so it uses more than a single chat message would.
        </li>
        <li>
          Depending on the service and how you sign in, requests count against a plan&apos;s usage
          limits or are billed per use (an API account). A paid Claude or ChatGPT subscription
          doesn&apos;t necessarily include separate API usage.
        </li>
        <li>
          Each AI company sets its own plans, limits, and prices, and they can change. Check theirs.
        </li>
        <li>
          Models running on your own computer have no per-request charge, but they use your
          processor, graphics card, memory, and electricity.
        </li>
        <li>
          You can cap how much Ember spends each day in Settings, under &ldquo;Ember: AI use and
          budget&rdquo;.
        </li>
      </ul>
    </details>
  );
}

/**
 * Claude Code, connected entirely from this page: Hearth starts Claude Code's own sign-in for the
 * account it runs as, opens Anthropic's sign-in page, takes the one-time code Anthropic shows, and
 * then checks the connection by itself. No terminal, no service accounts. Hearth never sees a token.
 */
function ClaudeCodeSetup({ agent, connected }: { agent: Agent; connected: boolean }) {
  const name = useAiName();
  const status = useClaudeStatus();
  const start = useStartClaudeSignIn();
  const finish = useFinishClaudeSignIn();
  const cancel = useCancelClaudeSignIn();
  const signOut = useClaudeSignOut();
  const test = useTestAgent();
  const connect = useConnectAgent();
  const disconnect = useDisconnectAgent();
  const [pending, setPending] = useState<ClaudeSignInStart | null>(null);
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"subscription" | "console">("subscription");
  const [message, setMessage] = useState<string>();
  const [result, setResult] = useState<AgentConnectionTest | null>(null);
  const s = status.data;
  const passed = Boolean(result?.installed.ok && result.answered?.ok && result.tools?.ok);

  // After signing in: check the connection, and connect when every check passes.
  const verify = () =>
    test.mutate(agent.id, {
      onSuccess: (r) => {
        setResult(r);
        if (!connected && r.installed.ok && r.answered?.ok && r.tools?.ok) connect.mutate(agent.id);
      },
    });

  const begin = () => {
    setMessage(undefined);
    setResult(null);
    // A tab opened now, while the click counts, is not blocked; it is sent to Anthropic's page
    // once Hearth has the sign-in link.
    const tab = window.open("", "_blank");
    start.mutate(
      { console: kind === "console" },
      {
        onSuccess: (p) => {
          setPending(p);
          setCode("");
          if (tab) {
            tab.opener = null;
            tab.location.href = p.url;
          }
        },
        onError: () => tab?.close(),
      },
    );
  };

  const submit = () => {
    if (!pending) return;
    finish.mutate(
      { id: pending.id, code },
      {
        onSuccess: (r) => {
          if (r.ok) {
            setPending(null);
            setCode("");
            setMessage(undefined);
            void status.refetch();
            verify();
          } else {
            setMessage(r.detail);
            if (r.expired) setPending(null);
          }
        },
      },
    );
  };

  const stopSignIn = () => {
    if (pending) cancel.mutate(pending.id);
    setPending(null);
    setCode("");
    setMessage(undefined);
  };

  const signInPanel = pending ? (
    <div
      className="space-y-4 rounded-xl border border-gold/50 bg-gold/5 p-4"
      data-testid="claude-sign-in"
    >
      <ol className="list-decimal space-y-3 pl-5 text-[0.86rem] leading-relaxed text-muted">
        <li>
          <span className="text-ink">Sign in at Anthropic.</span> Hearth opened Anthropic&apos;s
          sign-in page in a new tab. If it didn&apos;t open,{" "}
          <a
            href={pending.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-gold underline underline-offset-2"
            data-testid="claude-sign-in-link"
          >
            open Anthropic&apos;s sign-in page
            <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
          .
        </li>
        <li>
          <span className="text-ink">Authorize Claude Code.</span> Anthropic then shows a code. Copy
          it.
        </li>
        <li>
          <label htmlFor="claude-code-input" className="text-ink">
            Paste the code here.
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              id="claude-code-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && code.trim() && submit()}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-bg px-3 py-2 font-mono text-[0.85rem] text-ink"
              placeholder="The code from Anthropic's page"
              data-testid="claude-code-input"
            />
            <Button
              tone="primary"
              disabled={!code.trim() || finish.isPending}
              onClick={submit}
              data-testid="claude-code-submit"
            >
              {finish.isPending ? "Connecting…" : "Finish connecting"}
            </Button>
          </div>
        </li>
      </ol>
      <p className="text-[0.76rem] leading-relaxed text-faint">
        The code works once and only with this sign-in; it waits for 10 minutes. Hearth hands it to
        Claude Code on this computer and never sees your password or Claude Code&apos;s keys.
      </p>
      <Button tone="quiet" onClick={stopSignIn}>
        Cancel
      </Button>
    </div>
  ) : null;

  const accountChoice = (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[0.86rem] text-ink">Which Anthropic account?</legend>
      {(
        [
          ["subscription", "A Claude subscription (Pro, Max, Team, or Enterprise)"],
          ["console", "An Anthropic Console account (API, billed per use)"],
        ] as const
      ).map(([v, label]) => (
        <label key={v} className="flex items-center gap-2 text-[0.84rem] text-muted">
          <input
            type="radio"
            name="claude-account"
            checked={kind === v}
            onChange={() => setKind(v)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );

  const connectButton = (label: string) => (
    <Button tone="primary" disabled={start.isPending} onClick={begin} data-testid="claude-connect">
      {start.isPending ? "Starting sign-in…" : label}
    </Button>
  );

  const checks = (
    <section className="rounded-xl border border-line p-4">
      <ul className="space-y-3" data-testid="ai-test-results">
        <Row
          check={
            s
              ? {
                  ok: s.installed,
                  detail: s.installed ? "Claude Code is on this computer." : s.detail,
                }
              : undefined
          }
          label="Installed on this computer"
          waiting="Checking…"
        />
        <Row
          check={
            s?.installed
              ? s.loggedIn
                ? { ok: true, detail: s.detail }
                : result?.answered && !result.answered.ok
                  ? result.answered
                  : undefined
              : undefined
          }
          label="Signed in to your Anthropic account"
          waiting={
            s?.installed
              ? "Not signed in yet: connect below."
              : "Needs Claude Code installed first."
          }
        />
        <Row
          check={
            result?.tools ?? (result?.answered && !result.answered.ok ? result.answered : undefined)
          }
          label={`${name} can use Hearth's tools through it`}
          waiting={
            test.isPending
              ? `Checking that ${name} can read your systems…`
              : "Checked automatically after you sign in."
          }
        />
      </ul>
    </section>
  );

  if (connected)
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-live/40 bg-live/5 p-4" data-testid="ai-connected">
          <p className="flex items-center gap-2 text-[0.92rem] text-ink">
            <CheckCircle2 strokeWidth={1.5} className="h-5 w-5 text-live" />
            {name} is connected to {agent.name}.
          </p>
          <p className="mt-1 text-[0.8rem] text-muted" data-testid="claude-account">
            {s ? s.detail : "Checking the sign-in…"}
          </p>
          {s?.installed && !s.loggedIn && (
            <p className="mt-2 text-[0.84rem] text-bad">
              Claude Code&apos;s sign-in has expired or was removed, so {name} can&apos;t think
              right now. Sign in again below.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-3">
            {!pending &&
              connectButton(s?.loggedIn ? "Sign in with a different account" : "Sign in again")}
            <Button tone="quiet" disabled={test.isPending} onClick={verify}>
              {test.isPending ? "Checking…" : "Check the connection"}
            </Button>
            <Button
              tone="quiet"
              disabled={disconnect.isPending}
              onClick={() => {
                setResult(null);
                disconnect.mutate();
              }}
            >
              Disconnect
            </Button>
          </div>
        </div>
        {!pending && !s?.loggedIn && accountChoice}
        {signInPanel}
        {result && checks}
        <FormError error={start.error ?? finish.error ?? test.error} />
        {message && (
          <p className="text-[0.84rem] text-bad" role="alert">
            {message}
          </p>
        )}
      </div>
    );

  return (
    <div className="space-y-5" data-testid="ai-setup-claude-code">
      <section>
        <h3 className="mb-2 text-[0.92rem] text-ink">How Claude Code is paid for</h3>
        <ul className="list-disc space-y-1.5 pl-5 text-[0.84rem] leading-relaxed text-muted">
          {SERVICE_WORDS["claude-code"]!.costs!.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>

      {checks}

      {s && !s.installed && (
        <section className="text-[0.84rem] leading-relaxed text-muted">
          <p>
            Claude Code needs to be installed on the computer Hearth runs on first.{" "}
            <a
              href="https://docs.claude.com/en/docs/claude-code/setup"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-gold underline underline-offset-2"
            >
              Anthropic&apos;s install guide
              <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
            </a>
          </p>
          <Button tone="quiet" className="mt-2" onClick={() => void status.refetch()}>
            Check again
          </Button>
        </section>
      )}

      {s?.installed && !s.loggedIn && !pending && (
        <section className="space-y-4" data-testid="claude-not-signed-in">
          <p className="text-[0.86rem] leading-relaxed text-muted">
            Connect your Anthropic account. Hearth starts Claude Code&apos;s sign-in on this
            computer and opens Anthropic&apos;s page for you; you sign in there and paste back the
            code it shows.
          </p>
          {accountChoice}
          {connectButton("Connect Claude Code")}
        </section>
      )}

      {signInPanel}

      {s?.loggedIn && !pending && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            tone="primary"
            disabled={test.isPending || connect.isPending}
            onClick={() => (passed ? connect.mutate(agent.id) : verify())}
            data-testid="ai-connect"
          >
            {test.isPending
              ? "Checking the connection…"
              : connect.isPending
                ? "Connecting…"
                : passed
                  ? `Use ${agent.name} for ${name}`
                  : `Check and connect`}
          </Button>
          <Button
            tone="quiet"
            disabled={signOut.isPending}
            onClick={() => {
              setResult(null);
              signOut.mutate();
            }}
          >
            Use a different account
          </Button>
        </div>
      )}

      {message && (
        <p className="text-[0.84rem] text-bad" role="alert" data-testid="claude-sign-in-error">
          {message}
        </p>
      )}
      <FormError
        error={start.error ?? finish.error ?? test.error ?? connect.error ?? status.error}
      />
      <p className="text-[0.76rem] leading-relaxed text-faint">
        Checking the connection sends one short question through Claude Code and asks {name} to read
        your systems&apos; overview with Hearth&apos;s tools. It uses a small amount of your Claude
        usage.
      </p>
    </div>
  );
}

/** A service Hearth can connect that this page has no special words for yet. */
function GenericSetup({ agent }: { agent: Agent }) {
  const name = useAiName();
  const test = useTestAgent();
  const connect = useConnectAgent();
  const passed = Boolean(test.data?.tools?.ok);
  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        <Row check={test.data?.installed} label="Installed" waiting="Not tested yet." />
        <Row
          check={test.data?.answered}
          label={agent.id === "ollama" ? "Answering" : "Signed in and answering"}
          waiting="Not tested yet."
        />
        <Row
          check={test.data?.tools}
          label={`${name} can use Hearth's tools through it`}
          waiting="Not tested yet."
        />
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button disabled={test.isPending} onClick={() => test.mutate(agent.id)}>
          {test.isPending ? "Testing…" : "Test connection"}
        </Button>
        <Button
          tone="primary"
          disabled={!passed || connect.isPending}
          onClick={() => connect.mutate(agent.id)}
        >
          Use {agent.name} for {name}
        </Button>
      </div>
      <FormError error={test.error ?? connect.error} />
    </div>
  );
}

/** Is Ember connected to an AI service? */
export function aiConnected(ws?: Workspace): boolean {
  return Boolean(ws?.operator.agentId);
}

export function ConnectAiStep() {
  const ws = useWorkspace();
  const name = useAiName();
  const agents = ws.data?.agents ?? [];
  const connectedId = ws.data?.operator.agentId ?? undefined;
  const firstAvailable = agents.find((a) => a.status !== "coming-later")?.id;
  const [chosen, setChosen] = useState<string | undefined>(connectedId ?? firstAvailable);
  const selected = agents.find((a) => a.id === (chosen ?? connectedId ?? firstAvailable));

  return (
    <div data-testid="connect-ai">
      <p className="mb-4 text-[0.92rem] leading-relaxed text-muted">
        {name} needs an AI service to think with: to understand what you ask, look into problems,
        and suggest fixes. You can do this now or later from the AI Agent page.
      </p>
      <div className="mb-6 rounded-xl border border-line p-4" data-testid="ai-permissions">
        <p className="text-[0.86rem] leading-relaxed text-muted">
          <span className="text-ink">Connecting gives {name} a brain, not the keys.</span> The AI
          service supplies the thinking. Hearth&apos;s own tools decide what {name} can look at, and
          anything that changes your homelab still needs your approval, or happens within the
          autonomy you set. It never gets a shell, your files, or your passwords.
        </p>
      </div>
      <AiCostsNote />

      <fieldset>
        <legend className="mb-3 text-[0.92rem] text-ink">Choose an AI service</legend>
        <div className="grid gap-3" role="radiogroup" aria-label="AI services">
          {agents.map((a) => {
            const words = SERVICE_WORDS[a.id];
            const usable = a.status !== "coming-later";
            const isChosen = selected?.id === a.id;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={isChosen}
                aria-disabled={!usable}
                disabled={!usable}
                onClick={() => usable && setChosen(a.id)}
                className={cx(
                  "flex w-full flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors",
                  !usable
                    ? "cursor-not-allowed border-line opacity-70"
                    : isChosen
                      ? "border-gold bg-gold/10"
                      : "border-line-strong hover:border-gold/60",
                )}
                data-testid={`ai-option-${a.id}`}
              >
                <span className="flex w-full flex-wrap items-center gap-2">
                  <span className="text-[1rem] text-ink">{a.name}</span>
                  {a.id === connectedId ? (
                    <Tag tone="gold">Connected</Tag>
                  ) : usable ? (
                    <Tag tone="neutral">Available</Tag>
                  ) : (
                    <Tag tone="neutral">Not available yet</Tag>
                  )}
                </span>
                <span className="text-[0.84rem] leading-relaxed text-muted">
                  {words?.what ?? a.description}
                </span>
                {!usable && (
                  <span className="text-[0.8rem] leading-relaxed text-faint">
                    {words?.notYet ?? a.detail ?? "Not available yet."}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </fieldset>

      {selected && selected.status !== "coming-later" && (
        <section className="mt-6 border-t border-line pt-6" aria-label={`Set up ${selected.name}`}>
          <h2 className="mb-4 font-display text-[1.3rem] text-ink">Set up {selected.name}</h2>
          {selected.id === "claude-code" ? (
            <ClaudeCodeSetup agent={selected} connected={selected.id === connectedId} />
          ) : selected.id === "codex" ? (
            <div className="space-y-6" data-testid="ai-setup-codex">
              <ul className="space-y-1 text-[0.84rem] leading-relaxed text-muted">
                {SERVICE_WORDS.codex!.costs!.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              {selected.id === connectedId ? (
                <p className="text-[0.9rem] text-ink" data-testid="ai-connected">
                  {name} is connected to {selected.name}.
                </p>
              ) : (
                <GenericSetup agent={selected} />
              )}
            </div>
          ) : selected.id === "ollama" ? (
            <div className="space-y-6" data-testid="ai-setup-ollama">
              <ul className="space-y-1 text-[0.84rem] leading-relaxed text-muted">
                {SERVICE_WORDS.ollama!.costs!.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <OllamaSetting />
              {selected.id === connectedId ? (
                <p className="text-[0.9rem] text-ink" data-testid="ai-connected">
                  {name} is connected to {selected.name}.
                </p>
              ) : (
                <GenericSetup agent={selected} />
              )}
            </div>
          ) : selected.id === connectedId ? (
            <p className="text-[0.9rem] text-ink" data-testid="ai-connected">
              {name} is connected to {selected.name}.
            </p>
          ) : (
            <GenericSetup agent={selected} />
          )}
        </section>
      )}
    </div>
  );
}
