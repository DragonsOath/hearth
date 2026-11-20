import { useAiName } from "../data/api";
import { Check, Minus } from "lucide-react";
import { Link } from "react-router";
import { WithWorkspace } from "../components/WithWorkspace";
import {
  Button,
  LinkButton,
  PageHeader,
  Panel,
  Rows,
  Section,
  Switch,
  Tag,
} from "../components/ui";
import type { Workspace } from "@dragon-control/core";
import { useAgentEscalation, useConnectAgent, useDisconnectAgent } from "../data/agent";
import { ago } from "../lib/format";
import { ConnectAiStep } from "../components/onboarding/ConnectAi";

const can = [
  "Investigate through Hearth's own tools: health checks, web address tests, incidents, storage, backups, and each container's live CPU, memory, restarts, and how it last stopped",
  "Read container logs for a time window, filtered by a word, with secrets hidden, and see how a container is set up (image, ports, mounts, restart policy, environment variable names, never their values)",
  "Look back at hourly CPU, memory, and disk activity once you switch resource history on (Settings), and say plainly when there is none",
  "Read inside Prowlarr, Radarr, Sonarr, qBittorrent, SABnzbd, and Home Assistant, using your Secure Vault credentials through the broker without ever seeing them; each read it asks for is in Recent changes",
  "Search approved memory and your notes waiting for review, and keep the to-do list with you",
  "Propose plans (restart, start, stop, Prowlarr indexer tests and changes) that run only within your autonomy settings or after you approve the exact plan",
  "Talk with you here, or by voice through Belle and Home Assistant once that is set up",
];
const cannot = [
  "Open a shell, read arbitrary files, or browse the web: switched off on purpose, so it can only use Hearth's purpose-built tools",
  "See vault values, settings, or security",
  "Change its own permissions, or touch the VPN, firewall, reverse proxy, or Docker networks",
  "Control Home Assistant devices or change Home Assistant's configuration: not enabled",
  "Declare a repair successful. Hearth checks every outcome itself",
];

/** Conversations live on the Ask page; this points there. */
function AskLink({ agentName }: { agentName: string }) {
  const aiName = useAiName();
  return (
    <Panel className="mb-14 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
      <div>
        <p className="eyebrow mb-2">Ember</p>
        <p className="max-w-lg text-[0.9rem] leading-relaxed text-muted">
          Ask about your homelab. Hearth gathers what each question needs and {agentName} answers
          from it, inside the jurisdiction and budget you set in Settings.
        </p>
      </div>
      <LinkButton to="/ask" tone="primary">
        Ask {aiName}
      </LinkButton>
    </Panel>
  );
}

