## [2026-11-28] build | Newer npm versions inline in package.json, with an upgrade agent

An open package.json in Files now shows, after each dependency's version, `↑ x.y.z` when the public
npm registry has a newer latest (amber for a major upgrade) or a dim `latest`; packages the registry
does not have show nothing. Hovering a version gives the details and an npm link. Clicking a hint
(or the context menu's "Upgrade this dependency with an agent") opens Spawn with the package.json
as context and a goal to read the changelog, upgrade the package and lockfile, fix breaking changes
and adopt worthwhile improvements, then run the checks.

Lookups run in main (`deps.latest`, `services/npm-registry.ts`): the small dist-tags endpoint per
package, cached, bounded, no retry loop, honouring the checkout's `.npmrc` registry keys so private
registries and scopes are never asked about. Settings › Privacy › Show newer npm versions
(`editor.npmVersions`, on) turns it off; e2e sets `OIDE_NPM_REGISTRY=off`. New telemetry event
`files_dependency_upgrade { bump, via }` and setting key `editor.npmVersions`.

Pages: [screen-files](../pages/screen-files.md#dependency-versions),
[screen-settings](../pages/screen-settings.md), [telemetry](../pages/telemetry.md).
