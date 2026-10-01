# Third-party notices

DSH on Phone ships no third-party binaries. The npm package contains only the compiled plugin bundles and documentation; every dependency is resolved at install time from the npm registry and stays subject to its own license. The authoritative list of those packages and versions is `package.json` plus the CycloneDX SBOM attached to each GitHub release.

Tailscale is not bundled or downloaded by this plugin. It is the user's own installation, governed by the [Tailscale terms of service](https://tailscale.com/terms), and its Serve command is invoked as an external process.
