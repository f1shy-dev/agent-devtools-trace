export type NumericColumnType = "float64" | "int32" | "uint32";
export type NumericArray = Float64Array | Int32Array | Uint32Array;
export type DictIndexArray = Uint8Array | Uint16Array | Uint32Array;

type NumericColumnSpec = {
  kind: "numeric";
  type: NumericColumnType;
};

type DictColumnSpec = {
  kind: "dict";
};

type StringColumnSpec = {
  kind: "string";
};

type RefColumnSpec = {
  kind: "ref";
};

type StringArrayColumnSpec = {
  kind: "stringArray";
};

type ComputedColumnSpec = {
  kind: "computed";
  resolver: (index: number) => unknown;
};

type ColumnSpec =
  | NumericColumnSpec
  | DictColumnSpec
  | StringColumnSpec
  | RefColumnSpec
  | StringArrayColumnSpec
  | ComputedColumnSpec;

type DictColumnData = {
  dict: string[];
  indices: DictIndexArray;
};

function assertNever(value: never): never {
  throw new Error(`Unsupported column kind: ${String(value)}`);
}

function createNumericArray(type: NumericColumnType, length: number): NumericArray {
  switch (type) {
    case "float64":
      return new Float64Array(length);
    case "int32":
      return new Int32Array(length);
    case "uint32":
      return new Uint32Array(length);
    default:
      return assertNever(type);
  }
}

function createDictIndexArray(size: number, length: number): DictIndexArray {
  if (size <= 0x100) return new Uint8Array(length);
  if (size <= 0x10000) return new Uint16Array(length);
  return new Uint32Array(length);
}

function estimateStringBytes(value: unknown) {
  if (typeof value !== "string") return 0;
  return value.length * 2;
}

function estimateStringArrayBytes(value: unknown) {
  if (!Array.isArray(value)) return 0;
  let total = value.length * 8;
  for (const item of value) {
    total += estimateStringBytes(item);
  }
  return total;
}

export class ColumnarStore<T extends object> {
  private readonly numericColumns = new Map<string, NumericArray>();
  private readonly dictColumns = new Map<string, DictColumnData>();
  private readonly stringColumns = new Map<string, Array<string | undefined>>();
  private readonly refColumns = new Map<string, unknown[]>();
  private readonly stringArrayColumns = new Map<string, unknown[]>();
  private readonly computedColumns = new Map<string, (index: number) => unknown>();
  private readonly columnOrder: string[];

  readonly length: number;

  constructor(args: {
    length: number;
    columnOrder: string[];
    numericColumns?: Map<string, NumericArray>;
    dictColumns?: Map<string, DictColumnData>;
    stringColumns?: Map<string, Array<string | undefined>>;
    refColumns?: Map<string, unknown[]>;
    stringArrayColumns?: Map<string, unknown[]>;
    computedColumns?: Map<string, (index: number) => unknown>;
  }) {
    this.length = args.length;
    this.columnOrder = [...args.columnOrder];
    for (const [key, value] of args.numericColumns ?? []) this.numericColumns.set(key, value);
    for (const [key, value] of args.dictColumns ?? []) this.dictColumns.set(key, value);
    for (const [key, value] of args.stringColumns ?? []) this.stringColumns.set(key, value);
    for (const [key, value] of args.refColumns ?? []) this.refColumns.set(key, value);
    for (const [key, value] of args.stringArrayColumns ?? []) this.stringArrayColumns.set(key, value);
    for (const [key, value] of args.computedColumns ?? []) this.computedColumns.set(key, value);
  }

  columns() {
    return [...this.columnOrder];
  }

  hasColumn(column: string) {
    return this.columnOrder.includes(column);
  }

  getColumnKind(column: string) {
    if (this.numericColumns.has(column)) return "numeric" as const;
    if (this.dictColumns.has(column)) return "dict" as const;
    if (this.stringColumns.has(column)) return "string" as const;
    if (this.refColumns.has(column)) return "ref" as const;
    if (this.stringArrayColumns.has(column)) return "stringArray" as const;
    if (this.computedColumns.has(column)) return "computed" as const;
    return null;
  }

