# Security policy

`dsh-on-phone` exposes a control surface that can run tools on the host computer through an authenticated loopback proxy. Treat every device that can open the remote origin as a fully trusted operator.

## Supported versions

Security fixes target the newest stable release. Prereleases receive fixes only when the corresponding GitHub Release says they are supported. The README compatibility table identifies the exact DSH release tested with each plugin version.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability-reporting form for `JauLukNgai/dsh-on-phone`. Include the affected version, deployment topology, reproduction steps, and whether a session Cookie or local access is required.

The maintainer will acknowledge a complete report within seven days. Publication timing is coordinated with the reporter after a fix and a revocation or upgrade path are available.

## Deployment requirements

- Keep the ordinary DSH Web listener on loopback; the plugin's `upstreamOrigin` defaults to `http://127.0.0.1:3080`.
- The plugin's own listener binds loopback only (`listenHost: 127.0.0.1`). It exposes nothing by itself: the only way out is the selected remote provider.
- Expose the origin through **Tailscale Serve on the tailnet only** — never through Funnel, and never through router port forwarding. `tailscale serve status` must report `(tailnet only)`; the tailnet ACLs are the access boundary, so a device that is not signed in to the tailnet cannot reach the origin at all.
- The provider terminates public TLS. Session cookie validation, CSRF checks, response-header sanitization, and session revocation stay enforced by the plugin's proxy before a request reaches DSH.
- The plugin never reads, writes, or stores Tailscale credentials: it only invokes the user's own `tailscale` binary (`serve` and `status`), so the node's login state stays wherever that installation keeps it, outside `$DSH_HOME`. No Tailscale password, Auth Key, or OAuth secret is ever requested or stored.
- Remote access can be turned off at any time. Disabling it stops the plugin's proxy process and removes the Serve mapping the plugin owns, without touching other `tailscale serve` entries.
- Treat every device that can open the origin as a fully trusted operator: stock DSH methods reached through the authenticated loopback proxy may read configuration or run tools with the desktop user's authority. Sign a lost device out of the tailnet.
- Treat `mobile.js` as application code with the mobile page's same-origin authority. Restrict write access to trusted host-side DSH sessions and review generated API calls or browser-permission use.
- Treat every extension `host.mjs` as a local program with the desktop user's Node.js privileges. It is never sandboxed and is not editable through the mobile gateway; only place code there that you trust.
- Extension Actions and Routes receive filtered request data, a device identifier, and an abort signal. They cannot set proxy security headers or access the gateway's cookies, CSRF tokens, or internal request headers.

## Known limitation

The current DSH HTML boot process contains inline JavaScript, revives Schemastery callbacks with `new Function`, and applies some styles dynamically. To keep the stock Web UI runnable, the gateway's Content Security Policy currently includes `script-src 'self' 'unsafe-inline' 'unsafe-eval'` and `style-src 'self' 'unsafe-inline'`. The remaining directives still restrict origins, connections, frames, objects, workers, images, and form targets, but this policy does not eliminate script-injection risk. Removing these allowances requires upstream DSH support for nonces, stable hashes, external boot resources, and a non-evaluating schema representation.

This repository never accepts private keys, npm tokens, pairing values, device credentials, Cookies, or captured settings in issues, logs, fixtures, or example configuration.
