export function formatNumber(value: number) {
  return value.toLocaleString();
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
