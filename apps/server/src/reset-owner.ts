import path from "node:path";
import { loadConfig } from "./config";
import { openDatabase, runMigrations } from "./db/client";
import { defaultKeyGuard } from "./auth/keyguard";
import { resetOwner } from "./auth/reset";
import { Auth } from "./auth/service";

/**
 * `pnpm owner:reset`: forget the owner so the installation can be set up
 * again. Run on the machine itself; there is no network route for this.
 * The running server notices at once: every session is gone.
 */
async function main() {
  const config = loadConfig();
  const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
  await runMigrations(handle, config.migrationsDir);
  const { secretsRemoved } = await resetOwner(handle);
  const auth = new Auth(handle, {
    dataDir: config.dataDir,
    keyGuard: defaultKeyGuard(config.keyDir),
  });
  const code = await auth.setupCode();
  handle.close();
  console.log(
    [
      "Owner reset. Monitoring data, settings, and history are kept.",
      `Vault secrets removed: ${secretsRemoved}.`,
      `Set it up again at http://localhost:${config.port}/setup?code=${code}`,
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error("Could not reset the owner:", error);
  process.exit(1);
});
