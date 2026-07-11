# Parameter Value Manager — Spec

Tool #2 of the CPI Dev Toolkit, and the natural sequel to the Field Externalizer. Once an
iFlow's fields are externalized to `{{parameters}}`, **someone still has to set the right
value for each parameter, in each environment (Dev/QA/PROD)** — today that's done one field
at a time on the Configure screen, repeated per environment, with no bulk edit, no
import/export, no diff, and no way to catch a value that's still sitting at its default in
PROD. This tool fixes that.

## 1. Concepts: default vs configured values

| | Where it lives | Set when |
|---|---|---|
| **Default value** | `parameters.prop` / the design model (`listOfExternalizedPropertiesModel[i].propertyObj.value`) | at design/externalization time |
| **Configured value** | the artifact's **Configurations** (the Configure screen's "Configured Value" column) | per environment, before deploy |

Per-environment management means managing **configured values** (and optionally
environment-appropriate **defaults**). At deploy, a parameter uses its configured value if
set, otherwise its default.

## 2. Two operating modes (mirrors the Externalizer)

- **OAuth mode — recommended for true per-environment config (documented, stable).**
  The public OData *Integration Content* API exposes configurations directly:
  - `GET  {base}/api/v1/IntegrationDesigntimeArtifacts(Id='{id}',Version='active')/Configurations`
    → `[{ ParameterKey, ParameterValue, DataType }]`
  - `PUT  {base}/api/v1/IntegrationDesigntimeArtifacts(Id='{id}',Version='active')/Configurations('{ParameterKey}')`
    with `{ ParameterValue, DataType }`
  - optional `POST .../Deploy` afterwards.
  This is exactly what CI/CD pipelines use to promote env values, so it's the "right",
  release-stable path. Needs a Process Integration Runtime service key (as in the
  Externalizer's OAuth mode).

- **Session mode — zero-setup fallback.**
  Uses the same-origin internal design API + the editor model, like the Externalizer.
  - **Default values**: read from `listOfExternalizedPropertiesModel`; write via the model
    `PUT` we already do for the Externalizer (proven). Good for setting env-appropriate
    defaults before transport.
  - **Configured values**: read/write via the internal Configure endpoint — **to be captured
    once via `tools/pvm-diagnostic.js`** (same reverse-engineering step that de-risked the
    Externalizer's save).

## 3. Environment profile format

Canonical JSON (source of truth) + CSV (Excel-friendly for ops).

**JSON (canonical, multi-env):**
```json
{
  "version": 1,
  "iflow": "test_externalize",
  "environments": ["DEV", "QA", "PROD"],
  "parameters": {
    "OData_address": { "DEV": "https://dev-erp.example.com/odata", "QA": "https://qa-erp.example.com/odata", "PROD": "https://erp.example.com/odata" },
    "OData_alias":   { "DEV": "DEV_ODATA_CRED", "QA": "QA_ODATA_CRED", "PROD": "PROD_ODATA_CRED" }
  }
}
```
Also accepted on import: single-env `{ "environment": "QA", "parameters": { "name": "value" } }`,
and a flat `{ "name": "value" }` map.

**CSV:**
```
Name,DEV,QA,PROD
OData_address,https://dev-erp.example.com/odata,https://qa-erp.example.com/odata,https://erp.example.com/odata
OData_alias,DEV_ODATA_CRED,QA_ODATA_CRED,PROD_ODATA_CRED
```
Rules: a **blank cell = no value provided for that environment (missing)**; an explicit
empty string must be given via JSON `""`. Values with commas/quotes are quoted per RFC 4180.

## 4. Features

- **Read** the iFlow's externalized params — name, default, current configured value,
  dataType, mandatory flag.
- **Inline bulk edit** of values, with a per-environment column selector.
- **Import** a profile → **preview diff** → apply. **Export** current values → profile
  (backup / git / sharing).
- **Diff views**:
  - *Drift*: configured vs default (what's overridden where).
  - *Profile vs live*: what applying a profile would change.
  - *Env A vs Env B*: compare two environments side by side.
- **Validation** (before apply): parameters missing a value for the target env; stale profile
  entries (not in the iFlow); values still equal to the default in a non-Dev env; explicit
  empties; type mismatches.
- **Clone from environment**: seed QA/PROD columns from DEV as a starting point.
- **Apply target selector**: Configured values (OAuth `/Configurations`) or Default values
  (session model write).
- **Safety**: dry-run preview and a downloaded backup of current values before any write;
  never deploys automatically (optional explicit "deploy after apply").
- **Stretch**: package-wide (all iFlows in a package) apply from one profile.

## 5. Architecture / reuse

Shares the CPI Dev Toolkit's session-API + model layer with the Externalizer. The novel,
deterministic logic lives in `src/engine/pvm.js` and is fully unit-tested offline:

| Function | Purpose |
|---|---|
| `parseProfile(text, format?)` | JSON/CSV → canonical profile (auto-detects format) |
| `serializeProfile(profile, format)` | canonical → JSON/CSV |
| `valuesForEnv(profile, env)` | pick one environment's `{name: value}` |
| `diffValues(current, target)` | `{ changed, added, removed }` |
| `validate({params, defaults}, profile, env)` | `{ missing, stale, empty, atDefault, ok }` |
| `plan({params, defaults, configured}, targetValues)` | `{ sets, unchanged, unknown, atDefaultAfter }` |

Transport layer (plugin/API): the OAuth `/Configurations` client, or the session model write
(reuses the Externalizer's `applyModel`). `plan()` output feeds either directly.

## 6. Edge cases & notes

- **Credential parameters are aliases, not secrets.** In CPI a `credentialName` value is the
  *alias* of a Security Material entry; the actual secret lives in the tenant keystore, not
  the parameter. So profiles hold URLs/aliases/paths — config, not credentials — but still
  treat profile files as sensitive config and keep them out of shared folders.
- Configured values only take effect **after (re)deploy**; the tool sets them and surfaces a
  "deploy needed" hint (optional one-click deploy in OAuth mode).
- Parameter renamed/removed between profile and iFlow → surfaced as `missing`/`stale`.
- DataType is preserved on write (default `xsd:string`); numeric/boolean params keep their type.
- Everything runs in the browser session; no data leaves the machine.

## 7. Testing

`test/pvm.test.mjs` (part of `npm test`) covers JSON round-trip, single-env normalization,
CSV (incl. quoted commas), `valuesForEnv`, `diffValues`, `validate` (missing/stale/empty/
at-default), and `plan` (sets/unchanged/unknown/reset-to-default). Add an offline harness
later to validate against an exported artifact's real params.

## 8. Phasing

1. **Now** — engine + tests + this spec + `tools/pvm-diagnostic.js` (all offline-verifiable). ✅
2. **Read + Export + Diff UI** (session mode): list params + current values, export a profile,
   show drift. Read-only, safe.
3. **Import + Apply (default values)** via the model `PUT` (reuses the Externalizer's proven
   write) + dry-run preview + backup.
4. **OAuth mode**: `/Configurations` read/write for true per-environment configured values,
   optional deploy.
5. **Package-wide** apply and **Env A vs B** compare.
