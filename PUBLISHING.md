# Publishing to the Chrome Web Store

A practical checklist for releasing **iFlow Field Externalizer** as an independent extension.

## 0. Before you start
- **Developer account** — register once at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time **US$5** fee).
- **Host the privacy policy** — publish `PRIVACY.md` at a public URL (GitHub Pages, a Gist, or
  any site) and fill in your contact. You'll paste that URL in the listing. A privacy policy
  is **required** because the extension has host access.
- Fill in the contact line in `PRIVACY.md`.

## 1. Build the upload package
```
node tools/package.mjs
```
Produces `dist/iflow-field-externalizer-v<version>.zip` containing only the shipped files
(manifest, icons, popup, `vendor/jszip.min.js`, engine, content script) — no tests/tools/docs.

## 2. Create the item and upload
Dashboard → **Add new item** → upload the zip. Then complete:

### Store listing
- **Name:** iFlow Field Externalizer
- **Summary (≤132 chars):** Externalize hardcoded fields (URLs, hosts, credentials) in SAP Integration Suite iFlows to {{parameters}} — in the editor.
- **Description:** see "Listing copy" below.
- **Category:** Developer Tools
- **Icon:** `icons/icon128.png` (store shows 128px). **Screenshots:** 1280×800 or 640×400 —
  capture the review dialog on an iFlow and the Configure screen with the new parameters
  (use a demo/throwaway iFlow — **no client data**).
- **Privacy policy URL:** your hosted `PRIVACY.md`.

### Privacy practices (Dashboard → Privacy tab)
- **Single purpose:** "Externalize hardcoded configuration values in SAP Integration Suite
  integration flows into configurable parameters."
- **Permission justifications:**
  - `storage` — "Persist the user's own settings (optional API path prefix) locally."
  - Host access (`*.hana.ondemand.com`, `*.platform.sapcloud.cn`) — "Read and modify the
    integration flow the user is actively editing, on the same tenant page, via that tenant's
    same-origin design-time API. No other sites are accessed."
- **Data usage:** declare **no data collected**; confirm it is not sold or transferred, and
  is used only for the single purpose. (All processing is local.)
- **Remote code:** **No** — everything (including `vendor/jszip.min.js`) is bundled; nothing
  is fetched and executed at runtime.

## 3. Submit for review
Expect anywhere from a day to ~2 weeks. Broad host access invites scrutiny — the
justification above and the local-only data story are what reviewers look for.

## Listing copy (paste into Description)
> Turn hardcoded values in your SAP Integration Suite (Cloud Integration) integration flows
> into externalized `{{parameters}}` — without leaving the editor.
>
> Open an iFlow, click **⧉ Externalize fields**, review the detected fields (URLs, hosts,
> credential names, location IDs, ports, paths) across Content Modifiers and adapters, tick
> the ones you want, and apply. The extension updates the flow in place using your existing
> session and reloads the editor, so the parameters show up on the Configure screen ready to
> set per environment. A "show all fields" option lets you externalize anything, and a model
> backup is downloaded before every change.
>
> Everything runs locally in your browser session — no data is collected or sent anywhere.

## Notes & caveats
- **Trademarks:** "SAP", "Integration Suite", "Cloud Integration" are SAP trademarks; they're
  used here only descriptively to indicate compatibility. Don't use SAP logos or imply
  endorsement in the listing or icon.
- **Internal API dependency:** the live path uses SAP's undocumented same-origin design-time
  API, which can change between Integration Suite releases and may require updates.
- **Test on throwaway iFlows** first after any SAP release; the exported-zip path is a safe
  fallback that doesn't touch the live artifact.
