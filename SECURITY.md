# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's
[Report a vulnerability](https://github.com/hamzahossainX/Product-in-motion/security/advisories/new)
form, which opens a draft advisory only the maintainers can see.

Include, as far as you have it: what the issue is, the steps or payload that
trigger it, the browser and version, and what an attacker gains. A proof of
concept is welcome; a working exploit is not required.

**Response targets**

| | |
|---|---|
| Acknowledge the report | within 72 hours |
| Initial assessment | within 7 days |
| Fix or documented decision not to fix | within 30 days for anything rated High |

You will be credited in the advisory and the changelog unless you ask not to be.

## Supported versions

| Version | Supported |
|---|---|
| `main` (and the latest release) | yes |
| anything older | no |

This is a single-page static site with no release branches. Fixes land on `main`
and are cut into a new tag.

## Scope

**In scope** — anything in this repository: the page, the TypeScript, the
shaders, the build configuration, the GitHub Actions workflows, and the
dependency set.

**Out of scope**

- The hosting provider's own infrastructure (report to Vercel or GitHub).
- Findings from automated scanners with no demonstrated impact — in particular
  "missing security headers" on a `*.vercel.app` or `*.github.io` preview URL,
  where the headers are set by the platform and not by this repository.
- Denial of service by rendering the page on deliberately constrained hardware.
- Social-engineering or physical attacks.

## Threat model

Knowing what the site *is* makes most of the usual web risk list inapplicable,
so it is worth being explicit.

The site is **fully static**. There is no server, no API, no database, no
authentication and no session. Every byte is generated at build time and served
as a file. There is nothing to inject into and nothing to escalate to.

What follows is the state of the code, not an aspiration:

| Property | Status |
|---|---|
| Backend, API or database | none |
| Cookies | none |
| `localStorage`, `sessionStorage`, IndexedDB | none — the site stores nothing on the device |
| Analytics, tracking, telemetry | none |
| Third-party scripts, fonts or CDNs at runtime | none — fonts are self-hosted, everything is same-origin |
| Outbound network requests | one, same-origin: an optional camera-path JSON |
| `eval` / `new Function` | none |
| `innerHTML` | one occurrence, a hard-coded literal, in the `?debug=1` panel only |
| `dangerouslySetInnerHTML` equivalents | none |
| User input | one text field, read as a string and rasterised to a texture — never parsed as markup |
| Personal data collected | none |

### The text field

The unlearning section takes typed text and draws it into the 3D scene. The
value is read with `.value`, measured, rasterised to a canvas, turned into a
signed distance field in a Web Worker and uploaded as a texture. It is never
inserted into the DOM, never concatenated into markup, never sent anywhere, and
never persisted. Closing the tab is the whole data-retention policy — which is,
in fairness, the product's entire pitch.

### The newsletter form

The footer form has **no `action` and no submit handler that transmits
anything**. It is part of the fiction. No address is collected, stored or sent.

### Email addresses on the page

The contact addresses use the `.example` TLD, which
[RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) reserves precisely so that it
can never resolve. They are deliberately unroutable, so nothing can be sent to a
real mailbox by mistake.

## Recommended response headers

The repository cannot set headers for every host, so
[`vercel.json`](vercel.json) sets them where it can. If you deploy somewhere
else, this is the policy to reproduce.

It is not aspirational. The production build was served behind exactly these
headers and loaded on a real GPU, exercising the text input, the worker and the
DOM-motion writes: **0 CSP violations, 0 blocked requests, 0 console errors**,
with the renderer drawing and the self-hosted font loaded.

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Permissions-Policy: geolocation=(), microphone=(), camera=(), interest-cohort=()
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

Two notes on that policy, because both are load-bearing:

- `style-src` needs `'unsafe-inline'`. The engine writes to `element.style` to
  drive DOM motion, and a CSP without it silently stops every reveal. Using a
  nonce is not an option for a static host that cannot vary a response per
  request.
- `worker-src 'self'` is enough. Vite emits the distance-field worker as a real
  same-origin file rather than a blob URL, so no `blob:` source is needed — this
  was checked against the production bundle, not assumed.

## Dependencies

Three runtime dependencies — `three`, `lenis`, `gsap` — and three build-time
ones. That is a deliberate ceiling, and the smallest useful supply-chain
control this project has.

- `npm audit` is run in CI on every push and pull request.
- Dependabot opens grouped update pull requests monthly — one per ecosystem,
  not one per package ([`.github/dependabot.yml`](.github/dependabot.yml)).
- GitHub Actions are pinned by major version and run with a read-only
  `GITHUB_TOKEN` except where a deployment explicitly needs more.
- `package-lock.json` is committed, and CI installs with `npm ci`, so a build
  resolves to exactly the audited tree.
