import { expect, test } from "@playwright/test";

// The weather (11-05): where it is for and where it comes from; a place set by town (the
// National Weather Service in the US, Open-Meteo elsewhere); more places small; and back to
// Home Assistant's own.

test("weather: the place and source, choosing places, more places small", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  test.skip(info.project.name === "mobile", "One run is enough: it is about the settings.");
  const run = `wx${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.19`;
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await page.request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
  const id = ((await res.json()) as { id: string }).id;
  await page.request.post("/api/vault/secrets", {
    data: {
      name: `Home Assistant ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-home-token",
    },
  });
  try {
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
    const home = page.getByTestId("home-dashboard");
    // No place set and no home location: Home Assistant's own weather, and it says so.
    await expect(home.getByTestId("home-weather")).toContainText("18°C", { timeout: 20_000 });
    await expect(home.getByTestId("home-weather-source")).toContainText("Home Assistant");

    // Set a place by town: the National Weather Service's weather for it.
    await home.getByTestId("home-weather").click();
    const win = page.getByTestId("home-weather-places");
    await win.getByTestId("home-weather-find").fill("Testville");
    await win.getByRole("button", { name: "Find" }).click();
    await win.getByTestId("home-weather-found").filter({ hasText: "Testville, AZ" }).click();
    await expect(win.getByTestId("home-weather-place")).toHaveCount(1);
    // And another place, outside the US (Open-Meteo), shown small.
    await win.getByTestId("home-weather-find").fill("Faraway");
    await win.getByRole("button", { name: "Find" }).click();
    await win.getByTestId("home-weather-found").first().click();
    await expect(win.getByTestId("home-weather-place")).toHaveCount(2);
    await page.getByTestId("modal-close").click();

    await expect(home.getByTestId("home-weather-source")).toContainText(
      "Testville, AZ · National Weather Service",
      { timeout: 20_000 },
    );
    await expect(home.getByTestId("home-weather")).toContainText("°C");
    await expect(home.getByTestId("home-cities")).toContainText("Faraway");
    await page.screenshot({ path: `test-results/screens/${info.project.name}/home-weather.png` });

    // Back to Home Assistant's own weather.
    await home.getByTestId("home-weather").click();
    await page.getByText("Use Home Assistant's own weather instead").click();
    await page.getByTestId("modal-close").click();
    await expect(home.getByTestId("home-weather-source")).toContainText("Home Assistant", {
      timeout: 20_000,
    });
  } finally {
    await page.request.post("/api/home/weather/places", { data: { source: "auto", places: [] } });
  }
});
