import { MonitorSmartphone } from "lucide-react";
import { cx } from "../ui";
import { pcLook, type PcInfo } from "../../data/pcs";

/**
 * A PC's icon with its name right below, in the icon's color: how every PC is shown, so it is
 * easy to see which PC a project or a system is on.
 */
export function PcBadge({
  pc,
  size = 64,
  showName = true,
  offline = false,
  className,
}: {
  pc: Pick<PcInfo, "id" | "name" | "icon" | "color">;
  size?: number;
  showName?: boolean;
  offline?: boolean;
  className?: string;
}) {
  const look = pcLook(pc);
  return (
    <span
      className={cx("inline-flex flex-col items-center gap-1", offline && "opacity-55", className)}
      data-testid="pc-badge"
      title={offline ? `${pc.name} (offline)` : pc.name}
    >
      {look.src ? (
        <img
          src={look.src}
          alt=""
          width={size}
          height={size}
          className="shrink-0 rounded-full object-cover"
          style={{
            width: size,
            height: size,
            filter: `drop-shadow(0 0 ${size / 8}px ${look.color}66)`,
          }}
        />
      ) : (
        <span
          className="grid shrink-0 place-items-center rounded-full border border-line-strong text-muted"
          style={{ width: size, height: size }}
        >
          <MonitorSmartphone strokeWidth={1.4} style={{ width: size / 2, height: size / 2 }} />
        </span>
      )}
      {showName && (
        <span
          className="max-w-[9rem] truncate text-center font-medium leading-tight"
          style={{ color: look.color, fontSize: Math.max(10, Math.min(15, size / 4.5)) }}
        >
          {pc.name}
        </span>
      )}
    </span>
  );
}

/** A small mark of which PC something is on (a system's chip, a list row). */
export function PcMark({
  mark,
  size = 16,
}: {
  mark: { src: string | null; color: string; name: string } | null;
  size?: number;
}) {
  if (!mark) return null;
  return mark.src ? (
    <img
      src={mark.src}
      alt={`On ${mark.name}`}
      title={`On ${mark.name}`}
      width={size}
      height={size}
      className="shrink-0 rounded-full"
      style={{ width: size, height: size }}
      data-testid="pc-mark"
    />
  ) : (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size / 2, height: size / 2, background: mark.color }}
      title={`On ${mark.name}`}
      data-testid="pc-mark"
    />
  );
}
