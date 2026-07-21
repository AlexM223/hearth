# Ingle App Store

Alex's personal Umbrel community app store. Currently hosts one app:
**Hearth** (`ingle-hearth`), the self-hosted household Bitcoin wallet.

> **Status: not yet published.** This directory is prepared, locally-built
> content, ready to become a real GitHub repository
> (`AlexM223/hearth-app-store`) whenever Alex chooses to push it -- nothing
> here has been pushed anywhere. See "What's still needed before this is
> real," below.

## What this is

A [community app store](https://github.com/getumbrel/umbrel-community-app-store)
for umbrelOS: a small, self-hosted alternative to submitting an app through
the official `getumbrel/umbrel-apps` review process (DECISIONS.md §5.5 --
Hearth deliberately ships this way, under its own new brand, rather than
reusing or extending Heartwood's app listing).

## Adding this store to Umbrel (once it's real)

In umbrelOS: **App Store -> Community App Stores -> Add a Community App
Store**, then paste this repo's GitHub URL
(`https://github.com/AlexM223/hearth-app-store`). Hearth will then appear
in the App Store UI as **Hearth**, installable like any other app, alongside
its `bitcoin`/`electrs` dependency prompts.

## Layout

```
umbrel-app-store.yml      -- store id ("ingle") + display name ("Ingle")
ingle-hearth/
  umbrel-app.yml           -- the app manifest (id MUST carry this store's
                               "ingle-" prefix per Umbrel's community-store
                               rule -- see below)
  docker-compose.yml        -- same content as the canonical package, with
                               APP_HOST adjusted for the ingle-hearth id
  data/logs/.gitkeep         -- committed empty bind-mount source dirs
  data/tls/.gitkeep
```

## Why `ingle-hearth`, not just `hearth`

Umbrel's community-store contract requires every app id in a community store
to start with that store's own id (confirmed against the official
`getumbrel/umbrel-community-app-store` template: its example app is
`sparkles-hello-world` under a store id of `sparkles`). This store's id is
`ingle` (Hearth's own design-system name, DECISIONS.md §1/§3) -- alphabets
and dashes only, no digits, per Umbrel's own rule for store ids (which is
why it isn't, say, `alexm223`). That makes this app's id `ingle-hearth`.

This is a **real difference** from the canonical package at
`packaging/umbrel/hearth/` in the main Hearth repo, which keeps the bare id
`hearth` (correct if that package is ever instead submitted to the official
`getumbrel/umbrel-apps` store, where no store-id prefix applies). The two
copies are otherwise the same app at the same version; keep them in sync by
hand when either changes, or write a small sync script if that becomes
tedious. `docker-compose.yml`'s `APP_HOST` is the one line that must track
the id (`ingle-hearth_web_1`, not `hearth_web_1`) -- container names always
follow `<app-id>_<service-name>_1`.

## Also different from the official-store package: `icon:` and `gallery:`

The official-store skill says to omit `icon:` and use bare gallery filenames
(`gallery: []` for a new package) because `getumbrel/umbrel-apps` hosts icon
and gallery assets in a separate repo. A community store has no such
separate hosting -- confirmed against the official template's own example
app (`sparkles-hello-world/umbrel-app.yml`), which sets `icon:` to a real
image URL and `gallery:` to full hosted image URLs (imgur, in the example).
This manifest's `icon:` and `gallery:` entries point at
`raw.githubusercontent.com/AlexM223/hearth-app-store/main/ingle-hearth/...`
paths -- the assets live right here in the app's directory: `icon.svg`
(256x256, a scale-up of the app's own favicon flame) and `1.jpg`..`5.jpg`
(1440x900, captured per `packaging/umbrel/hearth/GALLERY.md`'s shot list
against a live instance wired to a real node).

## Lint status

Verified against the same real `getumbrel/umbrel-apps` linter used for the
canonical package (with the `hearth` copy removed from that checkout first,
since testing both id copies side by side in one checkout produces false
self-collision errors that would never occur in real deployment -- only one
of the two ever ships at a time). Result: the same three
expected/documented findings as the canonical package
(`packaging/umbrel/hearth/LINT-RESULTS.md`) -- `manifest.submission` (no
official-store PR, by design) and `image.pinned` (placeholder digest, by
design) -- and nothing else. No port or id collisions.

## Status

Published. The 0.1.0 image is on GHCR (multi-arch, digest-pinned in
`ingle-hearth/docker-compose.yml`), the icon and the five gallery shots are
committed alongside the manifest, and this directory's contents live at
`github.com/AlexM223/hearth-app-store` (default branch `main`, which the
manifest's raw URLs reference). The canonical copy of this content stays in
the main Hearth repo under `packaging/store-repo/` -- keep the two in sync
by hand when either changes.

Remaining follow-ups tracked in the main repo's release checklist: install
through a real Umbrel device (fresh install, dependency prompts, restart,
update-path) and recapture gallery shot 4 with a live regtest mining
worker instead of the dashboard's off-state.
