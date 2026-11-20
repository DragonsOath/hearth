import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRight, ChevronDown, X } from "lucide-react";
import type { Health } from "@dragon-control/core";
import { healthLabel } from "../lib/format";
import { logoFor } from "../lib/logos";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* ---------- Brand ---------- */

/** Hearth's mark (docs/brand): the house with the fire inside, on its dark tile. */
export function BrandMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <img
      src="/brand/hearth-mark.png"
      alt=""
      aria-hidden="true"
      className={cx("shrink-0 rounded-[24%]", className)}
    />
  );
}

/** The mark and the name, as in the brand sheet: "hearth", lowercase, in warm white. */
export function Wordmark({ stacked = false }: { stacked?: boolean }) {
  return (
    <span className={cx("flex items-center gap-3", stacked && "flex-col gap-2")}>
      <BrandMark className={stacked ? "h-12 w-12" : "h-8 w-8"} />
      <span className="flex flex-col leading-none">
        <span className="font-sans text-[1.35rem] font-semibold tracking-[-0.01em] text-ink lowercase">
          hearth
        </span>
        {stacked && (
          <span className="mt-1.5 text-[0.62rem] tracking-[0.32em] text-muted uppercase">
            Your digital home
          </span>
        )}
      </span>
    </span>
  );
}

/* ---------- Layout ---------- */

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-10 flex flex-col gap-5 sm:mb-14 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <p className="eyebrow mb-3" style={{ color: "var(--color-accent)" }}>
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-[2.4rem] leading-[1.05] font-normal tracking-[-0.01em] text-ink sm:text-[3rem]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-3 max-w-xl text-[0.95rem] leading-relaxed text-muted">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-3">{actions}</div>}
    </header>
  );
}

/**
 * Settings folds its sections (the owner, 11-13: "put all this in drop downs, not scrolling
 * forever"). Inside this, every Section folds behind its title, closed at first unless the
 * owner chose Open all; each remembers whether it was left open. `all` changes when Open all or
 * Close all is pressed; `tabs` are hashes that name a whole tab, not a section.
 */
export const FoldContext = createContext<
  { all: { open: boolean; at: number }; tabs: readonly string[] } | undefined
>(undefined);

const FOLD_DEFAULT = "settings-fold-default";

/** Whether Settings starts with its sections open (Open all), on this browser. */
export function foldDefaultOpen(): boolean {
  try {
    return localStorage.getItem(FOLD_DEFAULT) === "open";
  } catch {
    return false;
  }
}

export function setFoldDefault(open: boolean) {
  try {
    localStorage.setItem(FOLD_DEFAULT, open ? "open" : "closed");
  } catch {
    /* private window: just this visit */
  }
}

export function Section({
  title,
  action,
  children,
  className,
  id,
  collapsible,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** For links straight to this section (Home's "#needs-you"). */
  id?: string;
  /**
   * Folds away behind its title (closed at first); the choice is remembered on this browser
   * under this key.
   */
  collapsible?: string;
}) {
  const fold = useContext(FoldContext);
  const key = collapsible ?? (fold ? `settings:${id ?? title}` : undefined);
  // This section's own choice, and when it was made (0: never on this browser).
  const [mine, setMine] = useState<{ open: boolean; at: number }>(() => {
    if (!key) return { open: true, at: 0 };
    // A link straight to this section opens it.
    const h =
      typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.slice(1));
    if (h && id === h && !fold?.tabs.includes(h)) return { open: true, at: Date.now() };
    try {
      const saved = localStorage.getItem(`section-open:${key}`);
      if (saved !== null) return { open: saved === "1", at: 1 };
    } catch {
      return { open: false, at: 0 };
    }
    return { open: fold ? foldDefaultOpen() : false, at: 0 };
  });
  // Open all / Close all wins over choices made before it was pressed.
  const open = !key ? true : fold && fold.all.at > mine.at ? fold.all.open : mine.open;
  const toggle = () => {
    try {
      localStorage.setItem(`section-open:${key}`, open ? "0" : "1");
    } catch {
      /* private window: just this visit */
    }
    setMine({ open: !open, at: Date.now() });
  };
  return (
    <section
      id={id}
      className={cx(key && fold ? "mb-6 scroll-mt-24" : "mb-12 scroll-mt-24 sm:mb-14", className)}
      aria-label={title}
    >
      <div
        className={cx(
          "flex items-baseline justify-between gap-4 border-b border-line pb-3",
          open && "mb-4",
        )}
      >
        {key ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className={cx(
              "inline-flex items-center gap-2 text-left hover:text-ink",
              fold && "min-h-11 w-full justify-between",
            )}
            data-testid={`section-toggle-${key}`}
            data-fold={fold ? "settings" : undefined}
          >
            <h2 className="eyebrow">{title}</h2>
            <ChevronDown
              aria-hidden
              strokeWidth={1.8}
              className={cx("h-4 w-4 text-muted transition-transform", open ? "" : "-rotate-90")}
            />
          </button>
        ) : (
          <h2 className="eyebrow">{title}</h2>
        )}
        {open && action}
      </div>
      {open && children}
    </section>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-line bg-panel", className)}>{children}</div>;
}