  toRows(start = 0, end = this.length): T[] {
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(this.length, Math.max(safeStart, end));
    const rows: T[] = [];
    for (let index = safeStart; index < safeEnd; index += 1) {
      rows.push(this.getRow(index));
    }
    return rows;
  }

  getRow(index: number): T {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Row index out of bounds: ${index}`);
    }
    const row: Record<string, unknown> = {};
    for (const column of this.columnOrder) {
      row[column] = this.getColumn(column as keyof T, index);
    }
    return row as T;
  }

  getColumn<K extends keyof T>(column: K, index: number): T[K] {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Row index out of bounds: ${index}`);
    }
    const key = String(column);
    const numeric = this.numericColumns.get(key);
    if (numeric) return numeric[index] as T[K];
    const dict = this.dictColumns.get(key);
    if (dict) return dict.dict[dict.indices[index]!] as T[K];
    const strings = this.stringColumns.get(key);
    if (strings) return strings[index] as T[K];
    const refs = this.refColumns.get(key);
    if (refs) return refs[index] as T[K];
    const stringArrays = this.stringArrayColumns.get(key);
    if (stringArrays) return stringArrays[index] as T[K];
    const computed = this.computedColumns.get(key);
    if (computed) return computed(index) as T[K];
    throw new Error(`Column not found: ${key}`);
  }

  getNumericArray(column: string): NumericArray | null {
    return this.numericColumns.get(column) ?? null;
  }

  getDictColumn(column: string): DictColumnData | null {
    return this.dictColumns.get(column) ?? null;
  }

  estimateMemoryBytes() {
    let total = 0;
    for (const column of this.numericColumns.values()) total += column.byteLength;
    for (const column of this.dictColumns.values()) {
      total += column.indices.byteLength;
      total += column.dict.reduce<number>((sum, value) => sum + estimateStringBytes(value), 0);
    }
    for (const column of this.stringColumns.values()) {
      total += column.length * 8;
      total += column.reduce<number>((sum, value) => sum + estimateStringBytes(value), 0);
    }
    for (const column of this.refColumns.values()) {
      total += column.length * 8;
    }
    for (const column of this.stringArrayColumns.values()) {
      total += column.length * 8;
      total += column.reduce<number>((sum, value) => sum + estimateStringArrayBytes(value), 0);
    }
    return total;
  }
}

export class ColumnarStoreBuilder<T extends object> {
  private readonly specs = new Map<string, ColumnSpec>();
  private readonly columnOrder: string[] = [];
  private capacity = 0;
  private length = 0;
  private numericScratch = new Map<string, NumericArray>();
  private dictScratch = new Map<string, Array<string | undefined>>();
  private stringScratch = new Map<string, Array<string | undefined>>();
  private refScratch = new Map<string, unknown[]>();
  private stringArrayScratch = new Map<string, unknown[]>();
  private started = false;

  addNumericColumn(name: string, type: NumericColumnType) {
    this.assertUniqueColumn(name);
    this.specs.set(name, { kind: "numeric", type });
    this.columnOrder.push(name);
    return this;
  }

  addDictColumn(name: string) {
    this.assertUniqueColumn(name);
    this.specs.set(name, { kind: "dict" });
    this.columnOrder.push(name);
    return this;
  }

  addStringColumn(name: string) {
    this.assertUniqueColumn(name);
    this.specs.set(name, { kind: "string" });
    this.columnOrder.push(name);
    return this;
  }

  addRefColumn(name: string) {
    this.assertUniqueColumn(name);
    this.specs.set(name, { kind: "ref" });
    this.columnOrder.push(name);
    return this;
  }

  addStringArrayColumn(name: string) {
    this.assertUniqueColumn(name);
    this.specs.set(name, { kind: "stringArray" });
    this.columnOrder.push(name);
    return this;
  }

  addComputedColumn(name: string, resolver: (index: number) => unknown) {
    this.assertUniqueColumn(name);
    this.specs.set(name, { kind: "computed", resolver });
    this.columnOrder.push(name);
    return this;
  }

  buildFromRows(rows: T[]) {
    this.beginIncremental(rows.length);
    for (const row of rows) this.pushRow(row);
    return this.finalize();
  }

