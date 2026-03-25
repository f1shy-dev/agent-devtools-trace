import type { TableFilter, TableFilterOp, TableQueryPlan } from "./types.js";

const VALID_FILTER_OPS = new Set<string>([
  "=",
  "!=",
  "in",
  "contains",
  "startsWith",
  "endsWith",
  ">",
  ">=",
  "<",
  "<=",
  "between",
]);

function normalizeDirection(direction: string | undefined) {
  return direction === "desc" ? "desc" : "asc";
}

function compareValues(left: unknown, right: unknown) {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function matchesFilter(value: unknown, filter: TableFilter) {
  switch (filter.op) {
    case "=":
      return value === filter.value;
    case "!=":
      return value !== filter.value;
    case "in":
      return Array.isArray(filter.values) && filter.values.includes(value);
    case "contains":
      return value != null && String(value).includes(String(filter.value ?? ""));
    case "startsWith":
      return value != null && String(value).startsWith(String(filter.value ?? ""));
    case "endsWith":
      return value != null && String(value).endsWith(String(filter.value ?? ""));
    case ">":
      return compareValues(value, filter.value) > 0;
    case ">=":
      return compareValues(value, filter.value) >= 0;
    case "<":
      return compareValues(value, filter.value) < 0;
    case "<=":
      return compareValues(value, filter.value) <= 0;
    case "between":
      return compareValues(value, filter.lower) >= 0 && compareValues(value, filter.upper) <= 0;
    default:
      return false;
  }
}

export function normalizeFilter(column: string, op: TableFilterOp, value: unknown): TableFilter {
  if (!VALID_FILTER_OPS.has(op)) {
    throw new Error(
      `Invalid filter operator: '${op}'. Valid operators: ${[...VALID_FILTER_OPS].join(", ")}`,
    );
  }
  if (op === "in") {
    return { column, op, values: Array.isArray(value) ? value : [value] };
  }
  if (op === "between") {
    if (Array.isArray(value) && value.length >= 2) {
      return { column, op, lower: value[0], upper: value[1] };
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (obj.lower !== undefined && obj.upper !== undefined) {
        return { column, op, lower: obj.lower, upper: obj.upper };
      }
    }
    throw new Error(
      "'between' filter requires [lower, upper] array or {lower, upper} object",
    );
  }
  return { column, op, value };
}

function normalizePlanFilter(filter: TableFilter): TableFilter {
  if (filter.op === "in") {
    return normalizeFilter(filter.column, filter.op, filter.values ?? filter.value);
  }
  if (filter.op === "between") {
    if (filter.lower !== undefined && filter.upper !== undefined) {
      return {
        column: filter.column,
        op: filter.op,
        lower: filter.lower,
        upper: filter.upper,
      };
    }
    return normalizeFilter(filter.column, filter.op, filter.value);
  }
  return normalizeFilter(filter.column, filter.op, filter.value);
}

export function mergeQueryPlans(base?: TableQueryPlan, extra?: TableQueryPlan): TableQueryPlan {
  return {
    select: extra?.select ?? base?.select,
    where: [...(base?.where ?? []), ...(extra?.where ?? [])],
    orderBy: extra?.orderBy ?? base?.orderBy,
    offset: extra?.offset ?? base?.offset,
    limit: extra?.limit ?? base?.limit,
  };
}

export function applyTablePlan(rows: unknown[], plan?: TableQueryPlan) {
  const normalized = plan ?? {};
  const where = normalized.where?.map(normalizePlanFilter);
  let next = [...rows];

  if (where && where.length > 0) {
    if (next.length > 0) {
      const firstRow = next[0];
      if (firstRow && typeof firstRow === "object") {
        const availableColumns = new Set(Object.keys(firstRow as Record<string, unknown>));
        for (const filter of where) {
          if (!availableColumns.has(filter.column)) {
            throw new Error(
              `Column '${filter.column}' not found. Available columns: ${[...availableColumns]
                .slice(0, 10)
                .join(", ")}`,
            );
          }
        }
      }
    }
    next = next.filter((row) => {
      if (!row || typeof row !== "object") return false;
      return where.every((filter) =>
        matchesFilter((row as Record<string, unknown>)[filter.column], filter),
      );
    });
  }

  if (normalized.orderBy && normalized.orderBy.length > 0) {
    const orderBy = normalized.orderBy;
    next.sort((left, right) => {
      for (const clause of orderBy) {
        const direction = normalizeDirection(clause.direction);
        const cmp = compareValues(
          (left as Record<string, unknown> | null | undefined)?.[clause.column],
          (right as Record<string, unknown> | null | undefined)?.[clause.column],
        );
        if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  if (typeof normalized.offset === "number" && normalized.offset > 0) {
    next = next.slice(normalized.offset);
  }

  if (typeof normalized.limit === "number" && normalized.limit >= 0) {
    next = next.slice(0, normalized.limit);
  }

  if (normalized.select && normalized.select.length > 0) {
    next = next.map((row) => {
      if (!row || typeof row !== "object") return row;
      const projected: Record<string, unknown> = {};
      for (const key of normalized.select!) {
        projected[key] = (row as Record<string, unknown>)[key];
      }
      return projected;
    });
  }

  return next;
}

export function stripPagination(plan?: TableQueryPlan): TableQueryPlan | undefined {
  if (!plan) return undefined;
  const { offset: _offset, limit: _limit, ...rest } = plan;
  return rest;
}
