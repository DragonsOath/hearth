import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readTorrentFile } from "./torrent-file";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

describe("reading a .torrent file", () => {
  it("names a single-file torrent and gives its v1 info hash", () => {
    const info =
      "d6:lengthi1234e4:name9:movie.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae";
    const file = enc(`d8:announce19:http://t.example/an4:info${info}e`);
    const r = readTorrentFile(file);
    expect(r).toEqual({
      name: "movie.mkv",
      hash: createHash("sha1").update(enc(info)).digest("hex"),
      sizeBytes: 1234,
    });
  });

  it("adds up a multi-file torrent's sizes", () => {
    const info =
      "d5:filesld6:lengthi100e4:pathl5:a.mkveed6:lengthi50e4:pathl5:b.nfoeee4:name4:Pack12:piece lengthi16384e6:pieces20:bbbbbbbbbbbbbbbbbbbbe";
    const r = readTorrentFile(enc(`d4:info${info}e`));
    expect(r).toMatchObject({ name: "Pack", sizeBytes: 150 });
  });

  it("says plainly when a file is not a torrent", () => {
    expect(readTorrentFile(enc("hello"))).toEqual({
      error: "It is not a .torrent file, or it is damaged.",
    });
    expect(readTorrentFile(enc("d3:fooi1ee"))).toEqual({
      error: "It is not a .torrent file (no info).",
    });
    expect(readTorrentFile(new Uint8Array())).toEqual({ error: "The file is empty." });
  });
});
