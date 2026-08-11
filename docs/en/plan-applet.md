# SoulCloud Applet Plan — 品类应用框架（米家模式）

**Date**: 2026-08-09 · **Status**: plan (nothing implemented yet) · **Applies to**:
core platform as the shared base, per-product "applets" carrying category-specific
logic and UI — the way Mi Home ships core device capabilities plus per-category
plugins.

## Goal

Turn SoulcloudJS into a **platform + applet** product line: the existing
capabilities (device identity/connection, OTA, commands, logs, users/projects/
RBAC, web console) become the shared core; different products (smart lamps,
sensors, door locks, …) build their own features on top without forking or
modifying the core.

The essential insight, borrowed from the Mi Home model: **the applet boundary
is the device model, not the service.** Connectivity, authentication, topic
routing, OTA and RBAC are always core. An applet contributes:

1. a **capability model** (properties / commands / events for its product type),
2. **category-specific business logic** (rules, scenes, schedules, …),
3. **category-specific UI** (menu items, routes, device-detail tabs).

## Current gaps (what the core lacks today)

| Gap | Today | Needed |
| --- | --- | --- |
| Device type concept | `Device` has no type field; every device is the same kind | `Device.productType` |
| Capability model | property display/logic hard-coded in `DeviceDetailPage` | data-driven DSL (`AppletDefinition`) |
| Extension points | routes hard-wired in `app.ts`; menus/routes static in `router.tsx`/`AppLayout` | applet registry (frontend + backend) |

Everything else the core already has and can stay untouched (see
"Protocol layer" below).

## Design principles

1. **Core is product-agnostic.** The core code base contains zero knowledge of
   any category. Categories live in `packages/applets/*`.
2. **Cut along the device model, not along services.** No micro-services and no
   micro-frontends for Phase A/B. Monorepo sub-packages, statically integrated,
   built with the existing tooling.
3. **The broker ACL stays string-based.** Device identity and topic authorization
   must not require per-connection DB lookups. Applet-specific traffic lives in
   the **payload layer** of the existing generic channels.
4. **The core contract is additive.** Applets may only *add* endpoints, topics
   kinds, tables and UI surfaces; they never change core behavior or core
   contracts (API `/v1/*` shape, topic scheme, WS frame format).
5. **Inter-process integration already exists.** `pg_notify` + WS hubs
   (`packages/api/src/pg-listen.ts`, `useWebSocketStream`) are process-agnostic
   and carry over to an independent-service phase unchanged.

## Architecture

```
soulcloudjs/ (Bun workspace)
├── packages/core/               # core: schema, protocol, OTA, queue (minimal additions)
├── packages/api/                # core API: + generic capability API (read/write properties)
├── packages/broker/             # core: + one new uplink kind for property reports
├── packages/web/                # core UI: + AppletRegistry (dynamic menu/routes/tabs)
└── packages/applets/
    ├── core-types/              # AppletDefinition contract + registry helpers (no runtime)
    ├── demo-lamp/               # example applet: model + backend plugin + UI
    └── demo-sensor/             # example applet (illustrates multiple applets)
```

### 1. Device model DSL

Each applet declares its capability model; the core renders and serves it
generically:

```ts
// packages/applets/core-types/src/index.ts
interface PropertyDef {
  key: string;
  label: string;                 // i18n key in the applet dictionary
  type: "number" | "boolean" | "string" | "enum";
  min?: number; max?: number; step?: number;
  enumValues?: string[];
  writable: boolean;             // writable ⇒ core shows an editor and sends a command
  unit?: string;                 // display only
}

interface CommandDef {
  name: string;                  // payload.command
  params: { key: string; type: string }[];
}

interface AppletDefinition {
  id: string;                    // "demo-lamp"
  productTypes: string[];        // matched against Device.productType
  properties: PropertyDef[];
  commands: CommandDef[];
  menuItems: { label: string; path: string }[];
  routes: RouteDef[];            // lazy-loaded React routes (/lamp/:deviceId, …)
  deviceDetailTabs?: TabDef[];   // extra tabs appended to DeviceDetailPage
  backendRoutes?: ElysiaPlugin;  // category REST logic, mounted by core app.ts
}
```

Core additions driven purely by the DSL (no category knowledge):

- `DeviceProperty` table: `(device_id, key, value JSONB, updated_at)` — one row
  per reported property; core provides `GET/PUT /v1/devices/:id/properties`
  (authorization reuses the existing per-project membership check).
- The core device detail page renders a property panel automatically from the
  DSL (MUI controls generated from `type/min/max/enumValues/writable`).

### 2. Protocol layer (almost untouched)

