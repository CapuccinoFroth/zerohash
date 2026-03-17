#!/usr/bin/env node

/**
 * Reconciliation Tool — compares JSON and CSV files and reports data integrity issues.
 * Source files (JSON and CSV) are read only and are never modified. Only the report is written (to stdout or --output).
 *
 * Usage:
 *   node reconcile.js <json-path> <csv-path> [options]
 *
 * Options:
 *   --key <field>       Field name used to match records (default: id)
 *   --common-fields     Only compare fields that exist in both sources (ignores schema differences)
 *   --output <path>     Write report to file (plain filename → Desktop)
 *   --quiet             Only exit code; no report output
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, join } from "path";

const DEFAULT_KEY = "id";

function parseArgs() {
  const args = process.argv.slice(2);
  const positional = [];
  const options = { key: DEFAULT_KEY, output: null, quiet: false, commonFieldsOnly: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key" && args[i + 1]) {
      options.key = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === "--quiet") {
      options.quiet = true;
    } else if (args[i] === "--common-fields") {
      options.commonFieldsOnly = true;
    } else if (!args[i].startsWith("--")) {
      positional.push(args[i]);
    }
  }

  const [jsonPath, csvPath] = positional;
  if (!jsonPath || !csvPath) {
    console.error("Usage: node reconcile.js <json-path> <csv-path> [--key <field>] [--common-fields] [--output <path>] [--quiet]");
    process.exit(2);
  }

  return {
    jsonPath: resolve(jsonPath),
    csvPath: resolve(csvPath),
    ...options,
  };
}

function loadJson(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw);
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return Object.entries(data).map(([k, v]) => (typeof v === "object" && v !== null ? { ...v, id: v.id ?? k } : { id: k, value: v }));
  }
  throw new Error(`Invalid JSON structure: expected array or object at ${filePath}`);
}

/**
 * Simple CSV parser: first row = headers, supports quoted fields with commas.
 */
function parseCsv(text) {
  const rows = [];
  let i = 0;
  const nextLine = () => {
    const start = i;
    while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
    const line = text.slice(start, i).replace(/\r$/, "");
    if (i < text.length) i++;
    return line;
  };

  const parseRow = (line) => {
    const out = [];
    let cell = "";
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (inQuotes) {
        cell += c;
      } else if (c === ",") {
        out.push(cell.trim());
        cell = "";
      } else {
        cell += c;
      }
    }
    out.push(cell.trim());
    return out;
  };

  const headerLine = nextLine();
  if (!headerLine) return rows;
  const headers = parseRow(headerLine);

  while (i < text.length) {
    const line = nextLine();
    if (!line.trim()) continue;
    const values = parseRow(line);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function loadCsv(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  return parseCsv(raw);
}

function getKey(record, keyField) {
  const v = record[keyField];
  return v === undefined || v === null ? undefined : String(v);
}

function buildMap(records, keyField) {
  const map = new Map();
  const missing = [];
  for (const r of records) {
    const k = getKey(r, keyField);
    if (k === undefined || k === "") {
      missing.push(r);
      continue;
    }
    map.set(k, r);
  }
  return { map, missing };
}

/** Ledger: (Quantity * Price) + Fee. Returns null if any field missing. */
function ledgerSettledAmount(ledgerRecord) {
  const q = Number(ledgerRecord.quantity);
  const p = Number(ledgerRecord.price);
  const f = Number(ledgerRecord.fee);
  if (Number.isNaN(q) || Number.isNaN(p) || Number.isNaN(f)) return null;
  return q * p + f;
}

/** Bank: amount_settled as number. Returns null if missing or invalid. */
function bankSettledAmount(bankRecord) {
  const v = bankRecord.amount_settled;
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).trim());
  return Number.isNaN(n) ? null : n;
}

/** True if both records support ledger-vs-bank amount comparison. */
function canCompareAmounts(ledgerRecord, bankRecord) {
  return ledgerSettledAmount(ledgerRecord) !== null && bankSettledAmount(bankRecord) !== null;
}

const AMOUNT_EPSILON = 1e-6;

