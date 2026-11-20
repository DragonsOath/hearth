import { describe, expect, it } from "vitest";
import { shellWord } from "./shell";

describe("shellWord", () => {
  it("leaves a plain account name as it is", () => {
    expect(shellWord("hearth")).toBe("hearth");
    expect(shellWord("dc-svc_1.local")).toBe("dc-svc_1.local");
  });
  it("quotes a name with a space, so the command still works", () => {
    expect(shellWord("Home Server")).toBe('"Home Server"');
  });
  it("escapes what a quoted shell string would otherwise run or end", () => {
    expect(shellWord('a"b')).toBe('"a\\"b"');
    expect(shellWord("$(rm -rf ~)")).toBe('"\\$(rm -rf ~)"');
    expect(shellWord("`id`")).toBe('"\\`id\\`"');
    expect(shellWord("a\\b")).toBe('"a\\\\b"');
  });
});
