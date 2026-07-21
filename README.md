# Hearth

The always-watching Bitcoin wallet for the people you trust. A self-hosted
household wallet, block explorer, solo-mining dashboard, and watchtower in a
single container — built for [Umbrel](https://umbrel.com/), runs anywhere
Docker does.

## Developing

```sh
npm install
npm run dev
```

Copy `.env.example` to `.env` and adjust for your local Bitcoin Core / Fulcrum
setup (see `src/lib/server/config/index.ts`).

## Building

```sh
npm run build
```

The production entry point is `server.mjs` (not adapter-node's own `node
build`) -- it binds the HTTP (and optional HTTPS) listener before importing
the built app, and adds the self-signed TLS cert for hardware-wallet signing
on Umbrel. Run it with `node server.mjs` after `npm run build`.

## Testing

```sh
npm run test    # vitest, single run
npm run check   # svelte-check
```
