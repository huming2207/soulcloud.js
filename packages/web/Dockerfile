# Web console production image: build the SPA with Bun, then serve the
# static output with Bun itself (no nginx). TLS and /v1 routing to the
# API are handled by the reverse proxy in front (traefik in the
# reference deployment).
FROM oven/bun:1.3-debian AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/broker/package.json packages/broker/package.json
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY packages/web packages/web
RUN bun run --cwd packages/web build

FROM oven/bun:1.3-debian
COPY --from=build /app/packages/web/dist /app/packages/web/dist
COPY --from=build /app/packages/web/server.ts /app/packages/web/server.ts
WORKDIR /app/packages/web
ENV WEB_PORT=8080
EXPOSE 8080
CMD ["bun", "run", "server.ts"]
