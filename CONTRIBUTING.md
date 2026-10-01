# Contributing

Changes are welcome through focused pull requests. Please describe the user-visible or security behavior, add negative tests for every changed rejection path, and keep browser, host, and plugin documentation aligned.

Run the local checks before opening a pull request:

```sh
npm ci
npm run verify
```

The phone-side surfaces follow [design-system/dsh-on-phone/MASTER.md](design-system/dsh-on-phone/MASTER.md) — touch targets, safe areas, motion, and the ban on decorative effects are review criteria there, not preferences.

## Phone-side extension surface

Users normally reach this through `/mobile <request>`; the agent's copy of the contract lives in `src/mobile-guide.ts`. For hand-written work:

- Scaffold with `dsh plugin --profile web exec dsh-on-phone extension create <id> [--name <name>]`. Everything lives under `$DSH_HOME/mobile-access/`.
- `mobile.js` / `mobile.css` customizations mount through `window.dshMobile.register(({ root, document, request, window }) => { … })`, which returns a cleanup function. The plugin writes commented templates on first enable: `mobile.css` holds phone-side styles, `mobile.js` mounts a no-op that replaces the root's children and returns the cleanup, and `extensions/custom/` is a worked example (`extension.json` + `host.mjs` + `mobile.js` + `mobile.css`).
- An extension in `extensions/<id>/` has `extension.json` (`{"schemaVersion":1,"id","name","version","description"}`; the id must match the directory name and use only lowercase letters, digits and hyphens), `host.mjs` default-exporting `(api) => { … }` with `api.action(name, { input, run })` and `api.route({ method, path, handle })`, and `mobile.js` calling `window.dshMobile.define({ apiVersion: 1, id, activate(api) { … } })` into one of the `page`, `sidebar-action`, `header-action`, `composer-dock`, `settings-section`, `overlay` placements. The phone calls the host with `api.host.invoke('action', input)` and `api.host.fetch('/route')`.

Keep the user-facing [README.md](README.md) free of this material: it documents what a user does, not how the surfaces are wired.

Never commit TLS private keys, device registries, credentials, or tokens.

The project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be respectful, keep reports reproducible, and use private vulnerability reporting for security findings.
