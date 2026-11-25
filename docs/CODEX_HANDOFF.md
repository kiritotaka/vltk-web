# Codex PC handoff — Võ Lâm Idle / VLTK Web

> Current working source: `https://github.com/kiritotaka/vltk-web` (fork of `hudy9x/vltk-web`). Do **not** work in the older standalone `kiritotaka/jx1-web-game` Phaser prototype.
> Owner's Windows checkout: `D:\\inter\\volam1\\jxweb\\Project\\vltk-web`.
> IMPORTANT: Read the current source and tests before changing behavior; some features are still experimental.

## User intent and decisions

- Build a playable browser version inspired by the 2005 JX1 / Võ Lâm Truyền Kỳ experience; preserve the existing canvas game and UI instead of rewriting it.
- The current Windows machine hosts a Fastify + Node.js >=24 backend, SQLite at `database/game.sqlite`, and Cloudflare Quick Tunnel forwarding to `http://localhost:3000`.
- Do not pay for hosting during testing; retain SQLite and current game saves.
- Only create database tables/columns when required; do not duplicate existing UI.
- The in-game Market already has the UI (Mua, Bày bán, Hàng của tôi). Do **not** create a standalone `market.html` or a second market button.
- Keep the native in-game world-chat UI, not a second popup.
- The owner wants the world camera at 80%, with correctly mapped pointer/NPC clicks and unchanged HUD.
- Starting silver: 50,000 per new character, with a one-time grant to older saves (marker `starterSilverV1`).
- Pharmacy prices are 1/10 of old values, via central `Ot()`.
- Prevent accidental mobile double-tap zoom.
- The round `Phần thưởng` button gets a red dot only while rewards are claimable; `Kỳ Trân Các` and `Chợ` don't get this dot.
- Account `kiritotaka` should be ADMIN; all other accounts default to USER. Role must be assigned on the local machine, not via self-service browser account registration.

## Architecture / current modules

- `src/server/index.ts`: Fastify factory, startup, graceful shutdown; localhost:3000 by default.
- `src/server/accounts.ts`: local username/password accounts and sessions, SQLite-backed character storage, `role` migration with `user|gm|admin` (default user).
- `src/client/bootstrap.js`: SQLite account login, persisted browser outbox, and 15-second server restart detection.
- `src/client/modules.json` + `tools/build-app.js`: JS game bundle `src/client/game.js` assembled into a **single shared-scope closure**. A standalone external script cannot access closure-local `H`, `yl`, etc.
- `src/client/local-chat.js`: local SQLite world-chat adapter bundled into the game, reuses native chat UI. `src/server/chat.ts` exposes authenticated chat endpoints. Party chat not yet finished.
- `src/client/online/local-market-01.js`: read-only listing/search in existing in-game market modal.
- Supabase project reference: `atchexthhvseabeacotj`, a separate user-owned Supabase database, not the upstream author's. Public table `market_listings` with RLS SELECT-only, currently empty. Publishable key is in source; never expose a service-role key.
- `src/client/gameplay/equipment-trader-01.js`: NPC interaction hit-test uses `$8() * gameWorldZoom`, required after camera zoom.
- `src/client/render/projectiles-01.js`, `src/client/render/arena-01.js`, `src/client/render/arena-02.js`: world zoom = 0.8, culling and rendering.
- `src/client/dev/game-master-01.js`, `src/client/ui/developer-tools-01.js`, `src/client/status/runtime.ts`: staff-only tools; `❄ Hiệu ứng` is a technical status inspector, not a visual-FX setting.
- `tools/set-account-role.js`: local-only staff role assignment via `npm run account:role -- kiritotaka admin`. The admin role must be set on the actual local database; editing source does not grant it.

## Auto deploy (latest task)

- `npm run serve:auto`: production supervisor at `tools/serve-auto.js`; polls `origin/main` every 30 seconds.
- Requires a clean tracked `main` checkout. Refuses dirty or divergent branches.
- Preflights candidates in isolated Git worktrees with `npm ci`, map-tool dependency install, and `npm run build`, before stopping the existing server.
- After validation: sends child IPC `volam:shutdown`, fast-forwards checkout, installs/builds, restarts production server. Best-effort rollback to last clean commit on deployment failure.
- SQLite remains `database/game.sqlite`, ignored by Git; Cloudflare Tunnel is a separate process and doesn't need restarting.
- Browser restart detection is based on server `instanceId`, plus attempted save and SQLite outbox flush before reload.
- **Limitations:** Not zero-downtime; restart interrupts clients briefly. The deploy supervisor should be run only once per checkout. It has not yet been validated on the owner's actual Windows host. Check `node --test test/serve-auto.test.js` and `npm run build`.

## Most important outstanding work

1. Validate auto deploy safely on Windows using a non-critical GitHub commit; check that restarts and browser reloads work, no loss of SQLite save, and Cloudflare Tunnel stays open.
2. **Market transactions not yet implemented:** Supabase market view is read-only; design secure escrow and settlement before enabling Sell/Buy/Cancel/Receive. Current browser saves contain inventory and gold, so don't trust browser-submitted ownership or wallet balances. Harden server authority first; use idempotent transactions, ownership checks, and rollback/recovery tests. Preserve original market UI.
3. World chat is local SQLite/polling, not Supabase Realtime. Don't swap to upstream Supabase Auth without migration.
4. GM role checking exists for UI and the local CLI; **client-side GM grant/save integrity is not a hardened anti-cheat system**. Restrict server-controlled rewards before public multiplayer.
5. There may be older code paths and test assumptions from upstream; prefer minimal targeted changes and run related tests.

## Commands

```powershell
cd "D:\\inter\\volam1\\jxweb\\Project\\vltk-web"
git pull origin main
npm run build
npm test
npm run account:role -- kiritotaka admin   # once, existing account only
npm run serve:auto                         # replaces npm start; separate PowerShell window for cloudflared
```

Cloudflare quick tunnel, in another terminal:

```powershell
cloudflared tunnel --url http://localhost:3000
```

## Codex continuation prompt

Read `docs/CODEX_HANDOFF.md`, `README.md`, and the source/tests for the exact feature to be changed. Work only in this fork's checkout. First inspect `git status` and `git log -5`; protect local SQLite. Prioritize safe, incremental changes; preserve existing game UI. Run build and relevant tests before pushing. Ask for explicit confirmation before any destructive database/schema operations.
