# SAP Desktop Sync implementation and deployment

## Inspected baseline

Source baseline: `7365b970e57fd68c74debaf49528c8e434a90725`, 18 November 2026. Later concurrent main updates through `8110e02f7be6bab31348a33603cf16159749826e` were merged into this isolated branch, retaining their browser chunking fix.

- `worker/institution.ts`: password/session and same-origin gateway; private Supabase `institution-sap/lieutenant/` original byte envelopes; `current.json` compatibility export.
- `app/api/sap-processing/route.ts`: persistent D1 jobs, generations, batches, two-minute atomic leases, exact document receipts, historical processing runs. Planning delegates to the signed Supabase `sap-plan` function when configured.
- `app/api/reconcile/route.ts`: unique transfer queue and existing invoice protection. Desktop calls only the existing SAP processing actions, never save/merge/cancel invoice actions.
- `app/api/aqaba/route.ts`: existing official-document, transfer and journal upsert/audit semantics.
- `SapFiles.tsx`: latest baseline already accepts different daily contents with the same name, even while an older job remains incomplete. This behavior is retained.

## Protocol and preservation

`/desktop-sync` manages 90-day, revocable, random per-device bearer tokens. D1 stores token SHA-256 only. Creation/revocation requires the existing signed-in same-origin session. Device credentials authenticate only `/api/desktop-sync`; they never authenticate invoice routes, management, original deletion, arbitrary processing keys, or destructive rechecks. Tokens are not embedded in EXE. Windows stores the entered token using DPAPI CurrentUser.

The client polls the selected folder every two seconds, waits eight seconds after last observed size/mtime change, and uses Windows sharing rules to reject active writers while copying. Source TXT remains untouched. An immutable local byte snapshot and recovery manifest are flushed before SQLite queue insertion. SQLite uses WAL and FULL synchronous writes. Startup replays manifests missing from the queue. File content identity uses all 256 SHA bits. The existing archive key format (128-bit prefix) is preserved for backward compatibility, and desktop ingestion independently verifies the full hash by fresh readback before acknowledging. If full readback disagrees, ingestion fails closed.

Upload retry is content-idempotent per device. Status is read before every processing step. Existing partial jobs are resumed; successful batches are never reset by desktop actions. Failed/offline/5xx responses retain local bytes and durable stage, with jittered exponential retry. Permanent input/auth errors block for review and can resume after reconnect. Redirects are refused so credentials are never forwarded to another host.

For unified originals larger than 280 KB, the desktop creates deterministic small raw unified child files, with the original WINDOW metadata in each and no SAP document split across files. Children are immutable and independently verified/processed using the existing planner. The server reconstructs the complete ordered child hashes from the parent original and requires every child batch to be complete before publication. A parent with an existing partial D1 job continues that job instead. Completed children never publish an incomplete compatibility view. Python and TypeScript chunk derivations are checked for byte equality. This avoids requesting a monolithic large Supabase plan, while retaining the full original and old 1/3 jobs.

After all existing batches finish, publication creates derived transfer/opening/closing archives for unified exports, retaining the real query dates. Legacy shared readers see a raw-row, document-number merge: incoming document replaces its prior rows, older missing documents and all columns remain. Source save timestamps, rather than upload arrival order, determine snapshot precedence. Late retries of older snapshots supplement missing documents without overwriting newer document contents. No match, invoice or cancellation decision is inferred by this merge.

Compatibility snapshots are immutable private Supabase `sync-views/*.json` objects, referenced through an atomic D1 pointer. D1 lease fencing prevents an expired writer from replacing the active view after a delayed Storage response. Prior views/originals and processing history remain. The normal authenticated saved-import GET resolves the pointer; explicit legacy manual PUT/DELETE resets the pointer and invalidates an active desktop publisher. Queued existing records/invoice payloads continue following the pre-existing importer semantics.

A shared browser subscription polls a read-only publication revision every 15 seconds while visible and on focus. It reruns SAP source-reading effects in files, instant matching, SAP import, invoice register, monthly reconciliation, stock, lieutenant, reassurance, Aqaba and colonel. It does not reload the page or reset the user's invoice draft.

## Deployment findings and release procedure

