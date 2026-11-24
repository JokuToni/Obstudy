import { test, expect } from "@playwright/test";
import { syncBatch } from "../../src/lib/cloud/batch";

test("sync batches respect both request bytes and count without changing IDs or skipping a large first item", () => {
    const items = [
        { id: "first", text: "ä".repeat(30) },
        { id: "second", text: "a".repeat(30) },
        { id: "third", text: "last" },
    ];
    expect(syncBatch(items, 500, 100).map((item) => item.id)).toEqual([
        "first",
    ]);
    expect(syncBatch(items.slice(1), 500, 100).map((item) => item.id)).toEqual([
        "second",
        "third",
    ]);
    expect(syncBatch(items, 1, 10000).map((item) => item.id)).toEqual([
        "first",
    ]);
    expect(syncBatch(items, 500, 10)).toEqual([items[0]]);
    expect(syncBatch([])).toEqual([]);
});
