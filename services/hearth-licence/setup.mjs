// Sets up Hearth's licence service on Cloudflare (run by the owner, from this folder):
//   node setup.mjs
// It makes or updates the tables, deploys the Worker, and gives it its own signing key and the
// key that signs the owner's sign-in cookie. Private halves go straight into Cloudflare secrets
// and are never shown or saved; only the service's public key is printed, for PRODUCTION_KEYS.
// Safe to run again: whatever is already done is skipped.
//
// The code site's GitHub sign-in needs one thing from the owner: a GitHub OAuth app (see
// README.md). Its client id goes in wrangler.toml; its secret: npx wrangler secret put GITHUB_CLIENT_SECRET
import { execSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";

const run = (cmd) => execSync(cmd, { stdio: "inherit", shell: true });
const quiet = (cmd) => spawnSync(cmd, { shell: true, encoding: "utf8" });
run("npx wrangler d1 execute hearth-licence --remote --file schema.sql -y");
// Columns added later (the code site 11-17, the Founder offer's holds and its reasons 11-20): each
// is skipped when
// it already exists. Only ever added, never changed or removed.
for (const [table, col] of [
  ["codes", "campaign_id TEXT"],
  ["codes", "note TEXT"],
  ["codes", "hint TEXT"],
  ["codes", "created_at TEXT"],
  ["founder_offer", "hold_minutes INTEGER"],
  ["founder_offer", "claims_announced INTEGER NOT NULL DEFAULT 0"],
  ["founder_offer", "intro_posted INTEGER NOT NULL DEFAULT 0"],
  ["founder_entries", "held_until TEXT"],
  ["founder_offer", "ended_at TEXT"],
  ["founder_entries", "reason TEXT"],
  ["founder_entries", "told_at TEXT"],
]) {
  const r = quiet(
    `npx wrangler d1 execute hearth-licence --remote -y --command "ALTER TABLE ${table} ADD COLUMN ${col}"`,
  );
  if (r.status !== 0 && !/duplicate column/i.test(`${r.stdout}${r.stderr}`)) {
    console.error(r.stdout, r.stderr);
    process.exit(1);
  }
}
run("npx wrangler deploy");
const secrets = execSync("npx wrangler secret list", { encoding: "utf8", shell: true });
const put = (name, value) => {
  const r = spawnSync(`npx wrangler secret put ${name}`, {
    input: value,
    shell: true,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (!secrets.includes("SESSION_KEY")) put("SESSION_KEY", randomBytes(32).toString("base64url"));
if (secrets.includes("SIGNING_KEY")) {
  console.log("\nThe service already has its signing key.");
} else {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  put("SIGNING_KEY", privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
  console.log(`\nThe licence service's public key (for PRODUCTION_KEYS): ${raw}`);
}
if (!secrets.includes("GITHUB_CLIENT_SECRET"))
  console.log(
    "\nThe code site stays shut until its GitHub sign-in is set: see README.md, The code site.",
  );
