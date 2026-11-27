# ADR 0011: Opt-in telemetry with Umami, sent from main

- Status: accepted
- Date: 2026-11-25
- Departs from: the publication review (2026-11-25), which removed the usage-statistics switch and
  stated "oIDE has no telemetry". The product owner asked for usage analytics, crash and error
  reports and performance numbers, so the team can see how oIDE is used and where it breaks.

## Context
The product owner runs an Umami instance (`https://data.frostlogic.se`, Umami v3.5.0) and supplied
its two tracker tags: `script.js` (pageviews, events, errors and web vitals) and `recorder.js`
(session replay). oIDE's renderer exposes the `window.oide` bridge, which can spawn agents, write
files and answer permission prompts. Its CSP allows no remote script and its session has no route to
the network at all (SEC-33). Users run oIDE on private code, so trust depends on sending nothing
about that code.

## Decision
- **Opt-in, two switches.** Settings › Privacy › "Share anonymous usage analytics" and "Send crash
  and error reports" (`settings.privacy`), both off by default. A first-run question sets both. If
  it is closed without a choice, it comes back on the next launch, at most twice in all, then never.
  `DO_NOT_TRACK=1`, `OIDE_TELEMETRY=0` and test runs turn everything off (no question, no network).
  The old `ui.telemetry` flag from 0.1.x is never read: nothing was ever sent under it, and its
  wording was different, so it is not consent.
- **No remote script in any window.** `script.js` is not loaded and the CSP is unchanged. Remote
  code in the renderer could drive the bridge. Main sends instead, with the HTTP collection API
  (`POST /api/batch` for usage, `POST /api/send` for errors), and shapes every payload like the
  official tracker does (checked against Umami v3.5.0's tracker source and server request schemas).
  So pageviews, events, sessions (`identify`), errors (`type: "error"`) and performance (`type:
  "performance"`, web vitals) show up in the normal Umami dashboards. Requests go through a
  dedicated in-memory Electron session whose request filter only lets through the compiled-in Umami
  origin.
- **No session recording.** `recorder.js` replays the DOM, which would capture code, diffs, prompts,
  file paths and agent output: exactly what the consent text promises never to send. It is left out.
- **One allow-list.** `packages/protocol/src/telemetry.ts` declares every event, the product question
  it answers and the exact values each property may take (enums, booleans, bounded numbers, buckets).
  Main drops unknown events and invalid values and strips unknown properties. The renderer can only
  report renderer events, screen views, web vitals and errors over `telemetry.track`, and main checks
  them again. Most events are observed in main (IPC commands, agent events), so screens need no
  instrumentation.
- **Data rules.** Never sent: file paths, project, repository or branch names, agent titles or goals,
  prompts, model output, tool inputs, commit messages, artifact contents, extension settings, env
  values, URLs the user visits, Claude account information, or ids of custom or local extensions.
  Errors carry the error name, a message scrubbed of paths, URLs, emails, quoted text, ids, tokens,
  the user name and the machine name, and app-bundle frames only. The install id is a random UUID
  made at opt-in and deleted when both switches go off. Hard rule 3 still applies: telemetry code
  never touches Claude credentials.
- **Resilience.** In-memory queues (capped, dropped on quit, never persisted), batches of 20,
  exponential backoff with jitter (3 attempts), `Retry-After` on 429, a server "disabled" or bot
  answer stops sending for the run, nothing at all while offline. Turning a switch off drops its
  queue at once.
- **Forks.** The host and website id are build-time defaults (`OIDE_UMAMI_HOST`,
  `OIDE_UMAMI_WEBSITE_ID`, see `packages/protocol/src/distribution.ts`); set either to an empty string
  to compile telemetry out. Dev (unpackaged) runs send with hostname `oide-dev` and environment
  `development`.

## Consequences
- Public docs, README and PRIVACY.md now describe an opt-in model instead of "no telemetry".
- Every change has to consider whether it needs an event, an error report or a performance measure
  (CLAUDE.md), and new events must go through the catalogue and the wiki page
  ([telemetry](../wiki/pages/telemetry.md)) in the same change.
- Without the tracker script, browser-only extras (automatic link-click tracking, `data-umami-*`
  attributes) are not available; oIDE has no use for them.
- Umami derives the session from IP, User-Agent, a salt and the install id. Amended 2026-11-27: usage
  payloads set `ip` to `127.0.0.1` and `userAgent` to a constant, version-free value, so each install
  is one session across restarts, network changes and upgrades (the Retention report counts sessions;
  before this one user counted as several). Umami then stores no location for usage; the OS region
  setting is sent as session data `country`. The real IP is still seen by the server (as with any
  HTTP request); for error reports Umami stores only the derived country, region and city.
