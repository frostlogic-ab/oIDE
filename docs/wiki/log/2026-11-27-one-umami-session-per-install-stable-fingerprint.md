## [2026-11-27] decision | One Umami session per install (stable fingerprint)

Umami's Retention report showed one developer as six sessions in a day. Umami v3.5.0 builds the
session id from IP, User-Agent, a monthly salt and the distinct id. The install id was stable, but the
IP (Windows rotates temporary IPv6 addresses) and Electron's version-stamped User-Agent were not, so
most launches and every upgrade started a new session. Retention counts session ids.

Usage payloads now carry `ip: '127.0.0.1'` and a constant, version-free `userAgent`. The session is
then the install id alone and survives restarts, network changes and oIDE, Electron and OS upgrades.
Because of the loopback IP, Umami stores no location for usage, so the OS region setting goes in
session data as `country`. To keep sessions across months, set a fixed `SALT_ROTATION` on the server.
ADR 0011 is amended; see [telemetry](../pages/telemetry.md).
