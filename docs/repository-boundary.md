# Repository and Deployment Boundary

This document turns the product boundary in `COMMERCIAL.md` into a source-control and deployment boundary.

## Public repository

The public `hazydawn0703/RoleUnion` repository is the source of truth for the Apache-2.0 Community Core:

- `apps/server`
- `apps/studio`
- `packages/storage`
- community documentation and development scripts

The root npm workspace is an explicit allowlist. Do not replace it with `apps/*` or `packages/*`.

## Private repositories

The following source belongs in private repositories, not merely in ignored directories inside this public working tree:

- the official website source formerly located at the legacy path `apps/site`
- Cloud, team workspace, audit, and enterprise integrations
- customer-specific deliverables and internal deployment automation

Private packages should use a distinct namespace or clearly proprietary package names and include a proprietary license notice.

## Composition model

Use a private composition repository as the deployment source of truth. It may pin this public repository as a Git submodule or consume versioned Community Core packages. Private code must remain outside the public repository root.

A release manifest should record at least:

- Community Core commit
- private repository commit
- build timestamp
- artifact checksum
- schema or migration version, when applicable

## Production servers

Production release directories are artifacts, not Git working trees.

- Keep application releases under `/opt/roleunion/releases/<release-id>`.
- Keep the active `/opt/roleunion/current` symbolic link.
- Keep website releases under `/var/www/roleunion.com/releases/<release-id>`.
- Keep secrets in `/etc/roleunion` and runtime data in `/var/lib/roleunion`.
- Never initialize a Git repository in either active release directory.
- Never configure a public Git remote for a directory containing private code.

If server-side builds are required, use separate public and private clones under a build-only directory, then assemble an unversioned release artifact.

## Automated guard

Run `npm run check:open-source-boundary` before every public commit and in CI. The check rejects tracked private paths, wildcard workspaces, and missing ignore safeguards.

The guard is defense in depth. The legacy `apps/site` source has been moved to a private repository; its public path remains blocked and ignored to prevent accidental reintroduction.