function AgentContent({ ws }: { ws: Workspace }) {
  const disconnect = useDisconnectAgent();
  const escalation = useAgentEscalation();
  const connected = ws.agents.find((a) => a.status === "connected");
  // Every agent but the one in use: Claude Code too, so you can switch back to it.
  const others = ws.agents.filter((a) => a !== connected && (connected || a.id !== "claude-code"));
  const connect = useConnectAgent();
  const escalate =
    escalation.isPending && escalation.variables !== undefined
      ? escalation.variables
      : ws.operator.escalate;

  return (
    <>
      <PageHeader
        eyebrow="AI Agent"
        title="Your operator"
        subtitle="Hearth watches and applies known fixes on its own. The operator is called when a problem needs reasoning, or when you want to talk it through."
      />

      {connected ? (
        <Panel className="mb-8 p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-display text-[2rem] leading-none text-ink">{connected.name}</p>
              <p className="mt-2 max-w-md text-[0.88rem] text-muted">{connected.description}</p>
              {connected.detail && (
                <p className="mt-1 text-[0.78rem] text-faint">{connected.detail}</p>
              )}
            </div>
            <Tag tone="gold">Connected</Tag>
          </div>
          <div className="mt-6 flex items-center justify-between gap-6 border-t border-line pt-5">
            <div>
              <p className="text-[0.92rem] text-ink">
                Hand it incidents a known fix could not resolve
              </p>
              <p className="text-[0.78rem] text-faint">
                Once per incident, never where autonomy is set to Monitor.
              </p>
            </div>
            <Switch
              checked={escalate}
              label="Hand unresolved incidents to the operator"
              onChange={(next) => escalation.mutate(next)}
            />
          </div>
          <div className="mt-6 grid gap-8 border-t border-line pt-6 sm:grid-cols-2">
            <div>
              <p className="eyebrow mb-4">It can</p>
              <ul className="space-y-3">
                {can.map((c) => (
                  <li key={c} className="flex gap-3 text-[0.88rem] leading-relaxed text-ink">
                    <Check strokeWidth={1.25} className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="eyebrow mb-4">It cannot</p>
              <ul className="space-y-3">
                {cannot.map((c) => (
                  <li key={c} className="flex gap-3 text-[0.88rem] leading-relaxed text-muted">
                    <Minus strokeWidth={1.25} className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <Button tone="quiet" className="mt-6" onClick={() => disconnect.mutate()}>
            Disconnect
          </Button>
        </Panel>
      ) : (
        <Panel className="mb-14 p-6 sm:p-8">
          <p className="font-display text-[1.7rem] text-ink">No operator connected</p>
          <p className="mt-2 mb-6 max-w-lg text-[0.88rem] leading-relaxed text-muted">
            Everything else keeps working without one: monitoring, known fixes, and notifications.
            Connect an AI service to have Ember take over what known fixes cannot, and to talk with
            it here or through Belle.
          </p>
          {/* The same step as the first-run welcome: one way to connect, tested before it is used. */}
          <ConnectAiStep />
        </Panel>
      )}

      {connected && <AskLink agentName={connected.name} />}

      <Section title="Recent work">
        {ws.agentSessions.length === 0 ? (
          <p className="py-2 text-[0.9rem] text-muted">Nothing yet.</p>
        ) : (
          <Rows>
            {ws.agentSessions.slice(0, 12).map((s) => {
              const known = s.incidentId && ws.incidents.some((i) => i.id === s.incidentId);
              const body = (
                <>
                  <p className="text-[0.92rem] leading-relaxed text-ink">{s.summary}</p>
                  <p className="mt-1 text-[0.78rem] text-faint">
                    {ago(s.at)} ·{" "}
                    {s.conversationId
                      ? "Conversation"
                      : s.outcome === "resolved"
                        ? "Repaired and verified"
                        : s.outcome === "proposed"
                          ? "Proposed a repair"
                          : "Escalated to you"}
                  </p>
                </>
              );
              return (
                <li key={s.id} className="py-4">
                  {known ? (
                    <Link
                      to={`/incidents/${s.incidentId}`}
                      className="block hover:[&_p:first-child]:text-gold"
                    >
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </Rows>
        )}
      </Section>

      <Section title="Other agents">
        <Rows>
          {others.map((a) => (
            <li key={a.id} className="flex min-h-16 flex-wrap items-center gap-4 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-[0.95rem] text-ink">{a.name}</p>
                <p className="text-[0.8rem] text-faint">{a.detail ?? a.description}</p>
              </div>
              {a.status === "coming-later" ? (
                <span className="text-[0.8rem] text-faint">Coming later</span>
              ) : (
                <Button
                  disabled={connect.isPending}
                  onClick={() => connect.mutate(a.id)}
                  data-testid={`use-agent-${a.id}`}
                >
                  Use this one
                </Button>
              )}
            </li>
          ))}
        </Rows>
        {connect.isError && (
          <p role="alert" className="mt-2 text-[0.85rem] text-bad">
            {(connect.error as Error).message}
          </p>
        )}
        <p className="mt-3 text-[0.8rem] text-faint">
          Each one keeps the same memory and the same access. In the Lair and the War Room you can
          also switch per conversation with the Claude Code, Codex and Ollama tabs.
        </p>
      </Section>
    </>
  );
}

export function AgentPage() {
  return <WithWorkspace>{(ws) => <AgentContent ws={ws} />}</WithWorkspace>;
}
