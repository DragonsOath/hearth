import { describe, expect, it } from "vitest";
import { preview } from "./WizarrSetup";

describe("a Wizarr step's preview", () => {
  it("shows its words, not its Markdown, without repeating the title", () => {
    expect(
      preview({
        title: "Get the app",
        markdown: "# Get the app\n\nInstall **Plex**, then [sign in](https://plex.tv).",
      }),
    ).toBe("Install Plex, then sign in.");
    expect(preview({ title: "", markdown: "# Welcome" })).toBe("Welcome");
  });

  it("never shows a step's own styling or HTML, only its words", () => {
    expect(
      preview({
        title: "You're in: Plex",
        markdown:
          '<style>.vault-shell { --vault-bg: #0d0915; }</style>\n<div class="vault-shell"><h1>You\'re in: Plex</h1><p>Enjoy &amp; ask for anything.</p></div>',
      }),
    ).toBe("Enjoy & ask for anything.");
  });
});
