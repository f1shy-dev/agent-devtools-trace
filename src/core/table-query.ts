import type { TableFilter, TableFilterOp, TableQueryPlan } from "./types.js";

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
  if (op === "in") {
    return { column, op, values: Array.isArray(value) ? value : [value] };
  }
  if (op === "between") {
    if (Array.isArray(value)) {
      return { column, op, lower: value[0], upper: value[1] };
    }
    if (value && typeof value === "object") {
      return {
        column,
        op,
        lower: (value as any).lower,
        upper: (value as any).upper,
      };
    }
  }
  return { column, op, value };
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
  let next = [...rows];

  if (normalized.where && normalized.where.length > 0) {
    next = next.filter((row) => {
      if (!row || typeof row !== "object") return false;
      return normalized.where!.every((filter) =>
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
