# Web Console — Current Status

**Date**: 2026-08-06 · **Baseline**: 115 unit tests / 27 files green,
`tsc --noEmit` clean, web <-> API browser E2E passes, CI runs three
parallel jobs (backend / web / web-e2e).

The web console (`packages/web`) is the human-facing UI for the
SoulcloudJS platform: device management, decoded logs, firmware releases
and OTA rollouts. It is a plain SPA that talks to the Elysia REST API
(`:8080`) only — it never touches MQTT or the broker.

## Stack

| Layer | Choice |
| --- | --- |
| Build | Vite 6, route-level code splitting (`React.lazy`) |
| UI | React 19 + Material UI 9 (+ Data Grid 9, Emotion) |
| Data | TanStack Query 5 (server state, polling) + axios |
| Routing | React Router 7 (`createBrowserRouter`) |
| i18n | react-i18next (app strings) + MUI/Data Grid locale packages |
| Tests | bun:test + happy-dom + React Testing Library + user-event |

Dev server proxies `/v1` and `/health` to `http://localhost:8080`; the
same path prefixes are expected behind the production reverse proxy.

## Authentication flow

- **Access token**: kept in memory only (module state in `api/http.ts`),
  never persisted — it is short lived (15 min).
- **Refresh token**: `localStorage` (`soulcloud.refresh_token`), rotated
  on every refresh.
- **401 handling**: the axios response interceptor refreshes with a
  single-flight promise and retries the original request once; auth
  endpoints (`/v1/auth/login|register|refresh|logout`) are exempt to
  avoid refresh loops. A failed refresh wipes tokens and bounces to
  `/login`.
- **Session restore**: on page load `fetchMe()` gets a 401, the
  interceptor transparently refreshes and retries, and the app lands
  authenticated without a login screen.
- **Project selection**: `/v1/me` project list, persisted per browser
  (`soulcloud.project_id`), auto-corrected when the stored id vanishes.

## Pages

| Route | Page | Notes |
| --- | --- | --- |
| `/login`, `/register` | Auth | register logs in server-side (token pair) |
| `/` | Dashboard | project summary + device count |
| `/devices` | Device list | Data Grid, server pagination, empty-state guidance |
| `/devices/:deviceId` | Device detail | tabs: overview / commands / logs |
| `/logs` | Logs | device picker + decoded log stream |
| `/firmware` | Firmware | releases + ELF artifact tabs, upload dialogs |
| `/rollouts` | OTA list | progress bars, 10 s polling |
| `/rollouts/:rolloutId` | Rollout detail | per-state actions, phase stepper, 5 s polling |
| `/ota-jobs/:jobId` | OTA job | per-target table, 5 s polling |

Key interactions:

- **Create device**: dialog issues a one-time MQTT credential (shown once
  with a copy button); `device_uid` must be safe for MQTT topics.
- **Credentials**: two-step confirm dialog (old credential dies, live
  session kicked) then one-time password display.
- **Firmware bind**: device firmware hash <-> ELF artifact (backfills
  previously undecodable log events).
- **Commands**: JSON args validation, delivery timeout, history with
  per-state chips and batch detail dialog, 10 s polling.
- **Rollout creation**: auto strategy (editable cumulative ratios with
  client-side ascending/last=1 validation) or grouped strategy
  (device-set groups), rollback baseline picker, gating parameters.
- **Rollout control**: pause/resume/abort/rollback buttons enabled only
  in the applicable states.

## i18n

Five locales — Simplified Chinese (default), English, Russian, Ukrainian,
Italian. Dictionary completeness is compile-time enforced
(`Record<DictKey, string>`, missing keys fail `tsc`), placeholders are
consistent across locales (tested), and the Russian/Ukrainian
translations are genuine and non-overlapping (cross-checked in tests).
MUI component texts and the Data Grid follow the app locale via
`createTheme(baseTheme, locale)` and the grid locale packages; the
language menu in the app bar persists the choice.

## Testing

- **115 unit tests / 27 files** (`bun run --cwd packages/web test`):
  i18n dictionary invariants, axios auth flow (mock axios: Bearer
  injection, single-flight 401 refresh, exemption list, logout bounce),
  auth/project contexts, every page and dialog (rendering, validation,
  flows), API-layer URL/body construction, theme LinkBehavior.
- **Coverage**: 76% lines / 91% statements.
- **Browser E2E** (`scripts/web-e2e-ci.sh`): starts API + Vite, seeds a
  user, creates a device through the API, then verifies in a real
  browser that the frontend renders real backend data (login page,
  authenticated dashboard, device row, firmware/rollouts empty states).
  All browser calls share one agent-browser session; interactions are
  deterministic (business operations via the API layer, page state via
  `wait --text` conditions).
- CI: the `web` job runs typecheck + unit tests + build without a
  database; the `web-e2e` job installs agent-browser and runs the
  browser E2E against a fresh database.

## Known limits / open items

- **Deployment**: production images + compose are in place (api/broker via
  `Dockerfile.backend`, web via `packages/web/Dockerfile` — the built SPA
  is served by Bun itself with `packages/web/server.ts`). TLS termination
  and `/v1` routing to the API are expected at the reverse proxy (traefik
  in the reference deployment), outside the base compose file.
- **Bundle size**: the main chunk is ~636 KB minified (MUI); route-level
  splitting is in place, a manualChunks split is a future optimisation.
- **No auth UI for MQTT device enrollment flows beyond create-device**
  (device onboarding is intentionally minimal).
- Full-text log search, object storage archive, retention policies and
  org/tenant tenancy remain backend-side open items (same scope as the
  Rust version).
