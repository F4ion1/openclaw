import { describe, expect, it, vi } from "vitest";
import {
  clearNodePendingWork,
  drainNodePendingWork,
  enqueueNodePendingWork,
  removeNodePendingWorkItem,
} from "./node-pending-work.js";

function enqueue(
  nodeId: string,
  overrides: Partial<Parameters<typeof enqueueNodePendingWork>[0]> = {},
) {
  return enqueueNodePendingWork({ nodeId, type: "location.request", ...overrides });
}

const itemTypes = (result: ReturnType<typeof drainNodePendingWork>) =>
  result.items.map((item) => item.type);
const itemIds = (result: ReturnType<typeof drainNodePendingWork>) =>
  result.items.map((item) => item.id);

describe("node pending work", () => {
  it("dedupes explicit work by type until the node drains it", () => {
    const first = enqueue("node-2");
    const second = enqueue("node-2");

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.item.id).toBe(first.item.id);

    const drained = drainNodePendingWork("node-2");
    expect(itemTypes(drained)).toEqual(["location.request", "status.request"]);

    const afterDrain = enqueue("node-2");
    expect(afterDrain.deduped).toBe(false);
    expect(afterDrain.item.id).not.toBe(first.item.id);
    drainNodePendingWork("node-2");
  });

  it("clears explicit work when a pairing is removed", () => {
    enqueue("node-removed");

    expect(clearNodePendingWork(" node-removed ")).toBe(true);
    expect(itemIds(drainNodePendingWork("node-removed"))).toEqual(["baseline-status"]);
    expect(clearNodePendingWork("node-removed")).toBe(false);
  });

  it("keeps explicit work isolated from a replacement pairing generation", () => {
    const nodeId = "node-replaced";
    const oldGeneration = { pairingGeneration: "generation-1" };
    const newGeneration = { pairingGeneration: "generation-2" };
    enqueue(nodeId, oldGeneration);

    const drained = drainNodePendingWork(nodeId, newGeneration);

    expect(itemIds(drained)).toEqual(["baseline-status"]);
    expect(itemTypes(drainNodePendingWork(nodeId, oldGeneration))).toEqual([
      "location.request",
      "status.request",
    ]);

    const retired = enqueue(nodeId, oldGeneration);
    const replacement = enqueue(nodeId, newGeneration);
    expect(
      drainNodePendingWork(nodeId, { ...oldGeneration, includeDefaultStatus: false }).items,
    ).toEqual([]);
    expect(clearNodePendingWork(nodeId, oldGeneration.pairingGeneration)).toBe(false);
    expect(
      removeNodePendingWorkItem({
        nodeId,
        itemId: retired.item.id,
        ...oldGeneration,
      }),
    ).toBe(false);
    expect(
      itemIds(drainNodePendingWork(nodeId, { ...newGeneration, includeDefaultStatus: false })),
    ).toEqual([replacement.item.id]);
  });

  it("expires queued work when a different pairing polls", () => {
    enqueue("node-retired-generation", {
      expiresInMs: 1_000,
      pairingGeneration: "generation-1",
    });

    drainNodePendingWork("node-retired-generation", {
      pairingGeneration: "generation-2",
      nowMs: Date.now() + 2_000,
    });

    expect(clearNodePendingWork("node-retired-generation", "generation-1")).toBe(false);
  });

  it("rolls back only the exact item owned by one enqueue", () => {
    const nodeId = "node-item-rollback";
    const pairingGeneration = "generation-1";
    const location = enqueue(nodeId, { pairingGeneration });
    enqueue(nodeId, { type: "status.request", pairingGeneration });

    expect(
      removeNodePendingWorkItem({
        nodeId,
        itemId: location.item.id,
        pairingGeneration,
      }),
    ).toBe(true);
    expect(
      itemTypes(
        drainNodePendingWork(nodeId, {
          pairingGeneration,
          includeDefaultStatus: false,
        }),
      ),
    ).toEqual(["status.request"]);
  });

  it("keeps hasMore true when the baseline status item is deferred by maxItems", () => {
    enqueue("node-3");

    const drained = drainNodePendingWork("node-3", { maxItems: 1 });

    expect(itemTypes(drained)).toEqual(["location.request"]);
    expect(drained.hasMore).toBe(true);

    const next = drainNodePendingWork("node-3", { maxItems: 1 });
    expect(itemIds(next)).toEqual(["baseline-status"]);
    expect(next.hasMore).toBe(false);
  });

  it("keeps explicit work queued when maxItems defers it", () => {
    enqueue("node-4", { type: "status.request", priority: "normal" });
    enqueue("node-4", { priority: "high" });

    const firstDrain = drainNodePendingWork("node-4", { maxItems: 1 });
    expect(itemTypes(firstDrain)).toEqual(["location.request"]);
    expect(firstDrain.hasMore).toBe(true);

    const secondDrain = drainNodePendingWork("node-4", { maxItems: 1 });
    expect(itemTypes(secondDrain)).toEqual(["status.request"]);
    expect(itemIds(secondDrain)).not.toEqual(["baseline-status"]);
    expect(secondDrain.hasMore).toBe(false);
  });

  it("assigns default expiry to queued work without explicit ttl", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const expiresAtMs = 1_000 + 24 * 60 * 60_000;
    try {
      expect(enqueue("node-default-expiry").item.expiresAtMs).toBe(expiresAtMs);
    } finally {
      dateNow.mockRestore();
    }

    const drained = drainNodePendingWork("node-default-expiry", { nowMs: expiresAtMs });
    expect(itemIds(drained)).toEqual(["baseline-status"]);
  });
});