/** A vertical list separated by hairlines, the default way to show collections. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cx("divide-y divide-line", className)}>{children}</ul>;
}

export function RowLink({
  to,
  children,
  label,
  trailing,
}: {
  to: string;
  children: ReactNode;
  label?: string;
  /** Rendered beside the row link, not inside it (links can't nest). */
  trailing?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-1">
      <Link
        to={to}
        aria-label={label}
        className="group -mx-3 flex min-h-14 min-w-0 flex-1 items-center gap-4 rounded-lg px-3 py-3.5 transition-colors duration-200 hover:bg-raised/60"
      >
        {children}
      </Link>
      {trailing}
    </li>
  );
}

export function SeeAll({ to, children = "View all" }: { to: string; children?: ReactNode }) {
  return (
    <Link to={to} className="text-[0.8rem] text-muted transition-colors hover:text-gold">
      {children}
    </Link>
  );
}

/** Opens a service in a new tab. Icon-only by default, with an accessible name. */
export function OpenLink({
  href,
  label,
  children,
  className,
}: {
  href: string;
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={children ? undefined : label}
      title={label}
      className={cx(
        "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg text-faint transition-colors duration-200 hover:text-gold",
        className,
      )}
    >
      {children}
      <ArrowUpRight strokeWidth={1.25} className="h-[18px] w-[18px]" aria-hidden="true" />
    </a>
  );
}

/* ---------- Status ---------- */

const healthColor: Record<Health, string> = {
  healthy: "bg-ok",
  attention: "bg-warn",
  offline: "bg-bad",
};

const healthText: Record<Health, string> = {
  healthy: "text-ok",
  attention: "text-warn",
  offline: "text-bad",
};

export function StatusDot({ health, className }: { health: Health; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        healthColor[health],
        className,
      )}
    />
  );
}

/** A service's state: stopped on request reads as off on purpose, never as down. */
export function ServiceStatus({
  service,
}: {
  service: { health: Health; note?: string; stopped?: unknown };
}) {
  if (service.stopped) {
    return (
      <span className="inline-flex items-center gap-2 text-[0.8rem] text-muted">
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-faint" />
        Stopped on request
      </span>
    );
  }
  return <Status health={service.health} label={service.note} />;
}

export function Status({ health, label }: { health: Health; label?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 text-[0.8rem]", healthText[health])}>
      <StatusDot health={health} />
      {label ?? healthLabel[health]}
    </span>
  );
}

