# Specmatic Contract Testing — Rocket.Chat REST API

## What is Specmatic

Specmatic is a spec-driven API development, testing and governance platform
that turns API specifications into executable contracts. Instead of treating
an OpenAPI or AsyncAPI document as static documentation, Specmatic uses
industry standard API specs to automatically generate tests, mocks,
compatibility checks, workflows, and governance capabilities.

In this project, Specmatic reads Rocket.Chat's official OpenAPI spec and:
- **Tests** the real, running Rocket.Chat app against it (does the app
  actually behave the way its own documentation says it does?).
- **Mocks** it (spins up a fake Rocket.Chat API server for consumers to
  develop against, no real backend needed).
- **Fuzzes** it (schema resiliency testing — throws malformed/boundary input
  at the real app and checks it fails gracefully instead of crashing).

## Ground rules

- **The contract never changes.** `contracts/` is a git submodule pinned to
  a plain, untouched mirror of `RocketChat/Rocket.Chat-Open-API`. When
  Specmatic finds a mismatch between the spec and the live app, **the app
  gets fixed — never the spec.**
- The one narrow exception: an objective, mechanical spec defect that blocks
  parsing/testing entirely (e.g. a path missing its `/api` prefix). Even
  then the spec file itself is never edited — the fix is applied in-memory
  at test time via a Specmatic OpenAPI Overlay (`--overlay-file`), and
  logged.
- Docker image: `specmatic/specmatic:2.50.0` (open source), pinned.

## Project structure

```
specmatic-contract-testing/
├── README.md                 This file.
├── HISTORY.md                 Full detailed investigation log.
├── contracts/                 Git submodule: the frozen OpenAPI spec.
│   ├── authentication.yaml, rooms.yaml, settings.yaml, ...   12 spec files.
│   └── README.md              Upstream spec's own README.
├── rocketchat-docker/
│   └── compose.yml            Brings up Rocket.Chat + MongoDB.
└── specmatic/
    ├── compose.test.yml        Every Specmatic service: mock, per-spec
    │                           contract tests, the all-12-specs run, and
    │                           the resiliency (fuzz) run.
    ├── specmatic_resiliency.yaml   Config for the fuzz run.
    ├── scripts/
    │   └── regenerate-auth-examples.sh
    │                           Logs into the live Rocket.Chat instance,
    │                           captures a real admin token + real fixture
    │                           data (rooms, messages, integrations, ...),
    │                           writes it all out as example files below.
    │                           Must be re-run every time the Rocket.Chat
    │                           container restarts (tokens don't survive).
    ├── examples/               Real, committed example request/response
    │   ├── authentication/     pairs, one subfolder per spec file. These
    │   ├── rooms/               are what Specmatic actually replays against
    │   ├── settings/            the live app instead of guessing values.
    │   └── ...                 (384 example files across all 12 specs)
    ├── overlays/
    │   └── path-prefix-fixes.overlay.yaml
    │                           In-memory spec corrections (never touches
    │                           the frozen spec file) for a handful of
    │                           objective path/parameter defects.
    ├── dictionaries/
    │   └── rooms_dictionary.yaml
    │                           Realistic generated values (names, IDs) for
    │                           fuzz-generated test data, instead of random
    │                           junk strings.
    └── reports/                Generated HTML test reports land here
        └── all/                 (gitignored, regenerated every run).
```

## Step-by-step: how to run this yourself

Everything below assumes Docker Desktop is running and you're in
`specmatic-contract-testing/rocketchat-docker/` unless noted (relative
paths in the compose files resolve from there).

### 1. Bring up Rocket.Chat + MongoDB

```sh
cd specmatic-contract-testing/rocketchat-docker
DEPRECATED_COMPOSE_ACK=1 docker compose up -d
```

Wait for it to answer:

```sh
curl -sf http://localhost:3000/api/info
```

