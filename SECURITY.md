# Security policy

## Supported versions

| Component | Current release | Version file | Supported |
| --- | --- | --- | --- |
| Terminal app | 0.3.0 | `Cargo.toml` | Latest on `main` |
| VS Code extension | 0.6.2 | `extensions/vscode/package.json` | Latest on `main` and VS Code Marketplace |
| Browser companion | 0.17.0 | `extensions/chrome/manifest.json` | Latest on `main` and Chrome Web Store |

Security fixes are applied to `main` first, then released to the VS Code Marketplace and Chrome Web Store as soon as practical.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.**

Instead:

1. **Preferred:** [Open a private security advisory](https://github.com/Soham109/cpos/security/advisories/new) on GitHub.
2. **Alternative:** Email the maintainer via the contact on their [GitHub profile](https://github.com/Soham109) with subject `CPOS security`.

Include:

- Which component is affected (terminal / VS Code / browser)
- Steps to reproduce
- Impact (e.g. data leaving localhost, arbitrary code execution, credential exposure)
- Your environment (OS, browser, VS Code version if relevant)

You should receive an acknowledgment within **7 days**. We will work on a fix and coordinate disclosure before publishing details.

## Scope notes

CPOS is designed to keep problem data and source code on **your machine** (`127.0.0.1`). Reports are in scope if they show:

- User code or problem data sent to unexpected remote servers
- Localhost capture/submit endpoints reachable from outside the machine
- Privilege escalation via the browser companion or extensions
- Unsafe handling of captured samples or submission autofill

Out of scope:

- Issues that require the victim to install a malicious fork of CPOS
- Social engineering of Codeforces/CSES login pages (report to those platforms)
- General hardening suggestions with no demonstrated exploit

## Safe harbor

We appreciate responsible disclosure. Reporters acting in good faith will not be asked to take legal action against them for discovery activities limited to verifying the vulnerability.