/** A hairline meter. Colour only changes when something deserves a look. */
export function Meter({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  const tone = value >= 90 ? "bg-warn" : "bg-gold/80";
  return (
    <div
      role="meter"
      aria-label={label}
      data-metric-name={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cx("h-[3px] w-full overflow-hidden rounded-full bg-line", className)}
    >
      <div
        className={cx("h-full rounded-full", tone)}
        style={{ width: `${Math.min(100, value)}%` }}
      />
    </div>
  );
}

export function Figure({ value, unit, label }: { value: ReactNode; unit?: string; label: string }) {
  return (
    <div data-capture-item data-capture-label={label} data-metric-name={label}>
      <p className="font-display text-[2.1rem] leading-none text-ink tabular">
        {value}
        {unit && <span className="ml-1 text-[1.1rem] text-muted">{unit}</span>}
      </p>
      <p className="mt-2 text-[0.8rem] text-muted">{label}</p>
    </div>
  );
}

/** A service's project logo in a circle, or its initials when it has no logo. */
export function Monogram({
  name,
  image,
  className,
}: {
  name: string;
  /** The Docker image, which finds the logo when the name alone does not. */
  image?: string;
  className?: string;
}) {
  const logo = logoFor(name, image);
  const [broken, setBroken] = useState(false);
  const letters = name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
  return (
    <span
      aria-hidden="true"
      data-logo={logo && !broken ? logo : undefined}
      className={cx(
        "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line-strong font-display text-[0.95rem] text-gold",
        logo && !broken && "bg-raised",
        className,
      )}
    >
      {logo && !broken ? (
        <img
          src={logo}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setBroken(true)}
          className="h-[62%] w-[62%] object-contain"
        />
      ) : (
        letters.toUpperCase()
      )}
    </span>
  );
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "gold" | "warn";
}) {
  const tones = {
    neutral: "border-line-strong text-muted",
    gold: "border-gold/40 text-gold",
    warn: "border-warn/40 text-warn",
  };
  return (
    <span
      className={cx(
        "fit-pill inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.72rem] tracking-wide",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/* ---------- Controls ---------- */

type ButtonTone = "primary" | "outline" | "quiet";

const buttonTones: Record<ButtonTone, string> = {
  primary: "dc-primary",
  outline: "border border-line-strong text-ink hover:border-gold hover:text-gold",
  quiet: "text-muted hover:text-gold",
};

export function Button({
  tone = "outline",
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 text-[0.85rem] font-medium tracking-wide transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
        buttonTones[tone],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** A link that looks like a Button, for navigation actions. */
export function LinkButton({
  to,
  tone = "outline",
  children,
}: {
  to: string;
  tone?: ButtonTone;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cx(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 text-[0.85rem] font-medium tracking-wide transition-colors duration-200",
        buttonTones[tone],
      )}
    >
      {children}
    </Link>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  target,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  /** Gives each option a stable target, "<target>:<value>" (native panels, Show & Tell). */
  target?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-hearth-target={target ? `${target}:${opt.value}` : undefined}
            onClick={() => onChange(opt.value)}
            className={cx(
              "min-h-11 rounded-full border px-4 text-[0.8rem] transition-colors duration-200",
              active
                ? "border-gold/60 bg-gold/10 text-gold"
                : "border-line text-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {opt.label}
            {opt.count !== undefined && (
              <span className="ml-1.5 text-faint tabular">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 min-w-11 items-center justify-center"
    >
      <span
        className={cx(
          "relative inline-flex h-6 w-10 items-center rounded-full border transition-colors duration-200",
          checked ? "border-gold/60 bg-gold/20" : "border-line-strong bg-raised",
        )}
      >
        <span
          className={cx(
            "h-4 w-4 rounded-full transition-transform duration-200",
            checked ? "translate-x-[1.1rem] bg-gold" : "translate-x-[0.2rem] bg-muted",
          )}
        />
      </span>
    </button>
  );
}

/** Quiet confirmation for auto-saving controls: nothing, "Saving", "Saved", or the error. */
export function SaveNote({
  status,
  error,
}: {
  status: "idle" | "pending" | "success" | "error";
  error?: Error | null;
}) {
  return (
    <p
      aria-live="polite"
      className={cx("min-h-5 text-[0.78rem]", status === "error" ? "text-bad" : "text-faint")}
    >
      {status === "pending" && "Saving"}
      {status === "success" && "Saved"}
      {status === "error" && (error?.message ?? "Could not save.")}
    </p>
  );
}

/* ---------- States ---------- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("shimmer rounded-lg", className)} aria-hidden="true" />;
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="mb-4 h-4 w-28" />
      <Skeleton className="mb-14 h-12 w-2/3 max-w-md" />
      <Skeleton className="mb-3 h-3 w-24" />
      <div className="space-y-3">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
      <BrandMark className="mb-5 h-9 w-9 opacity-70" />
      <p className="font-display text-[1.6rem] leading-tight text-ink">{title}</p>
      {children && (
        <p className="mt-2 max-w-sm text-[0.9rem] leading-relaxed text-muted">{children}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex min-h-[60vh] flex-col items-center justify-center text-center"
    >
      <BrandMark className="mb-6 h-11 w-11 opacity-60 grayscale" />
      <p className="font-display text-[2.2rem] leading-tight text-ink">We've lost contact.</p>
      <p className="mt-3 max-w-md text-[0.95rem] leading-relaxed text-muted">{message}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button tone="outline" onClick={onRetry}>
          Try again
        </Button>
        <Link
          to="/settings#systems"
          className="inline-flex min-h-11 items-center px-5 text-[0.85rem] text-muted hover:text-gold"
        >
          Open settings
        </Link>
      </div>
    </div>
  );
}

/**
 * A side sheet on desktop and a bottom sheet on phones, built on <dialog>
 * so focus, Escape, and the backdrop behave natively.
 */
export function Sheet({
  label,
  eyebrow,
  title,
  onClose,
  children,
  wide = false,
}: {
  label: string;
  eyebrow: string;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      className={cx(
        "fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85vh] w-full max-w-none overflow-y-auto rounded-t-2xl border-t border-line bg-panel p-0 text-ink backdrop:bg-black/70 sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:max-h-none sm:rounded-none sm:border-t-0 sm:border-l",
        wide ? "sm:w-[560px]" : "sm:w-[420px]",
      )}
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <div className="min-w-0">
          <p className="eyebrow mb-2">{eyebrow}</p>
          <p className="font-display text-[1.6rem] leading-tight break-words text-ink">{title}</p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => ref.current?.close()}
          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center text-muted hover:text-gold"
        >
          <X strokeWidth={1.25} className="h-5 w-5" />
        </button>
      </div>
      <div className="px-6 pt-4 pb-8">{children}</div>
    </dialog>
  );
}
