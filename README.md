# Reconciliation Tool

A Node.js script that compares **internal_ledger.json** (JSON) and **bank_settlement.csv** (CSV) and reports data integrity issues using a fixed matching rule.

**Matching logic:**

- **Primary key:** `trade_id` — links each ledger row to the corresponding bank row.
- **Amount rule:** For every trade, **Bank amount_settled** must equal **Ledger (quantity × price) + fee**. The script checks this for each matching `trade_id`.
- **Both directions:** It reports records only in the Ledger, only in the Bank, and amount mismatches (same `trade_id` but different amounts).

Source files are **never modified**; the script only reads them and writes the report to the terminal or to a file (e.g. `--output report.txt`).

## Requirements

- Node.js 18+ (uses ES modules).

## How to execute

1. Open a terminal and go to the project folder:
   ```bash
   cd /path/to/zerohash
   ```

2. Run the script with the ledger (JSON) first, then the bank file (CSV), and **always use `--key trade_id`** for this reconciliation:
   ```bash
   node reconcile.js sample-data/internal_ledger.json sample-data/bank_settlement.csv --key trade_id
   ```

3. **Optional:** Write the report to a file. A plain filename is saved on your **Desktop**:
   ```bash
   node reconcile.js sample-data/internal_ledger.json sample-data/bank_settlement.csv --key trade_id --output report.txt
   ```

4. The report is printed in the terminal. If you used `--output`, the path is shown (e.g. `Report written to /Users/you/Desktop/report.txt`).

**Using the npm script:**

```bash
npm run test
```

This runs the same reconciliation (ledger + bank + `--key trade_id`) with the sample data. To use your own files:

```bash
node reconcile.js /path/to/internal_ledger.json /path/to/bank_settlement.csv --key trade_id
```

## Usage

```bash
node reconcile.js <internal_ledger.json> <bank_settlement.csv> --key trade_id [options]
```

For this reconciliation you must use `--key trade_id` so rows are matched by trade ID and amounts are compared as **Ledger (quantity×price)+fee** vs **Bank amount_settled**.

### Options

| Option | Description |
|--------|-------------|
| `--key trade_id` | **Required.** Matches ledger and bank rows by trade ID and enables the amount rule. |
| `--output <path>` | Write the report to a file. Plain filename → Desktop; path → that path. |
| `--common-fields` | Only compare fields present in both (for other data shapes). |
| `--quiet` | No report output; only exit code (0 = OK, 1 = issues, 2 = error). |

### Examples

```bash
# Run reconciliation with sample data
node reconcile.js sample-data/internal_ledger.json sample-data/bank_settlement.csv --key trade_id

# Save report to Desktop
node reconcile.js sample-data/internal_ledger.json sample-data/bank_settlement.csv --key trade_id --output report.txt

# Save report to a specific path
node reconcile.js sample-data/internal_ledger.json sample-data/bank_settlement.csv --key trade_id --output ./reports/reconcile.txt

# Exit code only (e.g. in scripts)
node reconcile.js sample-data/internal_ledger.json sample-data/bank_settlement.csv --key trade_id --quiet
echo $?   # 0 = no issues, 1 = issues found
```

## What the report shows

1. **Only in Ledger** — Records in the JSON (internal ledger) but not in the CSV (bank settlement).
2. **Only in Bank** — Records in the CSV but not in the JSON.
3. **Amount mismatches** — Same trade_id but Ledger (quantity×price)+fee ≠ Bank amount_settled.
4. **Missing key** — Rows without the chosen key field; reported separately.

## File format expectations

- **internal_ledger.json**: Array of objects with `trade_id`, and for amount comparison `quantity`, `price`, and `fee`.
- **bank_settlement.csv**: First row = headers including `trade_id` and `amount_settled`. One row per trade.

## Sample run

Using the included sample data:

```bash
node reconcile.js sample-data/internal_ledger.json sample-data/bank_settlement.csv --key trade_id
```

Or:

```bash
npm run test
```

You should see a summary plus sections **Only in Ledger**, **Only in Bank**, and **Amount mismatches** when there are differences.

## Exit codes

- `0` — No integrity issues.
- `1` — One or more issues found (missing records or mismatches).
- `2` — Usage or runtime error (e.g. missing file, invalid JSON/CSV).
