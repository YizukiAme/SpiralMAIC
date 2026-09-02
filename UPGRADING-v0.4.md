# Upgrading SpiralMAIC to v0.4

v0.4 updates the runtime and security baseline without changing persisted data formats.
Classrooms, assets, runtime records, review history, Study Studio artifacts, overtime pages,
and PostgreSQL data created by v0.3.2 remain readable.

## Before upgrading

- Use Node.js `>= 22.13 < 23` and pnpm 10.
- Keep the existing data volume or PostgreSQL database attached.
- Preserve your current environment variables and provider configuration.

Then install and validate the production build:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

## Access-code behavior

`ACCESS_CODE` remains optional. When it is unset, a local or private instance opens without
a login prompt. When it is set, pages and protected APIs require the same signed browser
token. Tokens expire seven days after issue; changing `ACCESS_CODE` invalidates older tokens.
Users only need to enter the code again—no data migration is involved.

## Dependency changes

v0.4 moves to Next.js 16, React 19, AI SDK 7, ESLint 10, and the TypeScript 7 CLI. The
`@openmaic/*` source APIs and persisted message shapes stay compatible. Provider-specific SDK
types are converted at the AI boundary and are not written to IndexedDB or PostgreSQL.

## Deployment and rollback

Rebuild the application image rather than reusing v0.3.2 build output. Validate the health
endpoint and one core learning loop in the deployment mode you use (plain Docker, PostgreSQL,
render service, or Vercel). A code rollback to v0.3.2 does not require a data rollback because
v0.4 does not introduce a persistence-schema migration.
