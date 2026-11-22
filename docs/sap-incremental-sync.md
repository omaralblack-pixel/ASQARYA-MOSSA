# SAP 011 — Verified incremental chunk reuse (pilot)

This feature is a **conservative acceleration of the existing monthly SAP import**. It is not a replacement for the source archive or a change to the HANA query. The operator continues to export all records from the first of the month.

## Verified import sequence

1. Archive and read back the immutable original in private Supabase Storage.
2. Split each validated unified section into document-complete chunks and archive/verify each chunk. Transfer chunks use content-defined, deterministic document-number anchors and a strict physical size limit; inserting or correcting a document normally changes only its neighboring chunk(s), rather than every later byte-position chunk.
3. For transfer chunks only, request a **reuse** decision from the server.
4. The server fetches the archived new chunk and recomputes SHA-256. Reuse is possible only when an identical hash has **exactly one** staged chunk in the **active approved** previous snapshot and the processor version and saved branch-configuration fingerprint match. The live active row count is verified once at the start of the daily import, not on each chunk.
5. In one database transaction, guard the active snapshot pointer, create a completed receipt for the new chunk and copy the old staged rows to the new root. Repeated requests recognize the completed receipt.
6. New, changed, ambiguous, unmatched, or incompatible chunks follow the existing full import + stage path. Official invoices, OINM and daily balances still follow their original workflow.
7. The new daily snapshot activates only after the complete expected chunk sequence, completed receipts, exact document counts and unique transfer numbers are verified. Previous queue/history and all originals remain available.

## Operational limitations

- The **first import** on the new processor version must run in full; the former active snapshot lacks compatible-version metadata. Reuse begins only after a complete, correctly activated versioned baseline.
- The full original and independently verifiable chunk files are **still uploaded**. This reduces CPU, parsing, duplicate import and staging work for unchanged transfer chunks; it **does not eliminate network upload** or unchanged official/journal processing. Measured speedups depend on how many chunk byte sequences are identical from one day to the next.
- Any changed line (cancellation, branch, remarks, quantity, etc.) alters its chunk bytes and disqualifies it from reuse; there is no date-only or document-number-only shortcut.
- Never derive cancellations from missing rows. A truncated source fails validation, and no new snapshot should be activated.
- The active snapshot is not changed on individual chunk reuse; only the existing final commit can activate it. The project invoice ledger and manual decisions are stored separately and are not modified by reuse.
- Bump `sapProcessorVersion` in `app/lib/sap-processor-version.ts` for any parser/staging semantic change.
- Before enabling on production, run regression tests, compare a full baseline and a following daily import with SAP and verify the active transfer count, cancellations, stock snapshots, and blue-invoice matches. Leave the existing full importer as fallback.

## Verification

Run `node scripts/test-sap-snapshot.mjs`, `node scripts/test-unified-sap.mjs`, `node scripts/test-sap-files.mjs`, `pnpm exec tsc --noEmit`, and the Institution reconciliation checks workflow. The snapshot regression includes identical-chunk reuse, replay, archive-tamper rejection and preservation of reconciliations.

## Local historical-source benchmark (not a 21/22 live comparison)

A previous private SAP source, dated 2026-11-17, was analyzed locally **without uploading its business rows to GitHub**. It contains 18,713 data rows, including 9,068 `TRANSFER` lines across 1,003 transfer document numbers; its uploaded original is 6.23 MB (UTF-16).

In a **simulation** using this baseline, appending 30 synthetic new transfer documents and changing the cancellation status of one old line produced:
- Previous sequential byte-budget splitter: 9 old chunks, 7 byte-identical chunks reused.
- Content-defined splitter (280 KB cap, document-number hash anchors): 13 old chunks, 11 byte-identical chunks reused.

These are **chunk-count estimates**, not elapsed-time measurements. They do not show a verified comparison between the full private 21-Nov and 22-Nov archives. More chunks mean additional storage/read requests, so actual latency and Cloudflare cost must be measured before production rollout.