  beginIncremental(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new Error(`Invalid columnar store capacity: ${capacity}`);
    }
    this.capacity = capacity;
    this.length = 0;
    this.numericScratch = new Map();
    this.dictScratch = new Map();
    this.stringScratch = new Map();
    this.refScratch = new Map();
    this.stringArrayScratch = new Map();
    for (const [name, spec] of this.specs.entries()) {
      switch (spec.kind) {
        case "numeric":
          this.numericScratch.set(name, createNumericArray(spec.type, capacity));
          break;
        case "dict":
          this.dictScratch.set(name, new Array<string | undefined>(capacity));
          break;
        case "string":
          this.stringScratch.set(name, new Array<string | undefined>(capacity));
          break;
        case "ref":
          this.refScratch.set(name, new Array<unknown>(capacity));
          break;
        case "stringArray":
          this.stringArrayScratch.set(name, new Array<unknown>(capacity));
          break;
        case "computed":
          break;
        default:
          return assertNever(spec);
      }
    }
    this.started = true;
    return this;
  }

  pushRow(row: T) {
    if (!this.started) {
      throw new Error("beginIncremental() must be called before pushRow()");
    }
    if (this.length >= this.capacity) {
      throw new Error(`Columnar store capacity exceeded: ${this.capacity}`);
    }
    const index = this.length;
    for (const [name, spec] of this.specs.entries()) {
      const record = row as Record<string, unknown>;
      switch (spec.kind) {
        case "numeric": {
          const array = this.numericScratch.get(name)!;
          const value = record[name];
          array[index] = typeof value === "number" ? value : Number.NaN;
          break;
        }
        case "dict":
          this.dictScratch.get(name)![index] = record[name] as string | undefined;
          break;
        case "string":
          this.stringScratch.get(name)![index] = record[name] as string | undefined;
          break;
        case "ref":
          this.refScratch.get(name)![index] = record[name];
          break;
        case "stringArray":
          this.stringArrayScratch.get(name)![index] = record[name];
          break;
        case "computed":
          break;
        default:
          return assertNever(spec);
      }
    }
    this.length += 1;
    return this;
  }

  finalize() {
    if (!this.started) {
      throw new Error("beginIncremental() must be called before finalize()");
    }
    const numericColumns = new Map<string, NumericArray>();
    const dictColumns = new Map<string, DictColumnData>();
    const stringColumns = new Map<string, Array<string | undefined>>();
    const refColumns = new Map<string, unknown[]>();
    const stringArrayColumns = new Map<string, unknown[]>();
    const computedColumns = new Map<string, (index: number) => unknown>();

    for (const [name, spec] of this.specs.entries()) {
      switch (spec.kind) {
        case "numeric": {
          const array = this.numericScratch.get(name)!;
          numericColumns.set(name, array.subarray(0, this.length) as NumericArray);
          break;
        }
        case "dict": {
          const values = this.dictScratch.get(name)!.slice(0, this.length);
          const dict: string[] = [];
          const dictIndexByValue = new Map<string, number>();
          for (const value of values) {
            const normalized = value ?? "";
            if (!dictIndexByValue.has(normalized)) {
              dictIndexByValue.set(normalized, dict.length);
              dict.push(normalized);
            }
          }
          const indices = createDictIndexArray(dict.length, values.length);
          for (let index = 0; index < values.length; index += 1) {
            indices[index] = dictIndexByValue.get(values[index] ?? "") ?? 0;
          }
          dictColumns.set(name, { dict, indices });
          break;
        }
        case "string":
          stringColumns.set(name, this.stringScratch.get(name)!.slice(0, this.length));
          break;
        case "ref":
          refColumns.set(name, this.refScratch.get(name)!.slice(0, this.length));
          break;
        case "stringArray":
          stringArrayColumns.set(name, this.stringArrayScratch.get(name)!.slice(0, this.length));
          break;
        case "computed":
          computedColumns.set(name, spec.resolver);
          break;
        default:
          return assertNever(spec);
      }
    }

    this.started = false;

    return new ColumnarStore<T>({
      length: this.length,
      columnOrder: this.columnOrder,
      numericColumns,
      dictColumns,
      stringColumns,
      refColumns,
      stringArrayColumns,
      computedColumns,
    });
  }

  private assertUniqueColumn(name: string) {
    if (this.specs.has(name)) {
      throw new Error(`Column already defined: ${name}`);
    }
  }
}
