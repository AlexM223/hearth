# ---- build stage ------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Unlike cairn (which needed a node-gyp toolchain for the `usb` addon pulled in
# transitively by @trezor/connect-web), Hearth's dependency tree is pure
# JS/WASM end to end (DECISIONS.md §2 "no native addons" -- hardware wallets
# are browser-side only, src/lib/hw/, never imported on the server). A plain
# `npm ci` is enough; there is no build toolchain to install here.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# CI fails the build outright on any native `.node` file surviving into the
# pruned production tree (the no-native-deps guard, DECISIONS.md §5.1) --
# Smart App Control on Alex's Windows dev box blocks unsigned native addons,
# and the same posture is enforced here so dev and prod never diverge.
RUN sh -c 'if find node_modules -iname "*.node" | grep -q .; then \
    echo "ERROR: native .node addon(s) found in production dependency tree:"; \
    find node_modules -iname "*.node"; \
    exit 1; \
    fi'

# ---- runtime stage -----------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# Pin Hearth to UID/GID 1000 (replacing the base image's `node` user, which
# owns those IDs): Umbrel bind-mounts app data owned by 1000:1000 and runs
# services as `user: "1000:1000"`, so the in-image user must match for /data
# to be writable there.
RUN deluser node \
	&& addgroup -S -g 1000 hearth \
	&& adduser -S -u 1000 -G hearth hearth

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# Custom entry: adapter-node's handler on HTTP plus the optional self-signed
# HTTPS listener (secure context for WebHID/WebSerial hardware signing on Umbrel).
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/scripts/tls-cert.mjs ./scripts/tls-cert.mjs
COPY --from=build /app/scripts/serverProto.mjs ./scripts/serverProto.mjs

# SQLite database + logs + first-boot TLS cert live on the /data volume --
# mount it or lose it (DECISIONS.md §5.1, §5.4).
ENV HEARTH_DB=/data/hearth.db
ENV HEARTH_LOG_FILE=/data/logs/hearth.log
ENV PORT=3000
# Self-signed HTTPS listener; the cert is generated at first boot into
# /data/tls. Publish the port to enable it; an unpublished port is harmless.
ENV HEARTH_HTTPS_PORT=3443
# adapter-node's own default is a silent 512K, enough to 400 a legitimate
# large multisig PSBT (many inputs, each with a full nonWitnessUtxo). 200K
# gives headroom without opening the DoS guard too wide.
ENV BODY_SIZE_LIMIT=200K
# NOTE: deliberately no ADDRESS_HEADER default here -- adapter-node throws on
# any getClientAddress() call when the configured header is absent, which
# would break direct (unproxied) deployments. Umbrel's docker-compose.yml
# sets ADDRESS_HEADER=x-forwarded-for since app_proxy always provides it.
ENV NODE_ENV=production

RUN mkdir -p /data && chown hearth:hearth /data
VOLUME /data
USER hearth

EXPOSE 3000 3443

# Alpine ships no curl/wget; probe with node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
