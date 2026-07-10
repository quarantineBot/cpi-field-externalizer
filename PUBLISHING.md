# Publishing to the Chrome Web Store

A practical checklist for releasing **iFlow Field Externalizer** as an independent extension.

## 0. Before you start
- **Developer account** — register once at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time **US$5** fee).
- **Host the privacy policy** — a ready-to-host page is at `docs/index.html`. A privacy
  policy URL is **required** because the extension has host access. Easiest option:
  - GitHub Pages → Settings → Pages → Source: `main` branch, `/docs` folder. Your URL becomes
    `https://quarantinebot.github.io/cpi-field-externalizer/`.
  - Note: **GitHub Pages needs a public repo** on free plans (private-repo Pages requires
    GitHub Pro). If you keep the repo private, host `docs/index.html` as a Gist or on any
    static host instead.

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
  (use a demo/throwaway iFlow — **no client data**). For an animated demo (e.g. a launch-post
  GIF), open `tools/demo.html` — it self-plays the whole flow with safe demo values; screen-
  record that box with any recorder (ScreenToGif on Windows works well).
- **Privacy policy URL:** your hosted `docs/index.html` (e.g. the GitHub Pages URL above).

### Privacy tab (paste these verbatim)

**Are you using remote code?** → **No, I am not using remote code.** Everything the extension
runs (`vendor/jszip.min.js`, the engine, the content script) is bundled in the package — no
external `<script>` tags, no remotely-loaded modules, no `eval()` of fetched code. (Selecting
"Yes" here is incorrect and triggers a heavier review.)

**Single purpose description:**

> iFlow Field Externalizer has one narrow purpose: it helps a developer replace hardcoded
> values (URLs, hostnames, credential names, location IDs, ports) in the SAP Integration Suite
> integration flow they are editing with externalized {{parameters}}, so those values can be
> configured per environment on the flow's Configure screen. It adds an "Externalize fields"
> button to the integration flow editor that lists the flow's Content Modifier and adapter
> fields, lets the user choose which to externalize and name them, and writes the change back
> to the same flow using the tenant's own design-time API. It does nothing else.

**Storage justification:**

> The `storage` permission is used only to save the user's own preference locally on their
> device — an optional "API path prefix" setting used to locate the tenant's design-time API.
> No flow content, personal data, or credentials are stored, and nothing is synced or
> transmitted. It uses chrome.storage.local only.

**Host permission justification:**

> The extension runs only on SAP Integration Suite integration-flow editor pages
> (`*.hana.ondemand.com` and `*.platform.sapcloud.cn`, under `/shell/*` and `/itspaces/*`). It
> needs a content script there to (1) add the "Externalize fields" button to the flow editor
> and (2) read and modify the integration flow the user is currently editing by calling that
> same tenant's own design-time API, on the same origin, using the user's existing logged-in
> session. It makes no cross-origin requests and accesses no other websites. This access is
> essential to the single purpose — the extension cannot function anywhere other than the SAP
> Integration Suite editor page.

**Data collection:** declare **no user data collected**, and tick the certifications that you
do **not** sell or transfer user data to third parties, do **not** use it for purposes
unrelated to the single purpose, and do **not** use it to determine creditworthiness or for
lending. (All processing is local; nothing is collected.)

### Test instructions (Access tab)

Reviewers can't fully test without an SAP tenant, so paste this to avoid a "couldn't verify"
rejection:

> This extension only activates inside the SAP Integration Suite (Cloud Integration)
> integration-flow editor, which requires an SAP BTP account with Integration Suite — it
> cannot be exercised on a generic web page. To review: open any integration flow in the
> editor on an SAP Integration Suite tenant; an "Externalize fields" button appears at the
> bottom-right. Clicking it lists the flow's hardcoded Content Modifier and adapter fields to
> externalize. The extension makes no calls to any non-SAP domain and stores no data — all
> behavior is confined to the SAP editor page and that tenant's own same-origin API. A demo
> walkthrough can be provided via the GitHub repository issues on request.

## Demo data for screenshots (never use real client values)
Build a throwaway iFlow named e.g. `Demo_OrderSync` (HTTPS sender → Content Modifier → OData
receiver) with these dummy values, so the review dialog looks realistic without leaking any
tenant/client config. Use `example.com` hosts (reserved for docs). "(det)" = auto-detected,
pre-ticked; "(man)" = shown only under "Show all constant fields".

| Where | Field | Demo value | Shows as |
|---|---|---|---|
| Content Modifier · header | Content-Type | `application/json` | man |
| Content Modifier · header | Accept | `application/json` | man |
| Content Modifier · property | TargetSystemUrl | `https://api.demo-erp.example.com/v1` | det (URL) |
| OData adapter | address | `https://erp.demo.example.com/sap/opu/odata/sap/API_DEMO_SRV/` | det (URL) |
| OData adapter | alias | `DEMO_ODATA_CRED` | det (credential) |
| OData adapter | scc_location_id | `demo-cloud-connector` | det (location) |
| OData adapter | resourcePath | `A_DemoSalesOrder` | det (path) |
| OData adapter | receiveTimeOut | `60` | det (numeric) |
| OData adapter | pagination | `0` | man |
| OData adapter | contentType | `application/atom+xml` | man |
| OData adapter | metadataAllowedHeaders | `sap-client=100` | man |
| OData adapter | proxyType | `sapcc` | man |
| OData adapter | isCSRFEnabled | `true` | man |

No red-scribble redaction needed with demo data — the iFlow name can be shown. Frame the
capture with `tools/screenshot.html`.

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
