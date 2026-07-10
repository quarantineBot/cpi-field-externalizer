# Privacy Policy — iFlow Field Externalizer

_Last updated: 2026-07-09_

**iFlow Field Externalizer** ("the extension") helps developers replace hardcoded values in
SAP Integration Suite integration flows with externalized `{{parameters}}`.

## What data the extension accesses
- The extension only activates on SAP Integration Suite editor pages you open
  (`*.hana.ondemand.com`, `*.platform.sapcloud.cn`).
- When you click **Externalize fields**, it reads and modifies the **currently open
  integration flow** using **your existing authenticated browser session**, via the tenant's
  own same-origin design-time API. It does not use any credentials of its own.

## What the extension does NOT do
- **No data is collected, stored on remote servers, transmitted to third parties, or sent to
  the developer.** All processing happens locally in your browser, within your tenant session.
- No analytics, no tracking, no telemetry.

## Local storage
- The extension uses Chrome's local `storage` only to save your own settings on your device
  (for example, an optional API path prefix). This never leaves your machine.
- Backup files (a JSON snapshot of the iFlow model) are downloaded to your computer by you
  before a save, and are never uploaded anywhere.

## Permissions
- **`storage`** — save your settings locally.
- **Host access** to the SAP Integration Suite domains above — read and modify the iFlow you
  are actively editing, on the same page you have open. No other sites are accessed.

## Contact
Questions: <add your email or GitHub issues URL before publishing>.
