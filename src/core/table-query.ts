import { ColumnarStore } from "./columnar-store.js";
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

export function compareValues(left: unknown, right: unknown) {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

export function matchesFilter(value: unknown, filter: TableFilter) {
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

export function normalizePlanFilter(filter: TableFilter): TableFilter {
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

function validatePlanColumns(rows: unknown[], where: TableFilter[] | undefined) {
  if (!where || where.length === 0 || rows.length === 0) return;
  const firstRow = rows[0];
  if (!firstRow || typeof firstRow !== "object") return;
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

export function applyTablePlan(rows: unknown[], plan?: TableQueryPlan) {
  const normalized = plan ?? {};
  const where = normalized.where?.map(normalizePlanFilter);
  let next = [...rows];

  validatePlanColumns(next, where);

  if (where && where.length > 0) {
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

function validateColumnarPlan<T extends object>(
  store: ColumnarStore<T>,
  where: TableFilter[] | undefined,
) {
  if (!where || where.length === 0) return;
  const availableColumns = store.columns();
  const available = new Set(availableColumns);
  for (const filter of where) {
    if (!available.has(filter.column)) {
      throw new Error(
        `Column '${filter.column}' not found. Available columns: ${availableColumns
          .slice(0, 10)
          .join(", ")}`,
      );
    }
  }
}

function filterIndices<T extends object>(
  store: ColumnarStore<T>,
  filter: TableFilter,
  sourceIndices?: number[],
) {
  const kind = store.getColumnKind(filter.column);
  const indices: number[] = [];
  if (kind === "numeric") {
    const values = store.getNumericArray(filter.column)!;
    const visit = sourceIndices ?? Array.from({ length: store.length }, (_, index) => index);
    for (const index of visit) {
      if (matchesFilter(values[index], filter)) indices.push(index);
    }
    return indices;
  }
  if (kind === "dict") {
    const dictColumn = store.getDictColumn(filter.column)!;
    const visit = sourceIndices ?? Array.from({ length: store.length }, (_, index) => index);
    if (filter.op === "=" || filter.op === "!=") {
      const target = dictColumn.dict.indexOf(String(filter.value ?? ""));
      for (const index of visit) {
        const isMatch = target >= 0 && dictColumn.indices[index] === target;
        if ((filter.op === "=" && isMatch) || (filter.op === "!=" && !isMatch)) {
          indices.push(index);
        }
      }
      return indices;
    }
    if (filter.op === "in" && Array.isArray(filter.values)) {
      const targets = new Set(
        filter.values.map((value) => dictColumn.dict.indexOf(String(value ?? ""))).filter((v) => v >= 0),
      );
      for (const index of visit) {
        if (targets.has(dictColumn.indices[index]!)) indices.push(index);
      }
      return indices;
    }
    for (const index of visit) {
      if (matchesFilter(dictColumn.dict[dictColumn.indices[index]!], filter)) indices.push(index);
    }
    return indices;
  }
  const visit = sourceIndices ?? Array.from({ length: store.length }, (_, index) => index);
  for (const index of visit) {
    if (matchesFilter(store.getColumn(filter.column as keyof T, index), filter)) {
      indices.push(index);
    }
  }
  return indices;
}

function sortIndices<T extends object>(
  store: ColumnarStore<T>,
  indices: number[],
  plan: TableQueryPlan,
) {
  if (!plan.orderBy || plan.orderBy.length === 0 || indices.length <= 1) return indices;
  const orderBy = plan.orderBy;
  indices.sort((leftIndex, rightIndex) => {
    for (const clause of orderBy) {
      const direction = normalizeDirection(clause.direction);
      const numeric = store.getNumericArray(clause.column);
      const dict = numeric ? null : store.getDictColumn(clause.column);
      const leftValue = numeric
        ? numeric[leftIndex]
        : dict
          ? dict.dict[dict.indices[leftIndex]!]
          : store.getColumn(clause.column as keyof T, leftIndex);
      const rightValue = numeric
        ? numeric[rightIndex]
        : dict
          ? dict.dict[dict.indices[rightIndex]!]
          : store.getColumn(clause.column as keyof T, rightIndex);
      const cmp = compareValues(leftValue, rightValue);
      if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
  return indices;
}

function paginateIndices(indices: number[], plan: TableQueryPlan) {
  let next = indices;
  if (typeof plan.offset === "number" && plan.offset > 0) {
    next = next.slice(plan.offset);
  }
  if (typeof plan.limit === "number" && plan.limit >= 0) {
    next = next.slice(0, plan.limit);
  }
  return next;
}

function materializeIndices<T extends object>(
  store: ColumnarStore<T>,
  indices: number[],
  select?: string[],
) {
  if (!select || select.length === 0) {
    return indices.map((index) => store.getRow(index));
  }
  return indices.map((index) => {
    const row: Record<string, unknown> = {};
    for (const column of select) {
      row[column] = store.getColumn(column as keyof T, index);
    }
    return row;
  });
}

function columnarIndicesForPlan<T extends object>(
  store: ColumnarStore<T>,
  plan?: TableQueryPlan,
) {
  const normalized = plan ?? {};
  const where = normalized.where?.map(normalizePlanFilter);
  validateColumnarPlan(store, where);
  let indices: number[] | undefined;
  if (where && where.length > 0) {
    for (const filter of where) {
      indices = filterIndices(store, filter, indices);
      if (indices.length === 0) break;
    }
  }
  const next = indices ?? Array.from({ length: store.length }, (_, index) => index);
  return paginateIndices(sortIndices(store, next, normalized), normalized);
}

export function columnarApplyPlan<T extends object>(
  store: ColumnarStore<T>,
  plan?: TableQueryPlan,
) {
  const normalized = plan ?? {};
  return materializeIndices(store, columnarIndicesForPlan(store, normalized), normalized.select);
}

export function columnarCount<T extends object>(
  store: ColumnarStore<T>,
  plan?: TableQueryPlan,
) {
  return columnarIndicesForPlan(store, plan).length;
}

export function stripPagination(plan?: TableQueryPlan): TableQueryPlan | undefined {
  if (!plan) return undefined;
  const { offset: _offset, limit: _limit, ...rest } = plan;
  return rest;
}
