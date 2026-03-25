import type { TableColumn } from "../shared/types.js";
import type { PrettyOptions } from "./types.js";

function formatScalar(value: unknown) {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export function divider(width: number) {
  return "─".repeat(width);
}

export function renderTable(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = rows[0]!.map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0)),
  );
  return rows.map((row, rowIndex) =>
    row
      .map((cell, columnIndex) => {
        const width = widths[columnIndex] ?? cell.length;
        if (rowIndex > 0 && columnIndex > 0) return cell.padStart(width);
        return cell.padEnd(width);
      })
      .join("  "),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRectangularRows(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every(isPlainRecord)) return false;
  const rows = value as Record<string, unknown>[];
  const keys = new Set(Object.keys(rows[0] ?? {}));
  if (keys.size === 0) return false;
  let comparable = 0;
  for (const row of rows) {
    const rowKeys = Object.keys(row);
    const overlap = rowKeys.filter((key) => keys.has(key)).length;
    if (overlap >= Math.max(1, Math.floor(keys.size / 2))) comparable += 1;
  }
  return comparable >= Math.max(1, Math.ceil(rows.length / 2));
}

function cellValue(value: unknown) {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (Array.isArray(value)) {
    // Scalar arrays: join with commas
    if (
      value.every(
        (item) =>
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean" ||
          item == null,
      )
    ) {
      return value.map((item) => formatScalar(item)).join(", ");
    }
    // Arrays of named objects (e.g. column metadata): show just names
    if (
      value.length > 0 &&
      value.every(
        (item) => isPlainRecord(item) && typeof (item as Record<string, unknown>).name === "string",
      )
    ) {
      return value.map((item) => (item as Record<string, unknown>).name).join(", ");
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

export function table(
  value: unknown,
  options?: { columns?: string[]; maxRows?: number; columnMeta?: TableColumn[] },
) {
  if (!Array.isArray(value)) {
    throw new Error("table(...) expects an array of row objects");
  }
  const rows = value as unknown[];
  if (rows.length === 0) return "(no rows)";
  if (!rows.every(isPlainRecord)) {
    throw new Error("table(...) expects an array of plain row objects");
  }

  const providedColumns = options?.columns?.filter(Boolean);
  const inferred = new Set<string>();
  for (const row of rows as Record<string, unknown>[]) {
    Object.keys(row).forEach((key) => inferred.add(key));
  }
  const orderedColumns =
    providedColumns && providedColumns.length > 0
      ? providedColumns
      : options?.columnMeta && options.columnMeta.length > 0
        ? options.columnMeta.map((column) => column.name).filter((name) => inferred.has(name))
        : [...inferred];

  const maxRows = options?.maxRows && options.maxRows > 0 ? options.maxRows : undefined;
  const limitedRows = maxRows ? rows.slice(0, maxRows) : rows;
  const rendered = renderTable([
    orderedColumns,
    ...limitedRows.map((row) =>
      orderedColumns.map((column) => cellValue((row as Record<string, unknown>)[column])),
    ),
  ]);
  const suffix = maxRows && rows.length > maxRows ? `\n… ${rows.length - maxRows} more row(s)` : "";
  return `${rendered.join("\n")}${suffix}`;
}

function prettyObject(value: Record<string, unknown>, indent = "") {
  const entries = Object.entries(value);
  if (entries.length === 0) return `${indent}{}`;
  const widths = entries.map(([key]) => key.length);
  const maxWidth = Math.max(...widths);
  const lines: string[] = [];
  for (const [key, entryValue] of entries) {
    if (Array.isArray(entryValue) || isPlainRecord(entryValue)) {
      lines.push(`${indent}${key.padEnd(maxWidth)}  `);
      lines.push(pretty(entryValue, { mode: "auto" }, `${indent}  `));
    } else {
      lines.push(`${indent}${key.padEnd(maxWidth)}  ${formatScalar(entryValue)}`);
    }
  }
  return lines.join("\n");
}

function prettyArray(value: unknown[], options?: PrettyOptions, indent = "") {
  if (value.length === 0) return `${indent}[]`;
  if (options?.mode === "table" || isRectangularRows(value)) {
    return indent + table(value, { maxRows: options?.maxRows }).split("\n").join(`\n${indent}`);
  }
  if (value.every((item) => !Array.isArray(item) && !isPlainRecord(item))) {
    return value.map((item) => `${indent}- ${formatScalar(item)}`).join("\n");
  }
  return value
    .map((item) => `${indent}- ${pretty(item, options, `${indent}  `).trimStart()}`)
    .join("\n");
}

export function pretty(value: unknown, options?: PrettyOptions, indent = ""): string {
  if (typeof value === "string") return indent ? `${indent}${value}` : value;
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${indent}${formatScalar(value)}`;
  }
  if (Array.isArray(value)) return prettyArray(value, options, indent);
  if (isPlainRecord(value)) return prettyObject(value, indent);
  return `${indent}${String(value)}`;
}
