import { ATTACHMENT_LIMITS, type CaveAttachment } from "@dragon-control/core";
import { api } from "../../data/api";

/**
 * The paperclip: a photo or a text file to go with your next message.
 * Photos are made small enough to send (longest side 2400 px, JPEG) and stored on your
 * Hearth like a capture; the AI looks at them only with that message. Text files
 * (logs, configs) go into the message itself, cut to fit if they are long. Anything else
 * (PDFs, documents) is not supported yet and says so.
 */

export const ATTACH_ACCEPT =
  "image/*,.txt,.log,.json,.yaml,.yml,.conf,.cfg,.ini,.toml,.xml,.csv,.md,.sh,.py,.js,.ts";

const TEXT = /\.(txt|log|json|ya?ml|conf|cfg|ini|toml|xml|csv|md|sh|py|js|ts)$/i;
/** How much of a text file goes into one message. */
export const MAX_FILE_CHARS = 15_000;

export type Attached =
  { kind: "image"; attachment: CaveAttachment } | { kind: "text"; name: string; text: string };

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function shrink(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name} could not be opened as a picture.`);
  });
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (blob && blob.size <= ATTACHMENT_LIMITS.maxBytes) return { blob, width, height };
  }
  throw new Error(`${file.name} is too large to send, even made smaller.`);
}

export async function readAttachment(file: File): Promise<Attached> {
  if (file.type.startsWith("image/")) {
    const { blob, width, height } = await shrink(file);
    const attachment = await api<CaveAttachment>("POST", "/api/attachments", {
      data: await toBase64(blob),
      width,
      height,
      context: {
        mode: "upload",
        fileName: file.name.slice(0, 200),
        capturedAt: new Date().toISOString(),
        redacted: 0,
      },
    });
    return { kind: "image", attachment };
  }
  if (TEXT.test(file.name) || file.type.startsWith("text/")) {
    if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} is larger than 5 MB.`);
    let text = await file.text();
    if (text.length > MAX_FILE_CHARS) {
      // Logs: the end matters most. Everything else: the start.
      text = /\.log$/i.test(file.name)
        ? `(only the last ${MAX_FILE_CHARS} characters)\n${text.slice(-MAX_FILE_CHARS)}`
        : `${text.slice(0, MAX_FILE_CHARS)}\n(cut after ${MAX_FILE_CHARS} characters)`;
    }
    return { kind: "text", name: file.name, text };
  }
  throw new Error(
    `${file.name}: only photos and text files (logs, configs) can be attached for now.`,
  );
}

/** A text file as it goes into the message. */
export const fileBlock = (f: { name: string; text: string }) =>
  `\n\nAttached file ${f.name}:\n\`\`\`\n${f.text}\n\`\`\``;
