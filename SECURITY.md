# Security Policy

## Scope

This repository ships an export pipeline (`fleet/bin/export-public.mjs`) that
produces a public copy of a private tree, and a session scrubber
(`fleet/bin/import-sessions.mjs`) that redacts credentials and machine paths
from archived agent transcripts. Security reports about either, or about
anything else in the repo, are welcome.

## Reporting

Use GitHub's "Report a vulnerability" flow (Security Advisories). Do NOT open a
public issue for anything credential-related: a public issue is itself a
disclosure.

## What we consider a vulnerability

- Leaked credentials, API keys or personal data in files the export ships, or
  reachable in the repository's git history.
- Scrubber bypasses: content the scrubber claims to redact surviving in its
  output.
- Verify-rule bypasses: content the export's verify scan should reject passing
  through unflagged.

## Two facts we state as policy

1. **A force-push does not remove history.** Old commits stay downloadable by
   SHA after a branch is rewritten. If a secret ever reached a pushed commit,
   treat it as exposed permanently: rotate the credential first, then clean
   the tree. Removing a file from `main` is not removal.
2. **Code files are never scrubbed, only copied.** The export copies code
   byte-identical; the scrubber touches prose and data files. A private string
   inside a code file must be fixed at source in the private repo — do not
   expect the export to catch it.

## Expectations

Reporters and maintainers: rotate first, then report. A rotated credential
costs an attacker nothing; a report that waits on a rotation window extends
the exposure. We ask reporters not to test findings against any live instance
of the fleet, and we aim to acknowledge a report within a few days.
