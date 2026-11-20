import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ladderWords, rowFor, rowProfileName, type CrucibleSetup } from "@dragon-control/core";
import { api } from "../../../data/api";
import { ArrowLeft, Plus, Search } from "lucide-react";
import { cx } from "../../ui";
import { useRadarr, type LookupView } from "./data";
import {
  AVAILABILITY,
  Check,
  Field,
  Guard,
  LoadError,
  Poster,
  ProposeError,
  btn,
  btnGold,
  input,
  usePropose,
} from "./common";

/**
 * Library > Add a movie: Radarr's own search (it asks TMDB), then where it goes and how Radarr
 * treats it, approved as one plan (app-arr-create, the step Ember uses). Address: "add".
 */
export function AddMovie({
  serviceId,
  onBack,
  onOpen,
}: {
  serviceId: string;
  onBack: () => void;
  onOpen: (id: number) => void;
}) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const q = useRadarr(serviceId, "lookup", { title: term }, term.length > 0);
  const [pick, setPick] = useState<LookupView["results"][number]>();
  return (
    <div className="space-y-3" data-testid="radarr-add">
      <button type="button" className={btn} onClick={onBack}>
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Library
      </button>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPick(undefined);
          setTerm(text.trim());
        }}
      >
        <label className="sr-only" htmlFor={`add-q-${serviceId}`}>
          Movie to add
        </label>
        <input
          id={`add-q-${serviceId}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Movie title"
          className={cx(input, "flex-1")}
          data-hearth-target="add:search"
        />
        <button type="submit" className={btn} disabled={!text.trim()}>
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Find
        </button>
      </form>
      {q.isFetching && !q.data && <p className="text-[0.82rem] text-faint">Asking Radarr...</p>}
      {q.isError && <LoadError error={q.error} />}
      {q.data && (
        <Guard meta={q.data.meta} sample={q.data.sample}>
          {pick ? (
            <AddForm
              serviceId={serviceId}
              d={q.data}
              pick={pick}
              onCancel={() => setPick(undefined)}
            />
          ) : q.data.results.length === 0 ? (
            <p className="text-[0.84rem] text-muted">
              Radarr found nothing for &ldquo;{term}&rdquo;.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {q.data.results.map((r) => (
                <li
                  key={r.tmdbId}
                  className="flex items-center gap-3 px-3 py-2"
                  data-testid="radarr-lookup"
                >
                  <Poster
                    serviceId={serviceId}
                    poster={r.poster}
                    title={r.title}
                    className="h-14 w-10"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.88rem] text-ink">
                      {r.title} <span className="text-faint">{r.year}</span>
                    </p>
                    {r.overview && (
                      <p className="line-clamp-2 text-[0.74rem] text-faint">{r.overview}</p>
                    )}
                  </div>
                  {r.inLibrary ? (
                    <button
                      type="button"
                      className={btn}
                      onClick={() => r.libraryId && onOpen(r.libraryId)}
                    >
                      In your library
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={btnGold}
                      onClick={() => setPick(r)}
                      data-hearth-target={`add:pick:${r.tmdbId}`}
                    >
                      <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Guard>
      )}
    </div>
  );
}

function AddForm({
  serviceId,
  d,
  pick,
  onCancel,
}: {
  serviceId: string;
  d: LookupView;
  pick: LookupView["results"][number];
  onCancel: () => void;
}) {
  const act = usePropose(serviceId);
  const [root, setRoot] = useState(d.rootFolders[0]?.path ?? "");
  // The Crucible's row for this movie, when it has rows for this Radarr: added with its profile,
  // so Radarr's first search already uses it.
  const crucible = useQuery({
    queryKey: ["crucible-setups"],
    queryFn: () => api<{ setups: Record<string, CrucibleSetup> }>("GET", "/api/crucible"),
    staleTime: 60_000,
  });
  const setup = crucible.data?.setups[serviceId];
  const row = setup?.movies.length
    ? rowFor(
        { year: pick.year, genres: pick.genres ?? [], popularity: pick.popularity },
        setup.movies,
        new Date().getFullYear(),
      )
    : undefined;
  const rowProfile = row ? d.profiles.find((p) => p.name === rowProfileName(row)) : undefined;
  const [chosen, setProfile] = useState<string>();
  const profile = chosen ?? String(rowProfile?.id ?? d.profiles[0]?.id ?? "");
  const [monitored, setMonitored] = useState(true);
  const [avail, setAvail] = useState("released");
  const [search, setSearch] = useState(true);
  const [tags, setTags] = useState<number[]>([]);
  const name = `${pick.title}${pick.year ? ` (${pick.year})` : ""}`;
  return (
    <div className="space-y-3 rounded-xl border border-gold/40 p-3" data-testid="radarr-add-form">
      <p className="text-[0.92rem] text-ink">Add {name}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Root folder" htmlFor="add-root">
          <select
            id="add-root"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            className={input}
          >
            {d.rootFolders.map((r) => (
              <option key={r.path} value={r.path}>
                {r.path}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quality profile" htmlFor="add-profile">
          <select
            id="add-profile"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className={input}
          >
            {d.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {rowProfile && profile === String(rowProfile.id) && (
            <span className="mt-1 block text-[0.76rem] text-gold" data-testid="add-crucible-row">
              Chosen by The Crucible: {row!.name} ({ladderWords(row!)})
            </span>
          )}
        </Field>
        <Field label="Minimum availability" htmlFor="add-avail" hint="When Radarr starts looking.">
          <select
            id="add-avail"
            value={avail}
            onChange={(e) => setAvail(e.target.value)}
            className={input}
          >
            {AVAILABILITY.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Check checked={monitored} onChange={setMonitored} label="Monitored (Radarr looks for it)" />
      <Check
        checked={search && monitored}
        onChange={setSearch}
        label="Search for it as soon as it is added"
      />
      {d.tags.length > 0 && (
        <div className="flex flex-wrap gap-x-4">
          {d.tags.map((t) => (
            <Check
              key={t.id}
              checked={tags.includes(t.id)}
              onChange={(on) => setTags((x) => (on ? [...x, t.id] : x.filter((y) => y !== t.id)))}
              label={t.label}
            />
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={!act.can || act.busy || !root || !profile}
          data-hearth-target="add:review"
          onClick={() =>
            act.propose(
              "app-arr-create",
              {
                resource: "movie",
                body: JSON.stringify({
                  tmdbId: pick.tmdbId,
                  qualityProfileId: Number(profile),
                  rootFolderPath: root,
                  monitored,
                  minimumAvailability: avail,
                  tags,
                  searchForMovie: search && monitored,
                }),
              },
              `Add ${name} to Radarr`,
            )
          }
        >
          Review
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          Back to results
        </button>
      </div>
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}
