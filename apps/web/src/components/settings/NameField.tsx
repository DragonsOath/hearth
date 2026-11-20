import { useState } from "react";
import { useUpdateSettings } from "../../data/api";
import { SaveNote } from "../ui";

/**
 * A name saved when you leave the box: this installation's name, or yours. Used in Settings >
 * General and in the welcome. Your name can be cleared; the installation always keeps one.
 */
export function NameField({
  current,
  field = "instanceName",
  label = "Name",
  placeholder,
  showLabel = false,
}: {
  current: string;
  field?: "instanceName" | "ownerName";
  label?: string;
  placeholder?: string;
  /** Show the label above the box (the welcome); Settings shows it beside the row instead. */
  showLabel?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = useUpdateSettings();
  const value = draft ?? current;
  const id = field === "instanceName" ? "instance-name" : "owner-name";

  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    // The installation needs a name; yours can be cleared.
    if (next === current || (!next && field === "instanceName")) return;
    save.mutate({ [field]: next });
  };

  return (
    <>
      <label
        className={showLabel ? "mb-1.5 block text-[0.85rem] text-ink" : "sr-only"}
        htmlFor={id}
      >
        {label}
      </label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={field === "instanceName" ? 60 : 40}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(null);
        }}
        className="min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
      />
      <SaveNote status={save.status} error={save.error} />
    </>
  );
}
