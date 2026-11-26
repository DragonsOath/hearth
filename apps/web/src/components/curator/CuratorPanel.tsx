import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  BookOpen,
  Check,
  Disc3,
  Eye,
  ExternalLink,
  Film,
  Headphones,
  Library,
  MessageCircle,
  Sparkles,
  Tv,
} from "lucide-react";
import {
  RECOMMEND_GENRES,
  RECOMMEND_KIND_NAMES,
  RECOMMEND_KINDS,
  RECOMMEND_MODES,
  type RecommendFilters,
  type RecommendItem,
  type RecommendKind,
  type RecommendMode,
  type RecommendRating,
  type RecommendResult,
  type RecommendSeenResult,
  type RecommendShow,
  type RecommendWatchStep,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { WorkspaceFrame, type TabDef } from "../command/WorkspaceFrame";
import { ToolImage } from "../panels/ToolImage";
import {
  RequestAsk,
  TrailerLink,
  packSteps,
  saveParams,
  type AskTitle,
  type SaveChoice,
} from "../dashboards/seerr/request";
import { useCave } from "../shell/cave-context";
import { cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";
import { ForYou } from "./ForYou";
import { CuratorRows } from "./CuratorRows";
import { OutsideMark } from "./OutsideMark";
import { RateIt } from "./RateIt";

/**
 * Curator (checklist 48; named Recommend until 11-09). You come for different reasons: something
 * new, a gap to fill, a niche to complete, a genre to go deeper in. Pick a kind and a few filters,
 * and choose what to show: titles you don't have, what's already in your library, or both. Ember
 * suggests; Hearth checks every title is real and whether you have it (your Plex and Jellyfin
 * themselves, not only Seerr). Request is a plan you approve (Seerr, Lidarr, Chaptarr). "Seen it"
 * asks how it was (all optional: stars, a quick reaction, your own words); Hearth keeps that, and
 * offers to mark it watched and put your rating on Plex or Jellyfin, one approval for all of it.
 */

type Tab = "discover" | "for-you";

const KIND_ICONS: Record<RecommendKind, typeof Film> = {
  movie: Film,
  show: Tv,
  book: BookOpen,
  audiobook: Headphones,
  music: Disc3,
};

const field =
  "min-h-11 rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";
const chip =
  "min-h-9 rounded-full border px-3 text-[0.8rem] transition-colors hover:border-gold/60 hover:text-gold";

const EXAMPLES: Record<RecommendKind, string> = {
  movie: "Christmas movies the whole family will like",
  show: "a cozy mystery series to binge",
  book: "fantasy with a great heist",
  audiobook: "funny sci-fi with a great narrator",
  music: "chill instrumental music for working",
};

/** What you're here for, and the question the box asks. */
const MODE_NAMES: Record<RecommendMode, { name: string; hint: string }> = {
  discover: { name: "Something new", hint: "What are you in the mood for?" },
  gap: { name: "Fill a gap", hint: "What's missing? Kids movies, classic westerns, anime…" },
  niche: { name: "Complete a niche", hint: "Which niche? Time loop movies, heist films…" },
  expand: { name: "Go deeper", hint: "Which genre do you want more of?" },
};

const SHOW_NAMES: [RecommendShow, string][] = [
  ["missing", "Missing from my collection"],
  ["have", "In my library"],
  ["both", "Both"],
];

export function CuratorPanel({ onClose }: { onClose: () => void }) {
  const tabs: TabDef<Tab>[] = [
    { id: "discover", label: "Discover" },
    { id: "for-you", label: "For You" },
  ];
  const [tab, setTab] = useState<Tab>("discover");
  // "Find ones we don't have" on For You: Discover, started from that person's taste.
  const [seed, setSeed] = useState<{ interest: string; at: number }>();
  return (
    <WorkspaceFrame
      label="Curator"
      testId="recommend-panel"
      icon={<ToolImage id="curator" />}
      title="Curator"
      subtitle="What to watch next, and what's missing from your collection."
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
      capture={{ panel: "Curator", tab }}
      help={["curator"]}
    >
      {/* Both stay mounted, so switching tabs keeps what each was showing. */}
      <div hidden={tab !== "discover"}>
        <Discover key={seed?.at ?? 0} seed={seed} />
      </div>
      {tab === "for-you" && (
        <ForYou
          onFindMissing={(interest) => {
            setSeed({ interest, at: Date.now() });
            setTab("discover");
          }}
        />
      )}
    </WorkspaceFrame>
  );
}

const titleOf = (i: { title: string; year?: number }) =>
  i.year ? `${i.title} (${i.year})` : i.title;

function Discover({ seed }: { seed?: { interest: string; at: number } }) {
  const cave = useCave();
  const [mode, setMode] = useState<RecommendMode>("discover");
  const [wide, setWide] = useState(false);
  const [kind, setKind] = useState<RecommendKind>("movie");
  const [interest, setInterest] = useState(seed?.interest.slice(0, 300) ?? "");
  const [filters, setFilters] = useState<RecommendFilters>({});
  const [years, setYears] = useState({ from: "", to: "" });
  const [result, setResult] = useState<RecommendResult>();
  const [shown, setShown] = useState<RecommendItem[]>([]);
  const [requested, setRequested] = useState<string[]>([]);
  const [asking, setAsking] = useState<string[]>([]);
  const [show, setShow] = useState<RecommendShow>("missing");
  const [lastSeen, setLastSeen] = useState<RecommendItem>();
  const [toMark, setToMark] = useState<RecommendWatchStep[]>([]);
  const [profile, setProfile] = useState<number>();
  const [save, setSave] = useState<SaveChoice>({});
  // Movies and shows waiting on Request's question (quality and root folder) before the approval.
  const [ask, setAsk] = useState<RecommendItem[]>([]);
  const act = useApproveHere("", "From Curator.");

  // A plan that went through marks its titles as requested, so they aren't offered twice.
  // Sent and not turned down: Requested shows at once (a Seerr request needs no second step).
  const jobDone = act.sent;
  const done = jobDone && asking.length ? [...requested, ...asking] : requested;

  const find = useMutation({
    mutationFn: (more: boolean) =>
      api<RecommendResult>("POST", "/api/recommend", {
        kind,
        interest: interest.trim(),
        ...(Object.keys(filters).length ? { filters } : {}),
        ...(more ? { exclude: shown.map((i) => i.title), more: true } : {}),
        show,
        mode,
        ...(wide ? { wide } : {}),
      }),
    onSuccess: (r, more) => {
      setResult(r);
      setShown((s) =>
        more ? [...s, ...r.items.filter((i) => !s.some((x) => x.key === i.key))] : r.items,
      );
    },
  });

  const reset = () => {
    setResult(undefined);
    setShown([]);
  };
  // Started from For You (a fresh Discover, see CuratorPanel): asked at once.
  const ranFor = useRef<number>(undefined);
  useEffect(() => {
    if (!seed || ranFor.current === seed.at) return;
    ranFor.current = seed.at;
    find.mutate(false);
  }, [seed, find]);
  const switchKind = (k: RecommendKind) => {
    setKind(k);
    setFilters({});
    setYears({ from: "", to: "" });
    setProfile(undefined);
    reset();
  };
  const switchMode = (m: RecommendMode) => {
    setMode(m);
    // Filling a gap or completing a set: what you have counts too, so show both.
    if (m === "gap" || m === "niche") setShow("both");
    reset();
  };
  const setFilter = (patch: Partial<RecommendFilters>) => {
    const next = { ...filters, ...patch };
    for (const k of Object.keys(next) as (keyof RecommendFilters)[])
      if (next[k] === undefined || (Array.isArray(next[k]) && !(next[k] as unknown[]).length))
        delete next[k];
    setFilters(next);
  };
  const year = (v: string) => (/^\d{4}$/.test(v) ? Number(v) : undefined);
  // What is typed is kept as typed (11-09: "1" vanished, as only a whole year was kept); a
  // year counts as a filter once it has four digits.
  const typeYear = (which: "from" | "to", v: string) => {
    const text = v.replace(/\D/g, "").slice(0, 4);
    setYears((y) => ({ ...y, [which]: text }));
    setFilter(which === "from" ? { fromYear: year(text) } : { toYear: year(text) });
  };

  const seenBody = (i: RecommendItem, rating?: RecommendRating) => ({
    kind: i.kind,
    title: i.title,
    ...(i.year ? { year: i.year } : {}),
    ...(rating ? { rating } : {}),
  });
  const seen = useMutation({
    mutationFn: ({ i, rating }: { i: RecommendItem; rating?: RecommendRating }) =>
      api<RecommendSeenResult>("POST", "/api/recommend/seen", seenBody(i, rating)),
    onMutate: ({ i }) => {
      setShown((s) => s.filter((x) => x.key !== i.key));
      setLastSeen(i);
    },
    onSuccess: (r) =>
      setToMark((m) => [
        ...m,
        ...r.markWatched.filter(
          (x) =>
            !m.some((y) => y.serviceId === x.serviceId && y.title === x.title && y.does === x.does),
        ),
      ]),
  });
  const undoSeen = (i: RecommendItem) => {
    setLastSeen(undefined);
    setShown((s) => (s.some((x) => x.key === i.key) ? s : [i, ...s]));
    setToMark((m) => m.filter((x) => x.title !== titleOf(i)));
    void api("POST", "/api/recommend/unseen", seenBody(i)).catch(() => undefined);
  };

  /** Keep requests that already went through before a new plan takes the pop-up. */
  const settle = () => {
    if (jobDone && asking.length) setRequested(done);
    setAsking([]);
  };
  /**
   * A request with where it saves: music gets the Lidarr quality profile you chose (Lidarr's
   * first by default); movies and shows the quality and root folder chosen in Save to.
   */
  const withProfile = (i: RecommendItem, where: SaveChoice = save) => {
    if (i.request?.kind !== "plan") return undefined;
    if (i.request.step === "app-seerr-request")
      return { ...i.request.params, ...saveParams(where) };
    if (i.kind !== "music" || profile === undefined) return i.request.params;
    try {
      const body = JSON.parse(String(i.request.params.body)) as Record<string, unknown>;
      return { ...i.request.params, body: JSON.stringify({ ...body, qualityProfileId: profile }) };
    } catch {
      return i.request.params;
    }
  };
  const isSeerr = (i: RecommendItem) =>
    i.request?.kind === "plan" && i.request.step === "app-seerr-request";
  const request = (i: RecommendItem, where?: SaveChoice) => {
    if (i.request?.kind !== "plan") return;
    // Movies and shows ask where they save first (or say they're already in the library).
    if (isSeerr(i) && !where) return setAsk([i]);
    settle();
    setAsking([i.key]);
    const step = {
      kind: i.request.step as Parameters<typeof act.propose>[0],
      serviceId: i.request.serviceId,
      params: withProfile(i, where)!,
    };
    // Movies and shows: the confirm sheet's Request was the approval (11-14). Music (Lidarr) is
    // still a plan you approve.
    const pack = packSteps(where, { ...i.request.params, title: i.title });
    if (where) void act.sendNow([step, ...pack], i.request.label);
    else void act.proposeMany([step], i.request.label);
  };
  const seerrOf = shown
    .map((x) =>
      x.request?.kind === "plan" && x.request.step === "app-seerr-request"
        ? x.request.serviceId
        : undefined,
    )
    .find(Boolean);
  const requestable = shown.filter(
    (i) => !i.have && !i.requested && !done.includes(i.key) && i.request?.kind === "plan",
  );
  const requestAll = (where?: SaveChoice) => {
    if (!where && requestable.some(isSeerr)) return setAsk(requestable);
    settle();
    setAsking(requestable.map((i) => i.key));
    void (where ? act.sendNow : act.proposeMany)(
      requestable.flatMap((i) => [
        {
          kind: (i.request as { step: string }).step as Parameters<typeof act.propose>[0],
          serviceId: (i.request as { serviceId: string }).serviceId,
          params: withProfile(i, where)!,
        },
        ...packSteps(where, {
          ...(i.request as { params: Record<string, unknown> }).params,
          title: i.title,
        }),
      ]),
      `Request ${requestable.length} ${RECOMMEND_KIND_NAMES[kind].many.toLowerCase()} for “${interest.trim()}”`,
    );
  };
  const markWatched = () => {
    settle();
    const steps = toMark;
    setToMark([]);
    const rating = steps.some((s) => s.does === "rating");
    void act.proposeMany(
      steps.map((m) => ({
        kind: m.step as Parameters<typeof act.propose>[0],
        serviceId: m.serviceId,
        params: m.params,
      })),
      steps.length === 1
        ? rating
          ? `Rate ${steps[0]!.title} on ${steps[0]!.server}`
          : `Mark ${steps[0]!.title} watched on ${steps[0]!.server}`
        : `Update ${new Set(steps.map((s) => s.title)).size} titles you've seen on your servers`,
    );
  };
  /** Hand the list to Ember: a Plex Home row, built the usual way (Forge, then one approval). */
  const makeRow = () => {
    const names = shown.map((i) => titleOf(i));
    cave.ask(
      `Make a Plex Home row called "${interest.trim()}" from Curator's list: ${names.join("; ")}. Use the ones in my library; any I requested join when they arrive.`,
    );
  };

  const servers = [...new Set(toMark.map((m) => m.server))];
  const watchedTitles = [
    ...new Set(toMark.filter((m) => m.does === "watched").map((m) => m.title)),
  ];
  const ratedTitles = [...new Set(toMark.filter((m) => m.does === "rating").map((m) => m.title))];
  const genres = filters.genres ?? [];
  const profiles = result?.qualityProfiles ?? [];

  // Movies and shows as rows of posters (11-24); music and books as cards.
  const screen = shown[0]?.kind === "movie" || shown[0]?.kind === "show";
  return (
    <div className="space-y-5" data-testid="recommend-discover">
      <div className="space-y-2">
        <p className="text-[0.86rem] text-ink">What are you here for?</p>
        <div role="group" aria-label="What are you here for" className="flex flex-wrap gap-2">
          {RECOMMEND_MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === mode}
              onClick={() => switchMode(m)}
              className={cx(
                chip,
                m === mode ? "border-gold/70 bg-gold/10 text-gold" : "border-line text-muted",
              )}
              data-testid={`recommend-mode-${m}`}
            >
              {MODE_NAMES[m].name}
            </button>
          ))}
        </div>
      </div>

      <div role="group" aria-label="What kind" className="flex flex-wrap gap-2">
        {RECOMMEND_KINDS.map((k) => {
          const Icon = KIND_ICONS[k];
          return (
            <button
              key={k}
              type="button"
              aria-pressed={k === kind}
              onClick={() => switchKind(k)}
              className={cx(
                "flex min-h-11 items-center gap-2 rounded-xl border px-3.5 text-[0.88rem] font-semibold",
                k === kind
                  ? "border-gold/70 bg-gold/10 text-gold"
                  : "border-line text-muted hover:text-ink",
              )}
              data-testid={`recommend-kind-${k}`}
            >
              <Icon strokeWidth={1.6} className="h-4 w-4" aria-hidden />
              {RECOMMEND_KIND_NAMES[k].many}
            </button>
          );
        })}
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (interest.trim().length >= 2) find.mutate(false);
        }}
      >
        <label className="block text-[0.86rem] text-ink">
          {MODE_NAMES[mode].hint.split("?")[0]}?
          <input
            className={cx(field, "mt-1 w-full")}
            placeholder={
              mode === "discover" ? EXAMPLES[kind] : MODE_NAMES[mode].hint.split("? ")[1]
            }
            value={interest}
            maxLength={300}
            onChange={(e) => setInterest(e.target.value)}
            data-testid="recommend-interest"
          />
        </label>

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[0.8rem] text-muted">
            From year
            <input
              inputMode="numeric"
              className={cx(field, "mt-1 block w-24")}
              placeholder="1980"
              value={years.from}
              onChange={(e) => typeYear("from", e.target.value)}
              data-testid="recommend-from"
            />
          </label>
          <label className="text-[0.8rem] text-muted">
            To year
            <input
              inputMode="numeric"
              className={cx(field, "mt-1 block w-24")}
              placeholder="2025"
              value={years.to}
              onChange={(e) => typeYear("to", e.target.value)}
            />
          </label>
          {(kind === "movie" || kind === "show") && (
            <label className="text-[0.8rem] text-muted">
              Rated at least
              <select
                className={cx(field, "mt-1 block")}
                value={filters.minRating ?? ""}
                onChange={(e) =>
                  setFilter({ minRating: e.target.value ? Number(e.target.value) : undefined })
                }
              >
                <option value="">Any</option>
                <option value="6">6 / 10</option>
                <option value="7">7 / 10</option>
                <option value="8">8 / 10</option>
              </select>
            </label>
          )}
          {(kind === "movie" || kind === "book" || kind === "audiobook") && (
            <label className="text-[0.8rem] text-muted">
              Length
              <select
                className={cx(field, "mt-1 block")}
                value={filters.length ?? ""}
                onChange={(e) =>
                  setFilter({ length: (e.target.value || undefined) as RecommendFilters["length"] })
                }
              >
                <option value="">Any</option>
                <option value="short">{kind === "movie" ? "Under 90 minutes" : "Short"}</option>
                <option value="medium">
                  {kind === "movie" ? "90 minutes to 2 hours" : "Medium"}
                </option>
                <option value="long">{kind === "movie" ? "Over 2 hours" : "Long"}</option>
              </select>
            </label>
          )}
        </div>

        <div role="group" aria-label="Genres" className="flex flex-wrap gap-2">
          {RECOMMEND_GENRES[kind].map((g) => {
            const on = genres.includes(g);
            return (
              <button
                key={g}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setFilter({ genres: on ? genres.filter((x) => x !== g) : [...genres, g] })
                }
                className={cx(
                  chip,
                  on ? "border-gold/70 bg-gold/10 text-gold" : "border-line text-muted",
                )}
              >
                {g}
              </button>
            );
          })}
        </div>

        <div className="space-y-1">
          <div
            role="group"
            aria-label="Show me"
            className="inline-flex flex-wrap rounded-xl border border-line p-0.5"
            data-testid="recommend-show"
          >
            {SHOW_NAMES.map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={show === v}
                onClick={() => setShow(v)}
                className={cx(
                  "min-h-10 rounded-lg px-3.5 text-[0.82rem] font-semibold",
                  show === v ? "bg-gold/15 text-gold" : "text-muted hover:text-ink",
                )}
                data-testid={`recommend-show-${v}`}
              >
                {label}
              </button>
            ))}
          </div>
          <label
            className="flex min-h-10 cursor-pointer items-start gap-2.5 pt-1.5 text-[0.84rem] text-ink"
            data-testid="recommend-wide"
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
              checked={wide}
              onChange={(e) => setWide(e.target.checked)}
            />
            <span>
              Think outside the box
              <span className="block text-[0.76rem] text-faint">
                Also titles with the same feel that aren&apos;t strictly on theme: family snow films
                for Christmas, cozy autumn family films for Thanksgiving.
              </span>
            </span>
          </label>
          {wide && (
            <p
              className="flex items-center gap-2 text-[0.8rem] text-gold"
              role="status"
              data-testid="recommend-wide-on"
            >
              <ToolImage id="curator" className="h-6 w-6" />
              On it: I&apos;ll look past the obvious too, for titles with the same feel and heart.
            </p>
          )}
          {show === "have" && (
            <p className="text-[0.76rem] text-faint" data-testid="recommend-have-note">
              Ember picks from your own library: Hearth sends it the names and years of your titles
              (nothing about who watched what).
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={interest.trim().length < 2 || find.isPending}
          className="flex min-h-11 items-center gap-2 rounded-xl bg-gold px-5 text-[0.92rem] font-bold text-[#1a0d05] disabled:opacity-50"
          data-testid="recommend-find"
        >
          <Sparkles
            strokeWidth={1.8}
            className={cx("h-4 w-4", find.isPending && "animate-pulse")}
            aria-hidden
          />
          {find.isPending
            ? wide
              ? "On it, thinking outside the box…"
              : "Ember is thinking…"
            : "Find"}
        </button>
      </form>

      {find.error && (
        <p className="text-[0.85rem] text-warn" role="alert">
          {find.error.message}
        </p>
      )}
      {result?.missingApp && (
        <p className="text-[0.85rem] text-warn" data-testid="recommend-missing-app">
          {result.missingApp}
        </p>
      )}
      {result?.note && (
        <p className="text-[0.8rem] text-muted" data-testid="recommend-note">
          {result.note}
        </p>
      )}

      {kind === "music" && profiles.length > 1 && (
        <label className="block text-[0.8rem] text-muted">
          New artists get Lidarr&apos;s quality profile
          <select
            className={cx(field, "mt-1 block")}
            value={profile ?? profiles[0]!.id}
            onChange={(e) => setProfile(Number(e.target.value))}
            data-testid="recommend-profile"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {shown.length > 0 && screen && (
        <CuratorRows
          items={shown}
          seerr={seerrOf}
          requested={(i) => Boolean(i.requested || done.includes(i.key))}
          onSeen={(i, rating) => seen.mutate({ i, ...(rating ? { rating } : {}) })}
          onMore={() => find.mutate(true)}
          finding={find.isPending}
        />
      )}
      {shown.length > 0 && !screen && (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="recommend-results">
          {shown.map((i) => (
            <Card
              key={i.key}
              i={i}
              requested={i.requested || done.includes(i.key)}
              busy={act.busy}
              onSeen={(rating) => seen.mutate({ i, ...(rating ? { rating } : {}) })}
              seerr={seerrOf}
              onRequest={() => request(i)}
            />
          ))}
        </ul>
      )}

      {lastSeen && (
        <p
          className="flex flex-wrap items-center gap-2 text-[0.82rem] text-muted"
          role="status"
          data-testid="recommend-seen-note"
        >
          Got it: {lastSeen.title} won&apos;t be suggested again.
          <button
            type="button"
            onClick={() => undoSeen(lastSeen)}
            className="min-h-9 rounded-lg px-2 text-gold underline-offset-2 hover:underline"
            data-testid="recommend-seen-undo"
          >
            Undo
          </button>
        </p>
      )}
      {toMark.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-xl border border-gold/40 bg-gold/5 p-3 text-[0.84rem] text-ink"
          data-testid="recommend-mark-watched"
        >
          <p className="min-w-0 flex-1">
            On {servers.join(" and ")}:{" "}
            {[
              watchedTitles.length
                ? `mark ${watchedTitles.length === 1 ? watchedTitles[0] : `${watchedTitles.length} titles`} watched`
                : "",
              ratedTitles.length
                ? `put your rating on ${ratedTitles.length === 1 ? ratedTitles[0] : `${ratedTitles.length} titles`}`
                : "",
            ]
              .filter(Boolean)
              .join(", and ")}
            ?
          </p>
          <button
            type="button"
            disabled={act.busy}
            onClick={markWatched}
            className="min-h-10 rounded-lg bg-gold px-3.5 text-[0.82rem] font-bold text-[#1a0d05] disabled:opacity-50"
            data-testid="recommend-mark-watched-yes"
          >
            Yes, update it
          </button>
          <button
            type="button"
            onClick={() => setToMark([])}
            className="min-h-10 rounded-lg border border-line-strong px-3.5 text-[0.82rem] text-muted hover:text-ink"
            data-testid="recommend-mark-watched-no"
          >
            No, leave it
          </button>
        </div>
      )}

      {result && !result.missingApp && (
        <div className="space-y-2 text-[0.8rem] text-muted">
          {result.owned.length > 0 && (
            <p data-testid="recommend-owned">
              Hidden because you already have {result.owned.length === 1 ? "it" : "them"}:{" "}
              {result.owned.map(titleOf).join(", ")}.
            </p>
          )}
          {result.unverified.length > 0 && (
            <p>
              Left out because{" "}
              {show === "have" ? "they aren't in your library" : "the catalogue couldn't find them"}
              : {result.unverified.join(", ")}.
            </p>
          )}
          {!result.items.length && !result.note && (
            <p>Nothing new this time. Try other words or fewer filters.</p>
          )}
          {shown.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={find.isPending}
                onClick={() => find.mutate(true)}
                className="min-h-10 rounded-lg border border-line-strong px-3.5 text-[0.84rem] text-ink hover:border-gold/60 disabled:opacity-50"
                data-testid="recommend-more"
              >
                More like these
              </button>
              {requestable.length > 1 && (
                <button
                  type="button"
                  disabled={act.busy}
                  onClick={() => requestAll()}
                  className="min-h-10 rounded-lg border border-gold/50 px-3.5 text-[0.84rem] text-gold hover:bg-gold/10 disabled:opacity-50"
                  data-testid="recommend-request-all"
                >
                  Request all {requestable.length} missing
                </button>
              )}
              {(kind === "movie" || kind === "show") && (
                <button
                  type="button"
                  onClick={makeRow}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong px-3.5 text-[0.84rem] text-ink hover:border-gold/60"
                  data-testid="recommend-make-row"
                >
                  <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden />
                  Make it a Home row
                  <EmberMark />
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {act.error && (
        <p className="text-[0.82rem] text-warn" role="alert">
          {act.error}
        </p>
      )}
      {ask.length > 0 && (
        <RequestAsk
          items={ask.filter(isSeerr).map(askTitle)}
          value={save}
          onChange={setSave}
          onClose={() => setAsk([])}
          onRequest={(where) => {
            const items = ask;
            setAsk([]);
            setSave(where);
            if (items.length === 1) request(items[0]!, where);
            else requestAll(where);
          }}
        />
      )}
      <ApproveDialog c={act} />
    </div>
  );
}

/** A Curator movie or show as Request's question needs it. */
function askTitle(i: RecommendItem): AskTitle {
  const r = i.request as { serviceId: string; params: Record<string, unknown> };
  return {
    serviceId: r.serviceId,
    type: r.params.mediaType === "tv" ? "tv" : "movie",
    tmdbId: Number(r.params.tmdbId),
    title: `${i.title}${i.year ? ` (${i.year})` : ""}`,
  };
}

function Card({
  i,
  seerr,
  requested,
  busy,
  onRequest,
  onSeen,
}: {
  i: RecommendItem;
  /** The Seerr that knows this title's trailer (movies and shows). */
  seerr?: string;
  requested?: boolean;
  busy: boolean;
  onRequest: () => void;
  onSeen: (rating?: RecommendRating) => void;
}) {
  const Icon = KIND_ICONS[i.kind];
  const [broken, setBroken] = useState(false);
  const [rating, setRating] = useState<RecommendRating>();
  const seenWord =
    i.kind === "book" || i.kind === "audiobook"
      ? "Read it"
      : i.kind === "music"
        ? "Know them"
        : "Seen it";
  return (
    <li
      className="flex gap-3 rounded-xl border border-line bg-panel/60 p-3"
      data-testid="recommend-item"
    >
      {i.image && !broken ? (
        <img
          src={i.image}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className="aspect-[2/3] w-16 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="flex aspect-[2/3] w-16 shrink-0 items-center justify-center rounded-md bg-raised text-faint"
        >
          <Icon strokeWidth={1.4} className="h-6 w-6" />
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-center gap-1.5 text-[0.92rem] font-semibold text-ink">
          {i.outside && <OutsideMark />}
          {i.title}
          {i.year ? <span className="font-normal text-muted"> ({i.year})</span> : null}
        </p>
        {i.creator && <p className="text-[0.76rem] text-faint">{i.creator}</p>}
        {i.why && <p className="text-[0.8rem] text-muted">{i.why}</p>}
        {rating ? (
          <RateIt word={seenWord} value={rating} onChange={setRating} onDone={(r) => onSeen(r)} />
        ) : (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {i.have ? (
              <span
                className="inline-flex items-center gap-1 text-[0.8rem] text-ok"
                data-testid="recommend-have"
              >
                <Library strokeWidth={1.8} className="h-3.5 w-3.5" aria-hidden /> In your library
              </span>
            ) : requested ? (
              <span
                className="inline-flex items-center gap-1 text-[0.8rem] text-ok"
                data-testid="recommend-requested"
              >
                <Check strokeWidth={2} className="h-3.5 w-3.5" aria-hidden /> Requested
              </span>
            ) : i.request?.kind === "plan" ? (
              <>
                {i.partial && (
                  <span className="text-[0.76rem] text-faint" data-testid="recommend-partial">
                    You have some seasons
                  </span>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRequest}
                  className="min-h-9 rounded-lg border border-gold/50 px-3 text-[0.8rem] text-gold hover:bg-gold/10 disabled:opacity-50"
                  data-testid="recommend-request"
                >
                  {i.partial ? "Request missing seasons" : "Request"}
                </button>
              </>
            ) : i.request?.kind === "open" ? (
              <a
                href={i.request.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-gold/50 px-3 text-[0.8rem] text-gold hover:bg-gold/10"
                data-testid="recommend-open"
              >
                {i.request.label}{" "}
                <ExternalLink strokeWidth={1.6} className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : null}
            {seerr && /^(movie|tv):\d+$/.test(i.key) && (
              <TrailerLink
                serviceId={seerr}
                type={i.key.startsWith("tv:") ? "tv" : "movie"}
                tmdbId={Number(i.key.split(":")[1])}
                title={i.title}
              />
            )}
            <button
              type="button"
              onClick={() => setRating({})}
              title="Take it off the list for good, and say how it was if you like"
              className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-line px-3 text-[0.8rem] text-muted hover:border-gold/50 hover:text-ink"
              data-testid="recommend-seen"
            >
              <Eye strokeWidth={1.6} className="h-3.5 w-3.5" aria-hidden />
              {seenWord}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
