# Security Policy

## Supported Versions

This project is currently maintained on the `main` branch.

## Reporting a Vulnerability

Please do **not** open a public issue for sensitive security reports.

Use GitHub's private reporting flow:
- Go to **Security** tab in this repository
- Click **Report a vulnerability**

If private reporting is unavailable, open an issue with minimal details and ask maintainers for a private contact channel.

## Secret Handling

- Never commit API keys, access tokens, private keys, or local credential files.
- Never commit runtime state/log files that may include chat/user payloads.
- If a secret is exposed, revoke and rotate it immediately.

## Scope Notes

This repository is a public-safe plugin source subset.
Runtime deployment config/state should remain outside this repo.