function amountsEqual(ledgerAmount, bankAmount) {
  if (ledgerAmount == null || bankAmount == null) return false;
  return Math.abs(ledgerAmount - bankAmount) <= AMOUNT_EPSILON;
}

/** Compare by rule: Bank amount_settled must equal Ledger (quantity*price)+fee. Returns null if match, else { ledgerAmount, bankAmount }. */
function compareLedgerVsBank(ledgerRecord, bankRecord) {
  const ledgerAmt = ledgerSettledAmount(ledgerRecord);
  const bankAmt = bankSettledAmount(bankRecord);
  if (ledgerAmt == null || bankAmt == null) return null;
  if (amountsEqual(ledgerAmt, bankAmt)) return null;
  return { ledgerAmount: ledgerAmt, bankAmount: bankAmt };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return String(a) === String(b);
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function getCommonKeys(a, b) {
  const keysB = new Set(Object.keys(b));
  return Object.keys(a).filter((k) => keysB.has(k));
}

function diffRecords(jsonRec, csvRec, keyField, commonFieldsOnly = false) {
  const keys = commonFieldsOnly
    ? getCommonKeys(jsonRec, csvRec)
    : [...new Set([...Object.keys(jsonRec), ...Object.keys(csvRec)])];
  const differences = [];
  for (const k of keys) {
    const jv = jsonRec[k];
    const cv = csvRec[k];
    const jStr = jv === undefined || jv === null ? "" : String(jv);
    const cStr = cv === undefined || cv === null ? "" : String(cv);
    if (jStr !== cStr) {
      differences.push({ field: k, json: jv, csv: cv });
    }
  }
  return differences;
}

function equalOnCommonFields(a, b) {
  const common = getCommonKeys(a, b);
  for (const k of common) {
    const av = a[k];
    const bv = b[k];
    const aStr = av === undefined || av === null ? "" : String(av);
    const bStr = bv === undefined || bv === null ? "" : String(bv);
    if (aStr !== bStr) return false;
  }
  return true;
}

function normalizeForReport(record, keyField) {
  const key = getKey(record, keyField);
  const rest = { ...record };
  delete rest[keyField];
  return { key, record: rest };
}

function runReconciliation(jsonPath, csvPath, keyField, commonFieldsOnly = false) {
  const jsonRecords = loadJson(jsonPath);
  const csvRecords = loadCsv(csvPath);

  const { map: jsonByKey, missing: jsonMissingKey } = buildMap(jsonRecords, keyField);
  const { map: csvByKey, missing: csvMissingKey } = buildMap(csvRecords, keyField);

  const onlyInJson = [];
  const onlyInCsv = [];
  const mismatches = [];

  const recordsMatch = (jr, cr) =>
    commonFieldsOnly ? equalOnCommonFields(jr, cr) : deepEqual(jr, cr);

  // Ledger vs Bank: both directions. Key = trade_id (or --key). Compare: amount_settled (CSV) vs (quantity*price)+fee (JSON).
  for (const k of jsonByKey.keys()) {
    if (!csvByKey.has(k)) {
      onlyInJson.push(jsonByKey.get(k));
    } else {
      const jr = jsonByKey.get(k);
      const cr = csvByKey.get(k);
      const amountDiff = compareLedgerVsBank(jr, cr);
      if (amountDiff !== null) {
        mismatches.push({
          key: k,
          jsonRecord: jr,
          csvRecord: cr,
          differences: [],
          amountDiff,
        });
      } else if (canCompareAmounts(jr, cr)) {
        continue;
      } else if (!recordsMatch(jr, cr)) {
        const diffs = diffRecords(jr, cr, keyField, commonFieldsOnly);
        mismatches.push({
          key: k,
          jsonRecord: jr,
          csvRecord: cr,
          differences: diffs,
          amountDiff: null,
        });
      }
    }
  }

  for (const k of csvByKey.keys()) {
    if (!jsonByKey.has(k)) onlyInCsv.push(csvByKey.get(k));
  }

  return {
    onlyInJson,
    onlyInCsv,
    mismatches,
    jsonMissingKey,
    csvMissingKey,
    stats: {
      jsonTotal: jsonRecords.length,
      csvTotal: csvRecords.length,
      onlyInJson: onlyInJson.length,
      onlyInCsv: onlyInCsv.length,
      mismatches: mismatches.length,
      matched: jsonByKey.size - onlyInJson.length,
    },
  };
}

function formatReport(result, keyField) {
  const lines = [];
  const s = result.stats;

  lines.push("=== Reconciliation Report ===");
  lines.push("");
  lines.push("Matching rule: Bank amount_settled = Ledger (quantity×price)+fee. Key: " + keyField + ".");
  lines.push("");
  lines.push(`Key field: ${keyField}`);
  lines.push(`JSON total: ${s.jsonTotal}  |  CSV total: ${s.csvTotal}`);
  const identical = s.matched - s.mismatches;
  lines.push(`In both: ${s.matched}  |  Identical: ${identical}  |  Mismatches: ${s.mismatches}`);
  lines.push("");

  if (result.jsonMissingKey.length) {
    lines.push(`Records missing key "${keyField}" in JSON: ${result.jsonMissingKey.length}`);
    result.jsonMissingKey.forEach((r) => lines.push(`  - ${JSON.stringify(r)}`));
    lines.push("");
  }
  if (result.csvMissingKey.length) {
    lines.push(`Records missing key "${keyField}" in CSV: ${result.csvMissingKey.length}`);
    result.csvMissingKey.forEach((r) => lines.push(`  - ${JSON.stringify(r)}`));
    lines.push("");
  }

  if (result.onlyInJson.length) {
    lines.push(`--- Only in Ledger / internal_ledger (${result.onlyInJson.length}) ---`);
    result.onlyInJson.forEach((r) => lines.push(`  ${getKey(r, keyField)}: ${JSON.stringify(r)}`));
    lines.push("");
  }

  if (result.onlyInCsv.length) {
    lines.push(`--- Only in Bank / bank_settlement (${result.onlyInCsv.length}) ---`);
    result.onlyInCsv.forEach((r) => lines.push(`  ${getKey(r, keyField)}: ${JSON.stringify(r)}`));
    lines.push("");
  }

  if (result.mismatches.length) {
    lines.push(`--- Amount mismatches (Ledger (q×p)+fee ≠ Bank amount_settled) (${result.mismatches.length}) ---`);
    result.mismatches.forEach((m) => {
      lines.push(`  Key: ${m.key}`);
      if (m.amountDiff) {
        const { ledgerAmount, bankAmount } = m.amountDiff;
        lines.push(`    Ledger (quantity×price)+fee = ${ledgerAmount}  vs  Bank amount_settled = ${bankAmount}`);
      }
      m.differences.forEach((d) => lines.push(`    ${d.field}: JSON="${d.json}" vs CSV="${d.csv}"`));
    });
  }

  const hasIssues =
    result.onlyInJson.length > 0 ||
    result.onlyInCsv.length > 0 ||
    result.mismatches.length > 0 ||
    result.jsonMissingKey.length > 0 ||
    result.csvMissingKey.length > 0;

  lines.push("");
  lines.push(hasIssues ? "Result: INTEGRITY ISSUES FOUND" : "Result: OK — no issues");
  return { text: lines.join("\n"), hasIssues };
}

function main() {
  const { jsonPath, csvPath, key, output, quiet, commonFieldsOnly } = parseArgs();

  let result;
  try {
    result = runReconciliation(jsonPath, csvPath, key, commonFieldsOnly);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(2);
  }

  const { text, hasIssues } = formatReport(result, key);

  if (!quiet) {
    if (output) {
      const isPlainFilename = !output.includes("/") && !output.includes("\\");
      const outPath = isPlainFilename
        ? join(process.env.HOME || process.env.USERPROFILE || "", "Desktop", output)
        : resolve(output);
      const outPathResolved = resolve(outPath);
      if (outPathResolved === jsonPath || outPathResolved === csvPath) {
        console.error("Error: --output must not be the JSON or CSV source file. Source files are never modified.");
        process.exit(2);
      }
      writeFileSync(outPathResolved, text, "utf-8");
      console.log(`Report written to ${outPathResolved}`);
    } else {
      console.log(text);
    }
  }

  process.exit(hasIssues ? 1 : 0);
}

main();
