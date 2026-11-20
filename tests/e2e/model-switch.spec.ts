import { expect, test } from "@playwright/test";

// Switching models (the owner, 11-08: "if I wanted to switch from Opus to Fable"): Fable is offered
// beside Opus, Sonnet and Haiku, in Settings and under the Lair's chat box, and the two are the
// same setting. The War Room's own per-message picker offers it too.

test("switch the model that answers: Fable in Settings, then Haiku under the chat box", async ({
  page,
}) => {
  const request = page.request;
  try {
    await page.goto("/settings#cave");
    const setting = page.locator("#ai-model");
    await expect(setting).toBeVisible({ timeout: 20_000 });
    await expect(setting.locator("option")).toHaveText([
      "Your Claude Code's own model (recommended)",
      "Fable (newest and most capable)",
      "Opus (very capable, high cost)",
      "Sonnet (balanced, lower cost)",
      "Haiku (fastest, lowest cost)",
    ]);
    await setting.selectOption("fable");
    await expect
      .poll(
        async () =>
          (
            (await (await request.get("/api/ai/usage")).json()) as {
              budget: { questionModel: string };
            }
          ).budget.questionModel,
      )
      .toBe("fable");

    // The same choice under the Lair's chat box, switched there in one tap (shown when an AI is
    // connected: here the test Hearth's stand-in Claude Code).
    await request.post("/api/agent/providers/claude-code/connect", { data: {} });
    await page.goto("/ask");
    const chip = page.getByTestId("cave-model").first();
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(chip).toHaveValue("fable");
    await chip.selectOption("haiku");
    await expect
      .poll(
        async () =>
          (
            (await (await request.get("/api/ai/usage")).json()) as {
              budget: { questionModel: string };
            }
          ).budget.questionModel,
      )
      .toBe("haiku");
    await page.screenshot({
      path: `test-results/screens/${test.info().project.name}/model-switch.png`,
    });

    // The War Room's per-message picker accepts Fable as a model for Claude Code.
    const state = (await (await request.get("/api/engine/state")).json()) as {
      config?: { engines?: Record<string, { models?: string[] }> };
    };
    expect(state.config?.engines?.["claude-code"]?.models).toContain("fable");
  } finally {
    await request.patch("/api/ai/budget", { data: { questionModel: "default" } });
  }
});
