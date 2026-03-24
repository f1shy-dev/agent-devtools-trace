import type { DatasetSession, LayerContext, LayerSpec } from "./types.js";

type ReadyState = {
  status: "ready";
  value: unknown;
  buildMs?: number;
  lastAccessedAt: string;
};

type BuildingState = {
  status: "building";
  promise: Promise<unknown>;
  startedAt: string;
  lastAccessedAt: string;
};

type FailedState = {
  status: "failed";
  error: unknown;
  lastAccessedAt: string;
};

type LayerState = ReadyState | BuildingState | FailedState;

export class LayerHost {
  private readonly specs = new Map<string, LayerSpec>();
  private readonly states = new Map<string, LayerState>();

  constructor(private readonly session: DatasetSession) {}

  register<T>(spec: LayerSpec<T>) {
    this.specs.set(spec.key, spec);
  }

  async get<T>(key: string, signal?: AbortSignal): Promise<T> {
    const now = new Date().toISOString();
    const state = this.states.get(key);
    if (state?.status === "ready") {
      state.lastAccessedAt = now;
      return state.value as T;
    }
    if (state?.status === "building") {
      state.lastAccessedAt = now;
      return (await state.promise) as T;
    }
    if (state?.status === "failed") {
      state.lastAccessedAt = now;
      throw state.error;
    }

    const spec = this.specs.get(key);
    if (!spec) {
      throw new Error(`Unknown layer: ${key}`);
    }

    const started = Date.now();
    const promise = this.build(spec, signal, started);
    this.states.set(key, {
      status: "building",
      promise,
      startedAt: now,
      lastAccessedAt: now,
    });

    return (await promise) as T;
  }

  private async build<T>(spec: LayerSpec<T>, signal: AbortSignal | undefined, started: number) {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }

    const ctx: LayerContext = {
      session: this.session,
      signal,
      get: async <U>(key: string) => this.get<U>(key, signal),
    };

    try {
      for (const dep of spec.deps ?? []) {
        await ctx.get(dep);
      }
      const value = await spec.build(ctx);
      this.states.set(spec.key, {
        status: "ready",
        value,
        buildMs: Date.now() - started,
        lastAccessedAt: new Date().toISOString(),
      });
      return value;
    } catch (error) {
      this.states.set(spec.key, {
        status: "failed",
        error,
        lastAccessedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  status() {
    return [...this.specs.keys()].sort().map((key) => {
      const state = this.states.get(key);
      return {
        key,
        status: state?.status ?? "cold",
        buildMs: state?.status === "ready" ? state.buildMs : undefined,
        lastAccessedAt: state?.lastAccessedAt,
      };
    });
  }
}
