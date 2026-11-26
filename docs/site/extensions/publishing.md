# Packaging and publishing

The v1 marketplace is a static `index.json` in the public
[oide-marketplace](https://github.com/oide-dev/oide-marketplace) repository, plus npm tarballs. oIDE
fetches the index (cached for a day, with a copy bundled in the app for offline use) and installs
from the npm registry.

::: info Pre-1.0
The `oide-marketplace` repository is not open for submissions yet; until it is, oIDE uses the index
bundled with the app, which lists only the built-in extensions. You can already build, test and
[install your extension from a folder or git](/extensions/developing).
:::

## Package rules

- **Bundle everything into `dist/`.** oIDE never runs install scripts and never installs
  dependencies. Host code and MCP scripts must live under `dist/` for marketplace installs.
- Set `"files": ["dist", "README.md"]` so nothing else is published.
- No absolute paths, `..` segments or symlinks that leave the package. No hard links, devices or
  FIFOs in the tarball, and a single top folder (npm's `package/`).
- The manifest's tools, risk labels and capabilities must match the index entry exactly.
- Choose an MIT-compatible open-source licence if you can; the Marketplace describes extensions as
  open source.

## Publish

1. Publish to npm, ideally with provenance:

   ```sh
   npm publish --access public --provenance
   ```

2. Get the tarball URL and integrity hash:

   ```sh
   npm view @you/postgres-inspector@1.2.0 dist.tarball dist.integrity
   ```

3. Open a pull request against `oide-marketplace` that adds (or extends) your entry in `index.json`:

   ```json
   {
     "name": "@you/postgres-inspector",
     "displayName": "Postgres inspector",
     "publisher": "you",
     "description": "Lets agents look at your database schema and run read-only queries.",
     "categories": ["agent-tools"],
     "repository": "https://github.com/you/postgres-inspector",
     "versions": [
       {
         "version": "1.2.0",
         "tarball": "https://registry.npmjs.org/@you/postgres-inspector/-/postgres-inspector-1.2.0.tgz",
         "integrity": "sha512-...",
         "engine": "^1.0.0",
         "tools": [
           { "name": "db.schema", "risk": "read" },
           { "name": "db.query", "risk": "ask" }
         ],
         "capabilities": { "network": ["localhost"], "spawn": false }
       }
     ]
   }
   ```

   Leave `verified` out; maintainers set it after review. Optional fields: `updatedAt` (ISO date of
   the newest version), `downloads`, `rating`.

## What CI checks

The index repository's CI runs
[`tools/marketplace-index/validate.mjs`](https://github.com/frostlogic-ab/oIDE/blob/main/tools/marketplace-index/README.md)
on the changed index. It fails when:

- the entry does not match the `MarketplaceIndex` schema;
- the tarball's SRI hash does not match `integrity` (checked before anything is unpacked);
- the tarball has unsafe paths or links;
- the manifest is invalid, or code is not bundled in `dist/`;
- the entry's tools, risk labels or capabilities differ from the manifest.

Run it yourself before opening the PR:

```sh
# from a clone of github.com/frostlogic-ab/oIDE
node tools/marketplace-index/validate.mjs path/to/index.json --tarball @you/postgres-inspector@1.2.0=./you-postgres-inspector-1.2.0.tgz
node tools/marketplace-index/validate.mjs path/to/index.json --schema-only
```

## What users get

When a user installs, oIDE picks the newest version whose `engine` fits their oIDE (or the version
they chose), downloads the tarball (64 MB cap), verifies the hash, validates the archive, extracts it
to `<app-data>/extensions/<name>@<version>`, and loads the manifest, which must match the entry.
Any failure removes the folder.

## Updates

Publish the new version to npm and add it to `versions` in your entry. The Marketplace's Updates
count compares installed versions with the index. If the new version adds tools or capabilities, or
turns an "asks first" tool read-only, users must consent again before it installs.
