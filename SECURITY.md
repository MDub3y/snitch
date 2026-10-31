# Security Policy

Snitch is a security tool, so we hold our own code to the bar we scan for.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability.

- Use GitHub's **private vulnerability reporting** ("Report a vulnerability" on
  the repository's **Security** tab), or
- contact the maintainer directly.

Include a description, affected version/commit, reproduction steps, and impact.
We aim to acknowledge reports within a few days and will coordinate a fix and
disclosure timeline with you.

## Scope

Snitch performs **static** analysis of code the operator owns and points it at.
It does not execute against live or third-party systems. If you find a way to
make Snitch act outside that scope (for example, a scan that mutates the target
or reaches the network against the operator's intent), that is a security issue
worth reporting.

## Supported versions

The project is pre-1.0 and under active development; fixes land on `main`.
