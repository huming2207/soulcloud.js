# Web console production image: build the SPA with Bun, serve the static
# output with a minimal nginx (SPA fallback + immutable asset caching).
# No reverse proxying inside this container: compose exposes the API,
# web and MQTT ports directly and the proxy in front (traefik in the
# reference deployment) routes /v1 + /health to the api service and
# terminates TLS.
FROM oven/bun:1.4-debian AS build
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

FROM nginx:1.27-alpine
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