**GitHub pushes do not deploy this application.** Existing Actions run checks, not deployment. The retained `.openai/hosting.json` points to Sites project `appgprj_6ae983afca2c8191aa6e5e465446e426`. Read-only Sites inspection returned an older active site at `https://kilani-military-exchanges.almqablen.chatgpt.site` (version 4); this does not prove that it controls the separate `asqarya-mossa.almqablen.workers.dev` Worker used for institution work.

`vite.config.ts` builds a standalone Cloudflare Worker, preserving runtime vars, setting a Supabase URL and declaring D1 `DB`. The generated build's default Worker name is the starter name and its D1 definition lacks a verified production `database_id`. **Do not deploy that configuration blindly and do not let Wrangler provision a replacement empty database.** A read-only request to the Workers production version API was blocked with HTTP 403 by this execution environment; no signed-in live version, binding, Cloudflare deployment credential, or production synchronization was verified here.

Release steps for an operator with Cloudflare access:

1. Keep the branch isolated. Build a staging Worker with a separate D1 database and a separate private Supabase project/bucket/function for tests. Existing source hardcodes a bucket name; a separate Supabase project is the safest isolation. Use synthetic data only. A different Worker against the same production Supabase would still mutate production evidence.
2. Install pinned dependencies, run the listed tests, and build. Set `CLOUDFLARE_D1_DATABASE_ID` and `CLOUDFLARE_D1_DATABASE_NAME` to the intended **existing** staging database before build. Ensure the staging Supabase URL replaces the production build variable. Supply server secrets only in Cloudflare: `INSTITUTION_PASSWORD`, `INSTITUTION_SESSION_SECRET`, `SUPABASE_STORAGE_SECRET`. Confirm `DB` binding and private `institution-sap` bucket exist.
3. Deploy and verify `supabase/functions/sap-plan` to the **same staging Supabase project**. Its existing custom HMAC gateway must be reachable with the function's JWT verification configuration matching that protocol. Test this from the Worker rather than bypassing verification globally. The planner does not write invoice records. An HTTP 546 can indicate upstream execution/resource failure; this patch reports the upstream status and preserves progress, but production logs/resources remain necessary to diagnose its root cause.
4. Inspect the generated `dist/server/wrangler.json`, including Worker name, existing D1 ID, vars and assets. Deploy explicitly to the intended staging Worker through the authorized Cloudflare account. Never use the stale Sites ID as proof of deployment to Workers.
5. Sign into staging, inspect `/api/reconcile?version=1`, create a test device at `/desktop-sync`, and point the EXE at staging. Verify full byte hash, same-content retry, same-name changed content, offline retry, 1/3 recovery, shared views, stock dates and open-screen updates. Check existing invoice counts and decisions are unchanged. No production acceptance test was run in this session.
6. After staging acceptance, merge/review the branch. Take backups of the existing D1 and private storage, verify the exact production Worker/account and existing D1 ID, build the accepted commit with the production configuration, deploy explicitly, and verify that exact commit through the authenticated version API. Do not alter database identity or replace existing secrets. The new tables initialize additively.
7. Only after the published protocol responds successfully, pair the user's real Windows PC and run the acceptance sequence in the Arabic guide. GitHub success, EXE build success, and server deployment are three different states.

Rolling back the Worker code does not delete originals, batches, invoice data or desktop queue. A rollback to code before immutable shared-view support reads the retained legacy `current.json`, which may be older; account for that when reviewing a rollback. Revoke device tokens to stop further ingestion.

## Verification

- `python -m unittest discover -s desktop-sync/tests -v`: source stability, independent same-name versions, unchanged-content dedup, durable manifests after crash, offline/502 and lost-response recovery, expired credentials, encoding and corruption. Windows additionally tests DPAPI and open-writer file locks.
- `node scripts/test-desktop-sync.mjs`: actual gateway/API logic with SQLite-backed D1 and a deterministic in-memory Supabase transport. Full hash readback, uncertain writes, planner 546, preserved 1/3 progress, immutable publication fencing, older/newer ordering, no invoice or cancellation creation, revocation and shared view.
- Existing SAP processing/archive/source-integrity/system audit tests, TypeScript and production build.
- `.github/workflows/sap-desktop-sync.yml` builds/tests on Windows and uploads an EXE package. `build.ps1` also runs a packaged EXE self-test; no live credentials/data are used. The Windows build and packaged EXE self-test also completed successfully in GitHub Actions on the initial branch revision. The final accepted run is recorded in the PR. Build artifacts are unsigned and not a claim of installation on the user's PC.
