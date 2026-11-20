import type { ReactNode } from "react";

/** Files chosen in the browser, as name and base64 bytes for a plan's params. */
export async function readFiles(list: File[]): Promise<{ name: string; data: string }[]> {
  return Promise.all(
    list.map(
      (f) =>
        new Promise<{ name: string; data: string }>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve({ name: f.name, data: String(r.result).split(",")[1] ?? "" });
          r.onerror = () => reject(new Error(`${f.name} could not be read.`));
          r.readAsDataURL(f);
        }),
    ),
  );
}

/** A labelled form field, label above. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[0.8rem] text-muted">{label}</span>
      {children}
    </label>
  );
}
