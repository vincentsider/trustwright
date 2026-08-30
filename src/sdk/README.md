# @trustwright/audit

Self-audit SDK for WebMCP sites. Enumerate your own tool surface, preview the
Trustwright static checklist locally, prove origin ownership, and submit for a
signed, fingerprint-bound Assurance Report + live badge.

```ts
import { requestVerification, confirmVerification, audit, selfAuditPreview } from '@trustwright/audit';

// 1. Prove you control the origin (one-time).
const { token, instructions } = await requestVerification();
// place `token` at /.well-known/trustwright-challenge.txt (or DNS TXT _trustwright.<host>)
await confirmVerification();

// 2. Preview locally (no submit), then submit for a signed badge.
const preview = await selfAuditPreview();     // findings + Assurance Score, in-browser
const result  = await audit();                // signed report; must run on the audited origin

// 3. Show the live badge:
// <script src="https://trustwright.deepblocker.ai/badge.js" data-origin="https://your.site"></script>
```

`probeSurface()` runs the optional **leak probe** (rung 2): it EXECUTES your tools
with an inert canary and reports any cross-origin escape. Only run it when you
accept that your tools will be called.

The Worker independently re-derives the fingerprint and findings before signing —
your self-report is never the trust anchor.

> Publishing to npm under the `@trustwright` scope is a release step; the module is
> usable from source today.
