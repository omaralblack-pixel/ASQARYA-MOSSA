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

## Auditing actual daily private SAP exports without publishing their data

Download the exact immutable originals for both days from the existing authenticated SAP files screen. On a trusted workstation with Node.js 22+, run:

```sh
node scripts/audit-sap-monthly-sources.mjs "/path/to/21.11.txt" "/path/to/22.11.txt"
```

The script only reads the two local files and prints a JSON summary. It reports full-file SHA-256 values (the archive key contains their first 32 hex characters), transfer/official/OINM record changes, missing records, canceled-state counts, opening/closing balances, date-window mismatches and unknown statuses. The SAP display index column (`#`) and column-order changes are intentionally ignored; unknown columns trigger warnings instead of silent assumptions. The program neither modifies the files nor uploads their contents.

This audit is a *necessary check, not sufficient proof* of correct business reconciliation; anomalies must be reviewed against SAP and the project's existing blue invoices, branch exceptions and cancellation decisions before a production rollout. If a newer 22-Nov archive exists, compare the latest immutable version separately and do not silently assume all 22-Nov versions are equivalent.

## VERIFIED 21-Nov vs 22-Nov private SAP exports (2026-11-22)

Both customer-provided originals were read in a trusted analysis container. Their full SHA-256 digests start with `2d2b4e0dabb1cef83fa656617c38a441` (21-Nov) and `38e0dceaf165fdf82ca4c67a4215fe18` (22-Nov), **matching** the keys of the immutable originals already in the private Supabase archive. Full source bytes and any private invoice rows are **not** checked into GitHub.

| Verified criterion | 21-Nov | 22-Nov |
|---|---:|---:|
| Transfer documents | 1,247 | 1,393 |
| Transfer lines | 11,290 | 12,487 |
| OINM journal rows | 11,459 | 12,656 |
| Official invoice rows | 169 | 169 |
| Opening stock items | 119 | 119 |
| Closing stock items | 120 | 120 |

- **146 new transfer documents**, **zero missing old transfer documents**, **1,197 new transfer lines**, **zero removed old lines**.
- Of 1,247 prior documents, **1,239 are completely unchanged**. The remaining 8 are: **6 N→Y cancellation status corrections** and **2 branch corrections**; 105 old rows differ in those exact fields plus cancellation JournalRemarks.
- **1,197 new OINM rows** corresponding to exactly the 146 new transfer documents. All 11,459 prior OINM rows are unchanged.
- All 169 official invoice rows and all 119 opening balances are unchanged. **69 closing SKU quantities changed**; every one of the **120 SKU-specific closing balance deltas** matches the sum of its new OINM in/out movements to six decimal places.
- **Two newly visible transfer documents** carry earlier posting dates (16-Nov and 19-Nov) and must not be filtered out by a query restricted to today only.
- Real-world candidate chunk reuse on these exact pair of files:
  - Content-defined: **11 matching chunks out of 17** on 22-Nov, **2,422,682 reused source bytes** in modeled transfer-only chunks.
  - Legacy sequential: **9 matching chunks out of 14**, **2,503,225 reused source bytes**. Sequential is slightly better for this pair and requires fewer chunk requests.
- An **adaptive selector** is now included: read only the active snapshot's digest manifest, evaluate both layouts in the browser, and select the layout with the most byte-identical reusable content. If the manifest is incompatible/unavailable, fall back to verified full processing with fewer chunks. Both layouts must pass the same archived-byte and atomic snapshot checks.

**Important limits:** these are source-comparison and local chunk-reuse measurements, not live Cloudflare CPU/timing metrics. A full original and each derived chunk are still uploaded. The first full v2 baseline is required before chunk reuse can engage. Six cancellations and two branch changes must still be validated against the actual project's manual invoice/exception decisions before enabling on production. This read-only verification caused **no production writes**.
