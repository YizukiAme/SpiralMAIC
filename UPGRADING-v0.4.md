# Upgrading SpiralMAIC to v0.4

v0.4 updates the runtime and security baseline and moves formal learning data to the server.
Courses, assets, Revisit history, Study Studio artifacts, and overtime tasks from earlier
browser-based builds can be copied into PostgreSQL after you confirm the import in the app.
Demo sessions remain in the browser.

## Before upgrading

- Use Node.js `>= 22.19 < 23` and pnpm 10.
- Back up the browser profile that holds older courses and the existing server data volume.
- Provide a PostgreSQL database. For local development, run `pnpm db:up` and set
  `DATABASE_URL=postgres://openmaic:openmaic-dev@127.0.0.1:5432/openmaic` in `.env.local`.
  Docker Compose includes PostgreSQL by default.
- Preserve your current environment variables and provider configuration.

Then install and validate the production build:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

On the first visit, review the import prompt and choose **Start import** when you are ready.
**Later** leaves browser data untouched and uploads nothing. The import resumes after a
network interruption, keeps the browser originals, and shows records it could not move.
Settings offers the prompt again. Keep the same server and account while importing.

## Access-code behavior

`ACCESS_CODE` remains optional. When it is unset, a local or private instance opens without
a login prompt. When it is set, pages and protected APIs require the same signed browser
token. Tokens expire seven days after issue; changing `ACCESS_CODE` invalidates older tokens.
Users only need to enter the code again; the access code is separate from data import.

## Dependency changes

v0.4 moves to Next.js 16, React 19, AI SDK 7, ESLint 10, and the TypeScript 7 CLI. The
`@openmaic/*` source APIs and persisted message shapes stay compatible. Provider-specific SDK
types are converted at the AI boundary and are not written to learning records.

## Deployment and rollback

Rebuild the application image rather than reusing v0.3.2 build output. Validate the health
endpoint and one core learning loop in the deployment mode you use. The migration adds server
tables without deleting old browser data. A code rollback does **not** copy newly created
server learning records back to the browser; retain the database backup and avoid editing the
same course in both versions during a rollback.
