# iFlow Field Externalizer

Externalize hardcoded fields (URLs, hosts, credentials, ports, paths, queues) in **SAP
Integration Suite (Cloud Foundry)** iFlows. Develop with hardcoded values; when the iFlow
reaches a workable state, run the tool once to turn those values into `{{parameters}}` that
appear on the **Configure** screen.

Ships as a **plugin for a compatible CPI browser-helper extension** (it registers on the
host's `pluginList` and reuses the host's session, `JSZip`, and toast helpers), plus a
dependency-free **Node harness** for offline validation.

## What "externalize" actually does

It is not a UI gesture — it's three edits inside the iFlow project zip:

| File | Change |
|---|---|
| `…/integrationflow/<id>.iflw` | `<value>https://api.acme.com</value>` → `<value>{{Receiver_URL}}</value>` |
| `parameters.prop` | add `Receiver_URL=https://api.acme.com` |
| `parameters.propdef` | add a `<parameter>` definition |

The tool works on the **artifact**, not the graphical canvas.

## Layout

```
src/engine/engine.js                  Dependency-free core (browser + Node): analyze → apply
src/plugin/field-externalizer.plugin.js   Host plugin: launcher, review dialog, session fetch
tools/run-local.mjs                   Node harness (validate against an exported iFlow)
test/engine.test.mjs                  Regression tests (node --test)
test/fixtures/                        Sample iFlow used by the tests and harness
```

## Tests

`npm test` (or `node --test`) runs the regression suite — zero dependencies. It locks the
detection heuristics and the exact `parameters.prop` / `parameters.propdef` byte-format
(fresh-create and merge-into-existing), so a future engine change can't silently break the
output CPI expects.

## Standalone test build (dev)

For testing without a host extension, this repo also ships a tiny MV3 wrapper
(`manifest.json` + `dev/jszip.min.js`) that loads the real engine + plugin directly:

1. `chrome://extensions` → Developer mode → **Load unpacked** → this project folder.
2. Open an iFlow in your tenant → the **⧉ Externalize fields** launcher appears (bottom-right).

The wrapper is dev-only scaffolding — the shipped artifact is still the plugin file. It
loads `dev/jszip.min.js`, then `src/engine/engine.js`, then the plugin (order matters).

## Install as a plugin

The host extension loads plugins as ordinary scripts listed in its manifest. To add this
one:

1. Copy both files into the host extension's `plugins/` folder:
   - `src/engine/engine.js`
   - `src/plugin/field-externalizer.plugin.js`
2. Add them to the host manifest's `content_scripts[].js`, **engine first** (it must load
   before the plugin), e.g.:
   ```json
   "plugins/engine.js",
   "plugins/field-externalizer.plugin.js"
   ```
   The host already bundles `JSZip`, so no extra dependency is needed.
3. Reload the extension. Open an iFlow → click **⧉ Externalize fields** (a floating launcher,
   and an entry in the host's plugin surface).

### How it runs

Two paths in the dialog:

**Live (in place)** — the main path. Externalizes the iFlow open in the editor without
export/import:
1. Reads the editor model via your session:
   `GET {origin}/api/1.0/workspace/{wsHash}/artifacts/{artHash}/entities/{artHash}/iflows/{name}`
   (the workspace/artifact hash ids are resolved automatically from the package/iFlow name).
2. `analyzeModel` finds Content Modifier header/property fields with hardcoded values.
3. You review, tick, and name the parameters.
4. `applyModel` rewrites the model (sets each cell's `Value.key`, adds a
   `listOfExternalizedPropertiesModel` entry) — byte-identical to how CPI externalizes.
5. Downloads a **backup** of the original model, asks for confirmation, then saves:
   `PUT` the model → `DELETE` the draft → **reloads the editor**. Same artifact, no import.

> Save any other pending edits first — the live path reads the last saved model, and the
> reload discards unsaved in-editor changes.

**Exported zip** — offline path: load an exported `.iflw` zip, review, download the
externalized zip (operates on the raw `.iflw` + `parameters.prop`/`.propdef`).

Scope today: **Content Modifier** headers/properties and **adapter/channel** scalar fields
(address, location ID, credential name, proxy, etc.) — both appear in the same review dialog
with the "show all" toggle. Other step types can be added by mapping their model location.

## Offline validation (no browser, no tenant)

1. In CPI: open the iFlow → `…` → **Export**, then unzip to a folder.
2. `node tools/run-local.mjs ./MyIflow --dry` — preview candidates.
3. `node tools/run-local.mjs ./MyIflow ./MyIflow.externalized` — write the result.

`--min=high` externalizes only high-confidence hits (URLs, credentials, addresses); default
`--min=medium` also includes ports, paths, hostnames, queues.

## Detection rules

Externalized: values matching `://` (URLs), credential/alias/user keys, host/address keys,
path/directory keys, port/timeout/pagesize keys, queue/topic keys, and raw hostname/IP
values. **Skipped:** already-`{{externalized}}`, runtime expressions (`${…}`), booleans, and
structural keys (`componentVersion`, `MessageProtocol`, …). All heuristics live in
`classify()` in `src/engine/engine.js`.

## Parameter file formats

Pinned to real CPI (Integration Suite, CF) output and verified against a manually-externalized
iFlow — both when creating the files fresh and when merging into an iFlow that already has
parameters:

- `parameters.prop` — Java Properties format with a `#<timestamp>` header and Java value
  escaping (a URL's colons are written `\:`).
- `parameters.propdef` — `<parameter>` elements directly under `<parameters>` (no
  `<externalized_parameters>` wrapper), `<param_references/>` last, fields
  `key/name/type/isRequired/constraint/description/additionalMetadata`.

Note: CPI sometimes also writes a `property.<Name>` twin entry when a value is externalized
inside a Content Modifier property; that's a CPI-side artifact it regenerates on save — this
tool writes one clean entry per parameter. Booleans/enums (`true`/`false`) are skipped by
design as they're usually structural, not environment config.

## Safety & confidentiality

- Runs entirely within your tenant origin / browser session. **No data goes anywhere else**
  — no external calls, no analytics.
- The live path **saves the draft** (`PUT`) and never deploys. Before writing it downloads a
  JSON **backup** of the original model and asks for explicit confirmation.
- **Test on a throwaway iFlow first.** The write path is tenant-version-specific; validate on
  a disposable copy before running it on real flows.
- Exported zips / model backups contain real endpoints and credential aliases — keep them out
  of shared/synced folders.

## Compatibility note

This is designed for a popular open-source CPI browser-helper extension's plugin framework.
Field externalization is out of that project's scope; this plugin fills that gap while
reusing the framework's session and UI plumbing. It uses only the framework's public plugin
contract and carries no code from it.
