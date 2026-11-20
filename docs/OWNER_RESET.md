# Replacing the owner password and passkey

Use this when the installation was set up with a temporary password (as the home server was, during
installation), or when the owner password is lost and no recovery key is available. Do it
**before** storing sensitive credentials in the Secure Vault: a reset removes the vault.

## What a reset does

- Removes: the owner password, all passkeys, all sign-in sessions (every browser and phone is
  signed out), the recovery key, and the Secure Vault with its secrets (its encryption keys belong
  to the owner, so its secrets could never be opened again).
- Keeps: services, monitoring history, incidents, jobs, memories and the pending import drafts,
  conversations, projects, jurisdiction, settings, saved layouts, and access keys (Home Assistant,
  companion).
- Only works on the machine itself. There is no network route for it.

## Steps (the home server)

Run these yourself in a terminal on the home server (SSH is fine). Nothing here is typed into
Hearth by anyone else, and no secret appears on screen except the one-time setup code.

1. **Back up first** (a normal Hearth backup, kept with the others):

   ```
   cd /srv/homelab/projects/dragon-control
   DC_DATA_DIR=$PWD/data DC_KEY_DIR=/srv/homelab/secrets/dragon-control \
   DC_BACKUP_DIR=/srv/homelab/backups/dragon-control DC_OFFSITE_NAME="Home Vault" \
   pnpm backup:now
   ```

2. **Reset the owner** (Hearth keeps running; it notices at once):

   ```
   DC_DATA_DIR=$PWD/data DC_KEY_DIR=/srv/homelab/secrets/dragon-control pnpm owner:reset
   ```

   It prints a line like `Set it up again at http://localhost:7400/setup?code=ABCD-1234`.

3. **Set it up again.** On your phone or computer, open the same path on the Tailscale address,
   keeping the code: `https://homeserver.tail1a2b3c.ts.net/setup?code=ABCD-1234`. Choose your own
   password (use your password manager to generate and keep it). The code works once.

4. **Save the recovery key** (setup step 2 of 3) in your password manager. It is the only way
   back in if you lose both the password and your passkeys.

5. **Add your passkey** (setup step 3 of 3, "Unlock with your fingerprint") on the device you are
   using. On each other device you sign in from: Settings > Security > "Add a passkey on this
   device". On a computer, Chrome can also use the phone's passkey through its QR code.

6. **Check:** sign out, then sign in with the passkey; open Settings > Security and confirm your
   identity with the new password.

Then add credentials to the Secure Vault (for example the API keys the Diagnostics panels ask
for).

If anything goes wrong, the backup from step 1 restores the previous state, including the
temporary owner.
