import { expect, test } from "@playwright/test";

// Remote Control in the Lair (11-04): /rc opens the conversation in the Claude app as
// "Hearth • <PC> • Lair • Main", what you type goes into that live session, and /rc again turns it
// off. The session here is a stand-in (DC_TEST_REMOTE_CONTROL), never the Claude app.

test("/rc in the Lair: the bar names the session, messages go live, /rc again turns it off", async ({
  page,
  request,
}) => {
  const connected = await request.post("/api/agent/providers/claude-code/connect");
  expect(connected.ok(), await connected.text()).toBe(true);
  // The Lair's main conversation, as the hub on Home continues it.
  const main = (await (await request.get("/api/agent/conversations/main")).json()) as {
    id: string;
  };
  await page.goto(`/ask/${main.id}`);
  const box = page.locator("textarea").first();
  const send = page.getByRole("button", { name: "Send" }).first();

  // Claude Code starts signed out here: /login signs it in from the chat (11-04).
  // The main conversation may hold an earlier run's sign-in: count, so each step waits for its own.
  const links = page.getByTestId("answer-link");
  const signedIn = page.getByText(/^Claude Code is signed in as owner@example\.com/);
  await expect(page.getByTestId("cave-thread")).toBeVisible({ timeout: 20_000 });
  const before = await links.count();
  const done = await signedIn.count();
  await box.fill("/login");
  await send.click();
  await expect(links).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(links.last()).toHaveText(/Open Anthropic's sign-in/);
  await box.fill("TESTCODE123#TESTSTATE");
  await send.click();
  await expect(signedIn).toHaveCount(done + 1, { timeout: 20_000 });
  await expect(page.getByText("TESTCODE123#TESTSTATE")).toHaveCount(0);
  await page.screenshot({
    path: `test-results/screens/${test.info().project.name}/lair-login.png`,
  });

  await box.fill("/rc");
  await send.click();
  const bar = page.getByTestId("cave-remote");
  await expect(bar).toBeVisible({ timeout: 20_000 });
  // Named as the conversation is (11-07), or Main while it has no name yet; never a command
  // such as /login (11-12).
  const { title } = (await (await request.get(`/api/agent/conversations/${main.id}`)).json()) as {
    title: string;
  };
  const shown = title === "New conversation" ? "Main" : title;
  await expect(page.getByTestId("cave-remote-title")).toContainText(` • Lair • ${shown}`);
  await expect(page.getByTestId("cave-remote-title")).not.toContainText("/login");
  await expect(bar).toContainText("Remote Control is on", { timeout: 20_000 });
  await expect(bar.getByRole("link", { name: "Open in Claude" })).toHaveAttribute(
    "href",
    "https://claude.ai/code/session_E2E1",
  );
  await page.screenshot({
    path: `test-results/screens/${test.info().project.name}/lair-remote.png`,
  });

  await box.fill("how full is the media drive?");
  await send.click();
  await expect(page.getByText("From the live session: how full is the media drive?")).toBeVisible({
    timeout: 20_000,
  });

  await box.fill("/rc");
  await send.click();
  await expect(page.getByText("Remote Control is off. Type /rc to turn it back on.")).toBeVisible({
    timeout: 20_000,
  });
  await expect(bar).toBeHidden({ timeout: 20_000 });

  // Leave Hearth as the other tests expect it: no AI connected, Claude Code signed out.
  await request.post("/api/agent/claude/sign-out");
  await request.post("/api/agent/disconnect");
});
