import type { NetworkRequest } from "../shared/types";

export function formatNumber(value: number): string {
  return value.toLocaleString();
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "-";
  }

  if (value < 1024) {
    return `${value}B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let current = value / 1024;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current.toFixed(current >= 10 ? 0 : 1)}${units[unitIndex]}`;
}

export function formatDurationMs(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }

  if (value >= 1000) {
    const seconds = value / 1000;
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }

  if (value >= 100) {
    return `${value.toFixed(0)}ms`;
  }

  return `${value.toFixed(1)}ms`;
}

export function formatTimestampMs(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  return `${value.toFixed(1)}ms`;
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const segment = Math.max(1, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, segment)}…${value.slice(-segment)}`;
}

export function renderTable(rows: string[][]): string[] {
  if (rows.length === 0) {
    return [];
  }

  const widths = rows[0]!.map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0)),
  );

  return rows.map((row, rowIndex) =>
    row
      .map((cell, columnIndex) => {
        const width = widths[columnIndex] ?? cell.length;
        if (rowIndex > 0 && columnIndex > 0) {
          return cell.padStart(width);
        }
        return cell.padEnd(width);
      })
      .join("  "),
  );
}

export function divider(width: number): string {
  return "─".repeat(width);
}

export function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const parts = [
    days > 0 ? `${days}d` : null,
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    secs > 0 || totalSeconds === 0 ? `${secs}s` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

export function formatIsoDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export function formatNetworkSize(request: NetworkRequest): string {
  return formatBytes(request.encodedDataLength ?? request.decodedBodyLength ?? 0);
}
