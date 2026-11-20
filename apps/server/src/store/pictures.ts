import { InvalidRequestError } from "./errors";

/**
 * A picture sent by the browser (base64, made square and small there first), checked to really
 * be a JPEG, PNG, or WebP by its first bytes and to fit the size limit. Used for your picture and
 * your AI's own picture.
 */
export function checkedPicture(data: string, max: number): { mime: string; data: string } {
  const buf = Buffer.from(data, "base64");
  if (!buf.length || buf.length > max)
    throw new InvalidRequestError(`The picture must be under ${Math.round(max / 1024)} KB.`);
  const mime =
    buf[0] === 0xff && buf[1] === 0xd8
      ? "image/jpeg"
      : buf.subarray(0, 4).toString("hex") === "89504e47"
        ? "image/png"
        : buf.subarray(0, 4).toString("ascii") === "RIFF" &&
            buf.subarray(8, 12).toString("ascii") === "WEBP"
          ? "image/webp"
          : undefined;
  if (!mime) throw new InvalidRequestError("That is not a JPEG, PNG, or WebP picture.");
  return { mime, data: buf.toString("base64") };
}
