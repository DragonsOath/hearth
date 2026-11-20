/**
 * Ollama: free AI models on the owner's own hardware (10-27). Ollama only runs models, so
 * Hearth runs the same Claude Code it uses everywhere with Ollama as its brain (Ollama speaks
 * Anthropic's API). That keeps one set of tools, permissions, Full access, Hearth's guide and
 * memory for every agent: a fix to what Claude Code may do reaches Ollama too.
 *
 * No Claude account or plan is used: the requests go to the Ollama address, never to Anthropic.
 */

export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
/** Claude Code's instructions and tools are about 10,000 to 15,000 tokens before the task. */
export const OLLAMA_MIN_CONTEXT = 32_768;

export interface OllamaConfig {
  url: string;
  /** The model Ollama runs for Hearth, e.g. "qwen3-coder:30b". */
  model: string | null;
}

export interface OllamaModel {
  name: string;
  sizeGb: number;
  /** Ollama says it can call tools: without that it can only talk, not act. */
  tools: boolean;
  /** Its memory window (num_ctx) when set on the model; null means Ollama's default, often small. */
  context: number | null;
  /** Big enough for Claude Code's instructions plus the task. */
  contextOk: boolean;
}

export interface OllamaStatus {
  url: string;
  model: string | null;
  reachable: boolean;
  version: string | null;
  models: OllamaModel[];
  problem: string | null;
}

type Fetch = typeof fetch;

/** An address the owner typed, made into a base URL (http:// and the port added when left out). */
/** An address only this computer can use (127.0.0.1, localhost), so not one to share. */
export function ollamaIsLocalOnly(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || h.startsWith("127.");
  } catch {
    return true;
  }
}

export function normalizeOllamaUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return OLLAMA_DEFAULT_URL;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!u.port && u.protocol === "http:") u.port = "11434";
  return u.toString().replace(/\/+$/, "");
}

async function json(f: Fetch, url: string, init?: RequestInit, ms = 8000): Promise<unknown> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!res.ok)
    throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** The num_ctx line in Ollama's parameters text, if any. */
export function contextOf(parameters: unknown): number | null {
  const m = /^\s*num_ctx\s+(\d+)/m.exec(typeof parameters === "string" ? parameters : "");
  return m ? Number(m[1]) : null;
}

/** What Ollama has: reachable, its version, and each model with whether Hearth can use it. */
export async function ollamaStatus(cfg: OllamaConfig, f: Fetch = fetch): Promise<OllamaStatus> {
  const base: OllamaStatus = {
    url: cfg.url,
    model: cfg.model,
    reachable: false,
    version: null,
    models: [],
    problem: null,
  };
  try {
    const v = (await json(f, `${cfg.url}/api/version`)) as { version?: string };
    base.reachable = true;
    base.version = v.version ?? null;
  } catch {
    return {
      ...base,
      problem: `Hearth can't reach Ollama at ${cfg.url}. Check that Ollama is running there, and that it listens on the network (OLLAMA_HOST=0.0.0.0) if it is on another computer.`,
    };
  }
  const tags = (await json(f, `${cfg.url}/api/tags`).catch(() => ({ models: [] }))) as {
    models?: { name?: string; size?: number }[];
  };
  base.models = await Promise.all(
    (tags.models ?? [])
      .filter((m) => m.name)
      .map(async (m) => {
        const show = (await json(f, `${cfg.url}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: m.name }),
        }).catch(() => ({}))) as { capabilities?: string[]; parameters?: string };
        const context = contextOf(show.parameters);
        return {
          name: m.name!,
          sizeGb: Math.round(((m.size ?? 0) / 1e9) * 10) / 10,
          tools: (show.capabilities ?? []).includes("tools"),
          context,
          contextOk: (context ?? 0) >= OLLAMA_MIN_CONTEXT,
        };
      }),
  );
  if (!base.models.length)
    base.problem =
      "Ollama is running but has no models yet. Download one in Ollama first (for example a coding model that can use tools).";
  return base;
}

/** The name Hearth gives its copy of a model with a bigger memory window. */
export function hearthCopyName(model: string): string {
  const [name, tag] = model.split(":");
  const t = tag && tag !== "latest" ? `-${tag}` : "";
  return `${name}${t}-hearth`.replace(/[^\w.-]/g, "-");
}

/**
 * A copy of the model with a memory window big enough for Claude Code. Only the copy is new:
 * the original model and Ollama's own settings stay as they were. Nothing is downloaded.
 */
export async function prepareOllamaModel(
  cfg: OllamaConfig,
  model: string,
  f: Fetch = fetch,
): Promise<string> {
  const name = hearthCopyName(model);
  await json(
    f,
    `${cfg.url}/api/create`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: name,
        from: model,
        parameters: { num_ctx: OLLAMA_MIN_CONTEXT },
        stream: false,
      }),
    },
    120_000,
  );
  return name;
}

/**
 * What Claude Code needs to use Ollama instead of Anthropic: its address, a placeholder token
 * (Ollama ignores it), and the same model for the small background calls.
 */
export function ollamaEnv(cfg: OllamaConfig): Record<string, string> {
  const model = cfg.model ?? "";
  return {
    ANTHROPIC_BASE_URL: cfg.url,
    ANTHROPIC_AUTH_TOKEN: "ollama",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    // No update checks or telemetry calls that would wait on Anthropic.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Local models are slower: give each answer longer before giving up.
    API_TIMEOUT_MS: "900000",
  };
}

/**
 * A stand-in Ollama for tests and demos (DC_FAKE_AGENT): one model ready for Hearth, one with
 * Ollama's small default memory window (Hearth offers to make a copy), and one that can't use tools.
 */
export function fakeOllamaFetch(): Fetch {
  const models = new Map<string, { size: number; tools: boolean; ctx: number | null }>([
    ["qwen3-coder:30b", { size: 18.6e9, tools: true, ctx: null }],
    ["coder-ready:14b", { size: 9e9, tools: true, ctx: 32_768 }],
    ["chat-only:7b", { size: 4.1e9, tools: false, ctx: null }],
  ]);
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    // An address nothing answers on, for the "can't reach it" message.
    if (url.port === "11999") throw new TypeError("fetch failed");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    switch (url.pathname) {
      case "/api/version":
        return ok({ version: "0.40.5" });
      case "/api/tags":
        return ok({ models: [...models].map(([name, m]) => ({ name, size: m.size })) });
      case "/api/show": {
        const m = models.get(String(body.model));
        if (!m) return new Response("model not found", { status: 404 });
        return ok({
          capabilities: m.tools ? ["completion", "tools"] : ["completion"],
          parameters: m.ctx ? `num_ctx                        ${m.ctx}` : "",
        });
      }
      case "/api/create": {
        const from = models.get(String(body.from));
        if (!from) return new Response("model not found", { status: 404 });
        const ctx = (body.parameters as { num_ctx?: number } | undefined)?.num_ctx ?? null;
        models.set(String(body.model), { ...from, ctx });
        return ok({ status: "success" });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }) as Fetch;
}
