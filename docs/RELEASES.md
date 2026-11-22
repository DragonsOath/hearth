# Releases and channels

Hearth has two release channels.

- **Stable**, the default for new installs: releases marked stable on GitHub (not prereleases).
  A release is marked stable after it has run on the fast channel first.
- **Fast**: every published release, as soon as it is out, prereleases included. For people who
  opt in: `HEARTH_CHANNEL=fast` with the installer, or Settings, About, Release channel.

An install remembers the channel it was installed with (`install.json`) until the owner picks one
in Settings. Hearth's update check looks only at releases on its channel, and Update now installs
exactly the version the check found. Running the installer again never moves Hearth to an older
release on its own: a fast install run again on stable stays where it is and says so.
`HEARTH_VERSION` installs one exact version.

## Cutting a release

1. Push a tag like `v0.88.0` from main. `.github/workflows/release.yml` builds the Linux archive,
   checks that it starts, attests its build provenance, and attaches it to a **draft**
   prerelease.
2. Publish it to the **fast** channel (it stays a prerelease):

   ```sh
   gh release edit v0.88.0 -R DragonsOath/hearth --draft=false
   ```

3. Once it has run on the fast channel, mark it **stable**. This also announces it on Discord
   (`discord-release.yml` runs on GitHub's `released` event):

   ```sh
   gh release edit v0.88.0 -R DragonsOath/hearth --prerelease=false --latest
   ```

## Checking a download

The Linux archive and the Android app carry a build provenance attestation from the release
workflow. Anyone can confirm a download was built from this repository's tagged source:

```sh
gh attestation verify hearth-0.88.0-linux.tar.gz -R DragonsOath/hearth
```

The installer also checks each archive against the SHA-256 file published with it. Releases before
0.88.0 have the checksum only. On Windows, `get.ps1` downloads the tagged source and builds it on
the PC. The closed Premium package is built elsewhere and is not attested publicly.
