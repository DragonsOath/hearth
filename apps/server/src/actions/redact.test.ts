import { describe, expect, it } from "vitest";
import { redactLine } from "./redact";

describe("redactLine", () => {
  it("hides API keys in query strings and headers", () => {
    expect(redactLine("GET /api/v3/queue?apikey=0123456789abcdef0123456789abcdef&page=2")).toBe(
      "GET /api/v3/queue?apikey=[hidden]&page=2",
    );
    expect(redactLine("X-Api-Key: s3cr3tValue")).toBe("X-Api-Key: [hidden]");
    expect(redactLine("Authorization: Bearer abc.def.ghijklmnop")).toBe("Authorization: [hidden]");
  });

  it("hides passwords in URLs and JSON", () => {
    expect(redactLine("connecting to postgres://romm:hunter22@romm-db:5432/romm")).toBe(
      "connecting to postgres://[hidden]@romm-db:5432/romm",
    );
    expect(redactLine('{"username":"alex","password":"hunter22"}')).toBe(
      '{"username":"alex","password":"[hidden]"}',
    );
  });

  it("hides tokens and long hex keys on their own", () => {
    expect(redactLine("token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f")).toBe(
      "token [hidden]",
    );
    expect(redactLine("key 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b")).toBe("key [hidden]");
  });

  it("strips terminal colours and leaves ordinary lines alone", () => {
    expect(redactLine("\x1b[32mINFO\x1b[0m Server started on port 8096")).toBe(
      "INFO Server started on port 8096",
    );
    expect(redactLine("Scanned 6,945 files in 1.2s")).toBe("Scanned 6,945 files in 1.2s");
  });
});
