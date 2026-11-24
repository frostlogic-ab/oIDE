# Marketplace index tools

oIDE's marketplace in v1 is a static `index.json` in the public
[`oide-dev/oide-marketplace`](https://github.com/oide-dev/oide-marketplace) repo. The app fetches it
from `https://raw.githubusercontent.com/oide-dev/oide-marketplace/main/index.json`, caches it for a
day, and falls back to the copy bundled here (`bundled/index.json`) when offline.
The `oide-dev` GitHub organisation and the `oide-marketplace` repository are not set up yet (pre-1.0);
until they are, the app can only use the bundled copy.

| File | What it does |
| --- | --- |
| `validate.mjs` | Checks an index against the `MarketplaceIndex` schema (`packages/protocol`) and the CI rules, then every listed tarball: SRI `integrity` hash first, safe extraction, the `oide` manifest, and that the entry lists exactly the manifest's tools (same risk labels) and capabilities. |
| `build.mjs` | Packs oIDE's built-in extensions (`extensions/*`) with `npm pack --ignore-scripts`, computes their integrity and writes `bundled/index.json`. Only built-ins are listed, with `source: "builtin"` and `verified: true`. |
| `lib.mjs` | Shared logic (also used by the tests in `test/`). |

```sh
node tools/marketplace-index/build.mjs                     # rebuild bundled/index.json
node tools/marketplace-index/validate.mjs --bundled        # re-pack built-ins and check the bundled index
node tools/marketplace-index/validate.mjs path/to/index.json            # downloads each tarball
node tools/marketplace-index/validate.mjs index.json --tarball @you/ext@1.2.0=./you-ext-1.2.0.tgz
node tools/marketplace-index/validate.mjs index.json --schema-only
```

Built-in entries are never downloaded by the app (they ship inside it); their `tarball` field is
the URL npm would serve once published. Those URLs still use the `@oide` npm scope, which belongs to
an unrelated maintainer, so the built-ins cannot be published under these names; the scope is an
open question ([open questions](../../docs/wiki/pages/open-questions.md) #15). `extensions/.gitattributes` pins LF line endings so the
packed hashes are the same on every OS.

## Submitting an extension

1. Build your extension as an npm package with an `oide` manifest (see
   [`@oide/extension-api`](../../packages/extension-api/README.md), not on npm yet). Ship bundled code in `dist/`:
   oIDE never runs install scripts and never installs dependencies.
2. Publish it to npm (`npm publish`, ideally with `--provenance`).
3. Get the tarball URL and integrity: `npm view <name>@<version> dist.tarball dist.integrity`.
4. Open a PR against `oide-marketplace` that adds (or extends) your entry in `index.json`:

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
         "integrity": "sha512-…",
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

   Categories: `agent-tools`, `review-testing`, `deploy-targets`, `artifact-types`,
   `views-panels`, `themes`, `languages`. Leave `verified` out; maintainers set it after review.
5. CI runs `validate.mjs` on the changed index. It fails if the hash does not match, the tarball
   has unsafe paths or links, code is not bundled in `dist/`, or the entry's tools, risk labels or
   capabilities differ from the manifest.

Users see every tool and declared capability before installing. An update that adds tools or
capabilities (or turns an "asks first" tool into a read-only one) asks for consent again.
