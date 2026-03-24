import { pretty as prettyValue, table as tableValue } from "./presentation.js";
import { mergeQueryPlans, normalizeFilter } from "./table-query.js";
import type {
  PrettyOptions,
  ReportQueryHandle,
  TableFilter,
  TableFilterOp,
  TableQueryHandle,
  TableQueryPlan,
  DatasetSession,
} from "./types.js";

class RuntimeTableQueryHandle implements TableQueryHandle {
  constructor(
    private readonly session: DatasetSession,
    private readonly tableName: string,
    private readonly currentPlan: TableQueryPlan = {},
  ) {}

  plan() {
    return { ...this.currentPlan };
  }

  query(plan: TableQueryPlan) {
    return new RuntimeTableQueryHandle(
      this.session,
      this.tableName,
      mergeQueryPlans(this.currentPlan, plan),
    );
  }

  select(columns: string[]) {
    return this.query({ select: columns });
  }

  where(filterOrColumn: TableFilter | string, op?: TableFilterOp, value?: unknown) {
    const filter =
      typeof filterOrColumn === "string"
        ? normalizeFilter(filterOrColumn, op ?? "=", value)
        : filterOrColumn;
    return this.query({ where: [filter] });
  }

  orderBy(column: string, direction?: "asc" | "desc") {
    return this.query({ orderBy: [{ column, direction }] });
  }

  limit(limit: number) {
    return this.query({ limit });
  }

  offset(offset: number) {
    return this.query({ offset });
  }

  rows(plan?: TableQueryPlan) {
    return this.session.queryTable(this.tableName, mergeQueryPlans(this.currentPlan, plan));
  }

  async first() {
    return (await this.rows({ limit: 1 }))[0] ?? null;
  }

  count() {
    return this.session.countTable(this.tableName, this.currentPlan);
  }

  async pretty(options?: PrettyOptions) {
    return this.session.prettyTable(this.tableName, this.currentPlan, options);
  }

  async table(options?: PrettyOptions) {
    const rows = await this.rows();
    return tableValue(rows, { maxRows: options?.maxRows });
  }
}

class RuntimeReportQueryHandle implements ReportQueryHandle {
  constructor(
    private readonly session: DatasetSession,
    private readonly reportName: string,
    private readonly boundArgs: Record<string, unknown> = {},
  ) {}

  args(args: Record<string, unknown>) {
    return new RuntimeReportQueryHandle(this.session, this.reportName, {
      ...this.boundArgs,
      ...args,
    });
  }

  run(args?: Record<string, unknown>) {
    const report = this.session.getReport(this.reportName);
    if (!report) {
      throw new Error(`Report not found: ${this.reportName}`);
    }
    return report.run(this.session, { ...this.boundArgs, ...(args ?? {}) });
  }

  async pretty(args?: Record<string, unknown>) {
    return this.session.prettyReport(this.reportName, { ...this.boundArgs, ...(args ?? {}) });
  }
}

export function createTableQueryHandle(session: DatasetSession, tableName: string) {
  return new RuntimeTableQueryHandle(session, tableName);
}

export function createReportQueryHandle(session: DatasetSession, reportName: string) {
  return new RuntimeReportQueryHandle(session, reportName);
}

export function prettyArbitraryValue(value: unknown, options?: PrettyOptions) {
  return prettyValue(value, options);
}

export function tableArbitraryValue(value: unknown, options?: PrettyOptions) {
  return tableValue(value, { maxRows: options?.maxRows });
}
