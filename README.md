# Poke

Poke is a private WhatsApp-first personal agent for a dedicated Ubuntu VPS.

## Supported runtime

Poke supports Node.js `>=24.20.0 <25` and npm `11.19.0`. This release was checked on Node 24.20.0, which avoids the recurring `node:sqlite` experimental warning from the installed Flue runtime. Do not suppress Node warnings globally.

Install from a clean checkout:

```sh
npm ci
npm audit --omit=dev
npm run check:install-scripts
npm run typecheck
npm test
npm run build
```

The committed `allowScripts` policy approves only the version-pinned scripts required by Baileys, better-sqlite3, and esbuild. Run `npm install-scripts ls --json` after dependency changes and review new entries before approving them.

Then run `poke setup`, `poke login`, and `poke model`. The lifecycle commands install and use a user-owned systemd service when systemd is available.