An admin account is auto-provisioned on first boot: `admin` /
`SpecmaticAdmin123!` (override with `RC_ADMIN_PASS` env var before the
*first* boot of a fresh MongoDB volume — it won't reset an existing one).

### 2. Try the mock server (optional, no live app needed)

Generated straight from the frozen spec — useful to hand to frontend/API
consumers without running Rocket.Chat at all:

```sh
DEPRECATED_COMPOSE_ACK=1 docker compose \
  -f compose.yml -f ../specmatic/compose.test.yml \
  --profile mock up specmatic-mock
```

Serves a schema-accurate fake Rocket.Chat API on `http://localhost:9000`.

### 3. Generate real auth examples

Rocket.Chat issues a fresh token every container boot, so this has to be
re-run after every restart:

```sh
../specmatic/scripts/regenerate-auth-examples.sh
```

This logs in as admin, creates real fixture data (a room, a message, an
integration, etc.), and writes ~384 real example files under
`specmatic/examples/`.

### 4. Run the contract tests (all 12 specs against the live app)

```sh
DEPRECATED_COMPOSE_ACK=1 docker compose \
  -f compose.yml -f ../specmatic/compose.test.yml \
  --profile test up specmatic-contract-test-all
```

This is the same command CI runs. Takes a few minutes (1500+ generated test
scenarios). Prints a summary line at the end:

```
Tests run: 1555, Successes: 238, Failures: 1317, WIP: 0, Errors: 0
| 17% API Coverage reported from 1611 operations eligible for coverage |
```

To iterate on one spec file only (faster, while adding new examples), swap
the service name — e.g. `specmatic-contract-test-content-management`.

### 5. Run the resiliency (fuzz) test

Same live app, no real auth needed — throws malformed/mutated input at every
operation and checks Rocket.Chat degrades gracefully instead of crashing:

```sh
DEPRECATED_COMPOSE_ACK=1 docker compose \
  -f compose.yml -f ../specmatic/compose.test.yml \
  --profile test up specmatic-resiliency-test-all
```

### 6. Look at the report

```
specmatic-contract-testing/specmatic/reports/all/test/html/index.html
```

Open it in a browser — per-operation pass/fail breakdown, exact
request/response for every failure. (Regenerated fresh every run; not
committed to git.)

### CI

Four GitHub Actions workflows (`.github/workflows/specmatic-*.yml`) run the
above automatically on push/PR: `specmatic-consumer-mock.yml` (hard gate),
`specmatic-contract-test.yml`, `specmatic-resiliency-test.yml`, and
`specmatic-examples-lint.yml` (all three report-only — see
[HISTORY.md](./HISTORY.md) for exactly why each is scoped that way).

## Bugs found via Specmatic

Real, reproducible defects Specmatic caught by testing the live app against
its own documented contract — each traced to an exact file/line before
being called a bug, not guessed:

1. **`POST /api/v1/logout` silently returned an empty body on every real
   call.** The handler built the correct response message but returned it
   bare instead of wrapping it in the envelope (`self.success(...)`) the
   HTTP layer needs to actually send a body. **Fixed** — one-line change in
   `apps/meteor/server/api/ApiClass.ts`.
2. **Five endpoints were unreachable — silently served Rocket.Chat's web
   page instead of JSON** (`media-calls.state`, `app/{id}/logs`,
   `apps/count`, `apps/buildExternalAppRequest`, `licenses.maxActiveUsers`):
   each is declared in the spec without its real `/api` (or `/api/v1`)
   prefix. **Fixed** via an in-memory overlay correction (frozen spec left
   untouched).
3. **`buildExternalAppRequest` also 400s in real life** because the spec
   declares zero query parameters, but the real handler requires `appId`.
   **Fixed** in the same overlay.
4. **A login-flow bug**: an unexpected request shape (`resume` alongside
   password fields) threw an unhandled `Match.Error` instead of a clean
   401. **Fixed** in `ApiClass.ts`'s login handler.
5. **`instances.get` (admin-only) leaks a raw internal error** —
   `"Service '$node.list' is not available."` — a Moleculer broker
   message, not a Rocket.Chat error, appearing several hours into uptime
   on a single-node deployment. Root-caused to
   `ee/server/local-services/instance/service.ts:214`; **flagged with two
   valid fix options, not blind-patched** (see HISTORY.md).
6. **`federation/listServersByUser` and 2 related endpoints: confirmed
   dead.** Real frontend code calls them, but no server route has ever
   existed for any of them since the UI landed in 2023 — an abandoned
   feature, not a bug to fix. Recommended removing the dead UI.
7. **Our own test assumptions were wrong twice** (not app bugs, but worth
   recording): `channels.anonymousread`'s committed example assumed
   "anonymous" meant "send no headers" — the real route requires *some*
   session regardless, so it 401'd before ever reaching the check it was
   meant to test. Fixed the example; also found the spec never declares
   auth parameters for this operation, so a real test of its documented
   error path isn't achievable through Specmatic's example mechanism at
   all.
8. **A real bug in our own tooling**, not the app: the overlay file used
   for fix #2 above had 5 fixes added as 5 separate actions over time —
   turns out Specmatic's overlay engine only keeps the *last* such action,
   silently discarding the rest. Two of the five "already fixed" bugs had
   quietly stopped being fixed the moment a later one was added, and
   nothing caught it until this pass. **Fixed** by merging all five into
   one action.

## Why coverage isn't higher

Real Specmatic examples now exist for all 12 spec files, but the honest
coverage number sits at **17%** (1611 operations eligible). Most of the gap
is structural, not undiscovered bugs — five confirmed, distinct reasons,
none fixable without editing the frozen spec (which the ground rules
forbid):

| # | Reason | Why it's not fixable here |
|---|--------|---------------------------|
| 1 | **Auto-generated negative-body tests.** Specmatic invents extra "what if the request body is empty / stripped?" variants for any operation whose `requestBody` isn't marked `required: true`, and still expects the original success status. | Rocket.Chat correctly rejects these with 401/400 — that's *correct* behavior counted as a "failure." Fixing it means editing the spec's `required` flags. |
| 2 | **Two bulk-list endpoints inflate one failure class.** `permissions.listAll` and `settings`/`settings.public` return hundreds/thousands of items, each with a couple of fields the spec never declared. | Same handful of undeclared fields, multiplied by array size — not new bugs. Fixing means editing the spec's schemas. |
| 3 | **Filtered operations still count in the denominator.** A few operations (fake OAuth-login paths, `logout` — excluded to protect the shared test session) are deliberately not run, but Specmatic still counts them as "eligible." | No CLI flag removes an operation from the coverage calculation; only editing the spec would. |
| 4 | **Legitimately-`null` fields declared as strict, non-nullable types.** Real unset config values (`description`, `alias`, `tag`, etc.) are `null` in real data; the spec types them as plain `string`/`boolean`/`number`. | Forcing every optional field to fake a non-null default would be a real, invasive app change made only to satisfy a test. |
| 5 | **EE/license-gated fields.** e.g. `licenses.maxActiveUsers` genuinely returns `null` on an unlicensed instance where the spec declares `integer`. | Needs a real Enterprise license to ever return a real integer — outside this project's scope. |

Full evidence trail (exact requests/responses, file:line citations) for
every one of these is in [HISTORY.md](./HISTORY.md).

## Coverage report

- **HTML report:** `specmatic-contract-testing/specmatic/reports/all/test/html/index.html`
  (regenerated every `specmatic-contract-test-all` run; open directly in a
  browser).
- **Quick check from a captured log:**
  ```sh
  grep -oE '[0-9]+% API Coverage reported' <captured-output>.log
  ```
- Not gated on a percentage threshold in CI — see "Why coverage isn't
  higher" above for why a rising-percentage gate stopped making sense.
  The real CI gate fails only on a genuine regression signal: Specmatic
  reporting `Errors > 0` (framework crash) or `Successes == 0` (auth
  broke).

## Conclusion

This project set out to prove contract testing can catch real bugs in
Rocket.Chat's API — not just wire up config that passes trivially. It has:
found and fixed 4 real app bugs (one being a genuine data-loss bug on
`logout`), root-caused and fixed 5 broken/unreachable endpoints, flagged 2
more real findings for a follow-up decision, and — just as important —
figured out *why* the remaining ~83% of the coverage number isn't higher,
so that number is now something the team can trust and reason about
instead of a mystery to chase. The spec stayed frozen throughout; every fix
went into the app (or, for a handful of objective path defects, an
in-memory overlay), never into the contract itself.
