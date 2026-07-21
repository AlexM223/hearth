# Ingle App Store

A small [Umbrel community app store](https://github.com/getumbrel/umbrel-community-app-store)
hosting **Hearth** (`ingle-hearth`) — the always-watching, self-hosted
household Bitcoin wallet: shared wallets (watch-only, single-sig, multisig)
with in-browser hardware-wallet signing, invite-by-link members, an own-node
block explorer, an optional solo Stratum mining pool, and a fail-closed
watchtower notifier. Source: [AlexM223/hearth](https://github.com/AlexM223/hearth).

## Installing

In umbrelOS: **App Store → ⋯ → Community App Stores**, paste this repo's URL:

```
https://github.com/AlexM223/hearth-app-store
```

then open the **Ingle** store and install **Hearth**. Umbrel will prompt to
install its dependencies (Bitcoin node + an Electrum server — Umbrel's
`electrs` app or Fulcrum both work).

## Layout

```
umbrel-app-store.yml       -- store id ("ingle") + display name ("Ingle")
ingle-hearth/
  umbrel-app.yml           -- app manifest (community stores require the
                              store-id prefix on every app id, hence
                              "ingle-hearth" rather than bare "hearth")
  docker-compose.yml       -- digest-pinned multi-arch image + Umbrel wiring
  icon.svg, 1.jpg .. 5.jpg -- store assets, referenced by raw GitHub URL
                              from the manifest
  data/logs/.gitkeep       -- committed empty bind-mount source dirs
  data/tls/.gitkeep
```

The canonical copy of this content lives in the main Hearth repo under
`packaging/store-repo/`; the two are kept in sync by hand.

## Ports beyond the app page

- **4489** — self-signed HTTPS listener; gives the browser the secure
  context that Ledger (WebHID) and camera QR-scanning need. Your browser
  will ask you to accept the certificate the first time — that's expected.
- **3343 / 3345** — Stratum V1 (standard / ASIC-floor difficulty). Nothing
  listens on either until solo mining is switched on in the app.

## Support

Issues and questions: <https://github.com/AlexM223/hearth/issues>
