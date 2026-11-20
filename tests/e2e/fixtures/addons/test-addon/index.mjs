// A stand-in add-on for the browser tests: one route, one screen (tests/e2e/addons.spec.ts).
export const addon = {
  name: "test-addon",
  version: "0.0.1",
  api: 1,
  features: [],
  register(host) {
    host.app.get("/api/addons/test-addon/ping", async () => ({ ok: true }));
  },
};
