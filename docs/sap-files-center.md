# SAP files center

Entry point: `/reconciliation?view=sap-files`.

The existing `institution-sap/lieutenant/` Supabase archive remains the only original-file archive. Its immutable SHA-256 keys, original byte envelopes, pagination and snapshot dates are retained. `current.json` remains the compatibility view consumed by instant matching, stock, SAP invoice register and monthly reconciliation; new transfer uploads publish their decoded text through the existing authenticated API. Balance/opening/OINM/official documents never replace that transfer view.

Moved interfaces:

- First lieutenant: upload, original archive, classification, deletion and transfer processing. The lieutenant retains its read-only audit, snapshot restoration, query generator and saved decisions.
- Invoice matching bulk preview: TXT upload/replacement, saved-text edits and deletion. Its existing explicit invoice preparation actions remain available against the shared saved source.
- Aqaba: SAP official-document, transfer and OINM input. Blue paper invoices/prices stay in Aqaba.
- M2026: reads a saved monthly export, falling back to the shared full SAP transfer export. It no longer requests a second upload/paste.
- Saja Excel input is not a SAP source and remains in the serial soldier screen.

## Processing and preservation

`/api/sap-processing` uses the existing authentication and same-origin gateway. Additive D1 tables track jobs, batches, exact-document receipts, and previous processing runs. The file's parsed plan and all batch payloads are durable before work starts. Ordinary screen navigation only reads state. A batch uses an atomic two-minute database lease; successful batches cannot be claimed twice. An expired lease is resumable after an interrupted request. Failed batches retain their error and all successful predecessors. Completion requires every planned batch to exist and succeed.

Explicit rechecking preserves the prior job/batches in history, refuses to reset active work, rebuilds classification, and reuses exact fingerprints only when the corresponding transfer still exists in the queue or invoice keys. New or changed documents alone need queue import. Existing invoice payloads, approval decisions, transfer identifiers and cancellation decisions are never rewritten by the processor. Original business rules continue to exclude reverse, canceled, Cash Van and invalid transfers from automatic invoice preparation.

Imports use at most 50 documents and normally at most 600 KB per batch, with a bounded oversized-single-document allowance. Queue inserts use one atomic JSON-table insert with `RETURNING`, preserving unique transfer IDs and reporting actual insertions. Aqaba uses one prior-row read plus atomic bulk audit/upsert statements, retaining its before-images. A failed import never deletes originals or earlier successful batches.

Original download names and byte content are preserved. Deleting an original requires the existing signed-in workspace permission and an explicit browser confirmation. It does not delete processed documents, invoices, cancellation decisions or processing history. Stock dates remain embedded in the existing immutable keys and are independent of upload timestamps. Undated legacy snapshots can be copied with an explicitly confirmed date; originals remain untouched. Upload-date filters display Asia/Amman dates.

## Verification

- `node scripts/test-sap-files.mjs`: real route logic/SQL against SQLite through a D1 transport shim; 867 documents, failure/resumption, idempotence, exact-fingerprint reuse, changed documents, lease contention/expiry, preserved decisions/invoices, prior-run history, stock separation, Aqaba and OINM imports.
- `node scripts/test-sap-archive.mjs`: real authenticated gateway/storage code with an in-memory Supabase transport; byte-perfect original retrieval, duplicate uploads, opening/closing dates, invalid-date rejection, download names, auth, same-origin, path validation and 205-file pagination.
- Existing JS/Python regression suites, TypeScript and production build.
- Local browser inspection uses the real application with a disposable local password, with no production credentials. The preview has no production Supabase secret; storage errors are expected there.

### Local performance baseline

Reproduce with `SAP_BENCH_BASE_REF=83b237d node scripts/test-sap-files.mjs` in a checkout containing that base commit. The benchmark runs the original pre-change import route from Git against the new persistent processor on the same SQLite dataset: 867 transfers and 2,000 historical invoice records. No artificial network latency is added. This is local SQL/route timing, not Cloudflare/Supabase production latency.

| Run | Original route, ms | New processor, ms | Original batches/scans | New batches/scans |
| --- | ---: | ---: | ---: | ---: |
| 1 | 921.11 | 336.09 | 87 | 18 |
| 2 | 884.37 | 263.98 | 87 | 18 |
| 3 | 1093.48 | 243.27 | 87 | 18 |

Median: 921.11 ms → 263.98 ms (~71% lower). Reopening an already processed file took 1.68–2.55 ms locally and performed zero invoice scans/import batches. Production timing remains to be measured from a permitted signed-in session.
