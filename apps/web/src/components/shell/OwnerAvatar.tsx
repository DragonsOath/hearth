import { useRef, useState } from "react";
import { api, useWorkspace } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { Button, cx } from "../ui";

/** Your picture in a circle (or your initial, or "You"), wherever you appear. */
export function OwnerAvatar({ className, label }: { className?: string; label?: string }) {
  const ws = useWorkspace();
  const at = ws.data?.ownerAvatarAt;
  const [broken, setBroken] = useState<string | null>(null);
  const name = ws.data?.ownerName;
  if (at && broken !== at)
    return (
      <img
        src={`/api/owner/avatar?v=${encodeURIComponent(at)}`}
        alt={label ?? ""}
        onError={() => setBroken(at)}
        className={cx("shrink-0 rounded-full object-cover", className)}
        draggable={false}
        data-testid="owner-avatar"
      />
    );
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cx(
        "flex shrink-0 items-center justify-center rounded-full border border-line-strong text-gold",
        className,
      )}
    >
      {name ? name.slice(0, 1).toUpperCase() : "You"}
    </span>
  );
}

/** A square, small enough to keep: the middle of the picture, 256 px, JPEG. */
export async function squareJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file could not be opened as a picture.");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  canvas
    .getContext("2d")!
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  if (!blob) throw new Error("The picture could not be prepared.");
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Settings: choose, change, or remove your picture. */
export function OwnerAvatarField() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["workspace"] });
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/owner/avatar", { data: await squareJpeg(file) });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The picture could not be saved.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 sm:justify-end">
      <OwnerAvatar className="h-12 w-12 text-[0.9rem]" label="Your picture" />
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
        data-testid="owner-avatar-input"
      />
      <Button tone="outline" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Saving…" : ws.data?.ownerAvatarAt ? "Change" : "Choose a picture"}
      </Button>
      {ws.data?.ownerAvatarAt && (
        <Button
          tone="quiet"
          aria-label="Remove your picture"
          disabled={busy}
          onClick={() => void api("DELETE", "/api/owner/avatar").then(refresh)}
        >
          Remove
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-[0.8rem] text-bad sm:text-right">
          {error}
        </p>
      )}
    </div>
  );
}
