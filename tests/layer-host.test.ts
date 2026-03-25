import { describe, expect, it } from "vitest";
import { LayerHost } from "../src/core/layer-host";

describe("LayerHost", () => {
  it("defers size estimation until status inspection and memoizes it", async () => {
    const host = new LayerHost({} as any);
    let serializeCount = 0;
    const value = {
      items: [1, 2, 3],
      toJSON() {
        serializeCount += 1;
        return { items: this.items };
      },
    };

    host.register({
      key: "test/layer",
      build: async () => value,
    });

    const built = await host.get<typeof value>("test/layer");
    expect(built).toBe(value);
    expect(serializeCount).toBe(0);

    const firstStatus = host.status();
    expect(firstStatus.find((row) => row.key === "test/layer")?.sizeBytes).toBeGreaterThan(0);
    expect(serializeCount).toBe(1);

    const secondStatus = host.status();
    expect(secondStatus.find((row) => row.key === "test/layer")?.sizeBytes).toBeGreaterThan(0);
    expect(serializeCount).toBe(1);
  });
});
