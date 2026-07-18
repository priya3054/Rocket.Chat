# Specmatic contract testing

Contract testing for the Rocket.Chat REST API using
[Specmatic](https://specmatic.io) against the project's official OpenAPI
spec. Self-contained: doesn't touch `apps/`, `packages/`, or any other part
of the build.

## Ground rules

- **The contract never changes.** `contracts/` is a git submodule pinned to
  `priya3054/Rocket.Chat-Open-API`'s `main` branch, which is a plain,
  untouched mirror of upstream `RocketChat/Rocket.Chat-Open-API` (verified
  same commit as upstream when pinned: `ad77de5`). No fork with hand-applied
  fixes is used anywhere in this setup. When Specmatic finds a mismatch
  between the contract and the live app, the app gets fixed — not the spec.
- The one exception: an objective, mechanical defect that blocks
  parsing/testing entirely (invalid OpenAPI syntax, a value that crashes
  Specmatic itself). Even then the spec is never edited here — the affected
  operation is excluded via Specmatic's own filter/config, logged below, and
  left for a decision on whether to raise it against the spec repo
  separately, on its own timeline.
- Docker image: `specmatic/specmatic:2.50.0` (open source), not any
  Enterprise/commercial image.

## Layout

```
contracts/          Git submodule -- priya3054/Rocket.Chat-Open-API @ main,
                     pinned to a commit SHA. Read-only. All 12 spec files.
rocketchat-docker/   Docker Compose file for RocketChat + MongoDB.
specmatic/           Docker Compose overlay(s) running specmatic/specmatic,
                     configs, examples, and reports.
```

## Quickstart

Run from `rocketchat-docker/` so relative bind-mount paths resolve correctly
when merging multiple `-f` files.

### Bring up RocketChat + MongoDB

```sh
DEPRECATED_COMPOSE_ACK=1 docker compose up -d
```

Admin account is auto-provisioned (`admin` / `SpecmaticAdmin123!` by default,
override with `RC_ADMIN_PASS`) via
[`initialData.ts`](https://github.com/RocketChat/Rocket.Chat/blob/develop/apps/meteor/server/startup/initialData.ts)
on first boot of a fresh MongoDB container — if you're reusing an existing
container from a previous run, the admin user (and its password) already
exists and won't be reset by this env var.

### Consumer mock (stub server)

No RocketChat instance required — generated straight from the pinned specs
in `contracts/`.

```sh
DEPRECATED_COMPOSE_ACK=1 docker compose \
  -f compose.yml -f ../specmatic/compose.test.yml \
  --profile mock up specmatic-mock
```

Serves a schema-accurate fake RocketChat API on `http://localhost:9000`.

## Issues found and fixed

Updated as each spec file is worked through against the live app (Step 3 of
the restart plan). Categories:
- **App fix** — Rocket.Chat's behavior didn't match the contract; fixed in
  the app, contract untouched.
- **Spec blocker** — an objective OpenAPI defect prevented testing an
  operation at all; excluded via config, not patched, logged for a separate
  decision on raising it upstream.
- **Accepted drift** — a documented, deliberate mismatch left as-is (e.g.
  additive fields), not treated as a defect on either side.

### 2026-07-18 — Consumer mock smoke test (all 12 specs)

All 12 spec files (`authentication`, `content-management`, `integrations`,
`marketplace-apps`, `messaging`, `miscellaneous`, `notifications`,
`omnichannel`, `rooms`, `settings`, `statistics`, `user-management`) loaded
and parsed cleanly in Specmatic's `mock` command — no crashes, no fatal
parse errors. Confirmed by serving `GET /api/v1/me` (correctly rejected with
`400`/`R2001` for a missing required header, proving contract-aware
validation is active) and `POST /api/v1/login` (returned a schema-valid,
fully-populated fake response). No spec-blocker or app-fix entries yet —
those require the provider contract-test pass (Step 3) against the live
app, one spec file at a time, still to come.

No issues to report yet from this step.
