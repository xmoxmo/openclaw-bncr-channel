# Privacy Checklist

This repository contains the OpenClaw Bncr channel plugin implementation, tests,
build scripts, documentation, and the committed runtime bundle.

No runtime state, no credentials, no local environment files are included.

Before publishing, verify that runtime data under `<stateDir>/plugins/bncr/`,
local environment files, logs, caches, and credentials are not staged or packed.
The npm allowlist is defined by `package.json#files` and `.npmignore`.
