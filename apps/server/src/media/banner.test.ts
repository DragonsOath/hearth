import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { BANNER_H, BANNER_W, makeBanner } from "./banner";

/** Width and height from a PNG's header. */
const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

const picture = (w: number, h: number, color: string) => {
  const c = createCanvas(w, h);
  const x = c.getContext("2d");
  x.fillStyle = color;
  x.fillRect(0, 0, w, h);
  return c.encode("png");
};

describe("movie night banner", () => {
  const input = {
    title: "Quiet Harbor",
    year: 2026,
    meta: "Drama  ·  1h 50m  ·  PG-13",
    when: "Saturday, Nov 7, 8:00 PM PST",
    eyebrow: "Movie night",
    foot: ["Popcorn at 7:45", "5 spots left", "Plezy Watch Together"],
  };

  it("draws a wide banner with the poster and backdrop", async () => {
    const png = await makeBanner({
      ...input,
      poster: await picture(600, 900, "#a02020"),
      backdrop: await picture(1600, 900, "#203060"),
    });
    expect(png).toBeDefined();
    expect(size(png!)).toEqual([BANNER_W, BANNER_H]);
  });

  it("still draws one with only a poster, with no pictures, or with a long title", async () => {
    for (const extra of [
      { poster: await picture(600, 900, "#a02020") },
      {},
      {
        title:
          "A Very Long Title That Keeps Going Well Past What Fits On Three Lines Of The Banner",
      },
      { poster: Buffer.from("not a picture") },
    ]) {
      const png = await makeBanner({ ...input, ...extra });
      expect(size(png!)).toEqual([BANNER_W, BANNER_H]);
    }
  });
});
