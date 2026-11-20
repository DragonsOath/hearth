# Installing Hearth from a release

A release is one archive, `hearth-<version>-linux.tar.gz`: the built app, its runtime packages,
and the installer. Nothing is built on your machine, so it needs only Linux with systemd, Node.js
24 or newer, and curl (no pnpm, no compiler).

## 1. Download and check it

From the release page, or with the GitHub CLI:

```sh
gh release download v0.1.0 --repo <owner>/<repo> --pattern 'hearth-*'
sha256sum -c hearth-0.1.0-linux.tar.gz.sha256
```

## 2. Unpack it where it will live

```sh
mkdir -p /srv/hearth
tar --strip-components=1 -xzf hearth-0.1.0-linux.tar.gz -C /srv/hearth
```

The folder now has a `RELEASE` file naming the version and commit.

## 3. Check, then install

Always run a dry run first: it changes nothing and shows the settings, every command, and the
service file it would write.

```sh
cd /srv/hearth
bash deploy/linux/install.sh --dry-run
bash deploy/linux/install.sh
```

The dry run says "nothing to build: release 0.1.0 is already built". Every setting
(`DC_DATA_DIR`, `DC_KEY_DIR`, `DC_BACKUP_DIR`, `DC_PORT`, the account it runs as, limits) works as in
the [README](../README.md) and [`.env.example`](../.env.example). The installer never takes over a
folder owned by someone else, and it stops if it would touch another installation.

**Another Hearth already on this machine?** Give this one its own name, account, folder, and port:
see [MULTIPLE_INSTALLS.md](MULTIPLE_INSTALLS.md). With more than one installation, the installer
refuses to run unless `DC_SERVICE_NAME` says which one.

## 4. First start

The installer prints a one-time setup link. Open it to create your account, then connect your AI
(Hearth's welcome guides you).

## Updating

1. Download and check the new archive (step 1).
2. Unpack it over the same folder (step 2). Your data, keys, and backups are not in the archive, so
   they are kept. Keep the previous archive until the new version has run well.
3. Run `bash deploy/linux/install.sh --dry-run`, then without `--dry-run`. It keeps the installed
   settings and restarts the service.

## Rolling back

Unpack the previous archive over the folder and run the installer again. The data stays; a newer
version's database changes are kept, so restore the database from Hearth's own backup (in
`DC_BACKUP_DIR`) if the older version cannot read it.

## Removing

`bash deploy/linux/install.sh --uninstall` removes the service and keeps the data, keys, and
backups. Delete those folders yourself if you want them gone; without the key folder, backups
cannot be opened.