| Need | Solution | Core change |
| --- | --- | --- |
| Property report (uplink) | new topic kind `soulcloud/v1/devices/{uid}/prop`, JSON payload | one new kind in `parseDeviceTopic` + broker `DOWNLINK`-independent uplink allow (no DB lookup) |
| Set property / run command | existing `cmd/exec`, payload `{applet, command, params}` | none |
| Result ack | existing `cmd/result` | none |
| Applet-specific event stream | existing WS infra (`pg_notify` + hub) | none |

Why this is safe: the broker's `authorizePublish`/`authorizeSubscribe`
(`packages/broker/src/mqtt/broker.ts`) stay pure string checks against the
client's own UID. An applet cannot widen a device's namespace; it only defines
what the *payload* means. If a future category genuinely needs its own topic
segment, the follow-up is a productType-aware authorize hook (DB lookup on
connect only, cached), not a redesign.

### 3. Frontend registry

```ts
// packages/web/src/applets/registry.ts
import { lampApplet } from "@soulcloud/applet-demo-lamp";
export const applets = [lampApplet, sensorApplet];
```

- `AppLayout` menu = core items + `applets.flatMap(a => a.menuItems)`
- `router.tsx` = core routes + `applets.flatMap(a => a.routes)` (React.lazy, Vite
  code-splits each applet)
- `DeviceDetailPage` looks up the applet by `device.productType`; renders its
  tabs + the auto-generated property panel
- i18n: applet dictionaries merge into the core dictionary at build time; the
  five-locale key-count invariant (`dictionary.test.ts`) is extended to cover
  applet dictionaries
- **No micro-frontend** (no runtime bundle loading): monorepo static
  integration + Vite splitting gives the same isolation for a fraction of the
  security/versioning/testing cost

### 4. Backend integration: in-process plugin first

- `app.ts` gains a `registerApplets(applets)` step that `.use()`s each applet's
  `backendRoutes` plugin — same process, same Prisma client, same test harness
- Data isolation by convention: applet Prisma models are prefixed
  (`LampScene`, `LampSchedule`) and documented in `schema.prisma`
- **Independent-service mode is Phase C**: traefik (`deploy/traefik/`) already
  has the routing pattern; add `/applets/{id}/*` → dedicated container. The
  pg_notify + WS hub infra is already cross-process, so event integration
  carries over unchanged

### 5. Permissions

The existing user/project/member RBAC applies unchanged (device properties and
applet routes go through the same membership checks). Per-project applet
enablement (`Project.appletIds`) is explicitly **not** planned until a product
requires it (YAGNI).

## Data model additions

- `Device.productType TEXT` (nullable in v1 — devices without an applet keep
  the current generic UI)
- `DeviceProperty (device_id FK, key, value JSONB, updated_at)`, unique
  `(device_id, key)`
- Applet tables: prefixed models in the shared Prisma schema for Phase A/B;
  revisit (multi-schema or separate DBs) only in Phase C

## Roadmap

| Phase | Content | Scope |
| --- | --- | --- |
| **A. Data-driven core** | `Device.productType` migration · `DeviceProperty` table + generic properties API (GET/PUT with membership auth) · `AppletDefinition` types · auto-rendered property panel in `DeviceDetailPage` · `/prop` uplink kind + broker allow | medium — the foundation, do first |
| **B. Applet framework** | `packages/applets/core-types` · frontend registry (menu/routes/tabs) · `app.ts` registration entry · two example applets (lamp + sensor) · contract tests (an applet that violates the contract fails CI) · i18n merge + key-count invariant | medium |
| **C. Optional evolution** | independent-service mode (`/applets/{id}/*` via traefik) · applet WS streams · per-project applet enablement | only when a real third-party/isolated deployment need appears |

## Explicit non-goals

- Micro-services / micro-frontends in Phase A/B
- Per-applet topic namespaces (payload-layer commands suffice; see above)
- Applet marketplace / runtime plugin loading
- Per-project applet enablement

## Risks

- **Prisma single-schema growth**: many applets ⇒ schema churn. Mitigation:
  prefixed models + strict additive-only rule; revisit in Phase C.
- **Contract drift**: an applet breaking the registry contract would take the
  core UI down with it. Mitigation: compile-time contract types + CI contract
  tests (Phase B item).
- **Core UI coupling**: DeviceDetailPage grows a "find applet by productType"
  lookup — must fail closed (no applet ⇒ current generic rendering, never a
  crash).
- **Rebuild cost**: applet route changes rebuild the whole web bundle (same as
  any monorepo SPA). Accepted; runtime loading remains a deliberate non-goal.
