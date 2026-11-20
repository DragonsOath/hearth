import { describe, expect, it } from "vitest";
import { normalizeWebAddress } from "./systems";

describe("normalizeWebAddress", () => {
  it("accepts an address the way people type it", () => {
    expect(normalizeWebAddress("192.168.1.20:8080")).toBe("http://192.168.1.20:8080");
    expect(normalizeWebAddress(" nas.local/app/ ")).toBe("http://nas.local/app");
    expect(normalizeWebAddress("https://tasterr.example.com")).toBe("https://tasterr.example.com");
  });

  it("says plainly what is wrong", () => {
    expect(() => normalizeWebAddress("")).toThrow(/Enter its web address/);
    expect(() => normalizeWebAddress("ftp://nas.local")).toThrow(/http:\/\/ or https:\/\//);
    expect(() => normalizeWebAddress("http://")).toThrow(/does not look like a web address/);
    expect(() => normalizeWebAddress("http://me:secret@nas.local")).toThrow(/username/);
  });
});
