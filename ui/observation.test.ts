import test from "node:test";
import assert from "node:assert/strict";
import {
  forestFor,
  sessionForView,
  quotaWindow,
  historyForDetail,
  quotasForOverview,
  quotaRemaining,
} from "./src/observation.ts";
import type { Session } from "./src/api.ts";
const s = (
  id: string,
  parentId: string | null = null,
  relation: "fork" | "spawn" | null = null,
): Session => ({
  id,
  parentId,
  relation,
  title: id,
  project: "p",
  model: "m",
  sourceId: "s",
  accountId: null,
  startedAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:01Z",
  turnId: "t",
  state: "running",
  lastState: "running",
  freshness: "fresh",
  evidence: "confirmed",
  totalTokens: 0,
  notes: "",
  pinned: false,
  jumpUrl: null,
});
test("observer disconnect hides cached current activity but preserves last evidence", () => {
  const old = s("main");
  const view = sessionForView(old, true);
  assert.equal(view.state, "unknown");
  assert.equal(view.lastState, "running");
  assert.equal(view.freshness, "unavailable");
  assert.equal(old.state, "running");
  assert.equal(
    sessionForView({ ...old, state: "completed" }, true).state,
    "completed",
  );
});
test("child-first and deep descendants remain attached regardless of renderer collapse", () => {
  const f = forestFor([
    s("grandchild", "child", "spawn"),
    s("child", "main", "spawn"),
    s("main"),
  ]);
  assert.deepEqual(
    f.roots.map((s) => s.id),
    ["main"],
  );
  assert.deepEqual(
    f.children.get("main")?.map((s) => s.id),
    ["child"],
  );
  assert.deepEqual(
    f.children.get("child")?.map((s) => s.id),
    ["grandchild"],
  );
});
test("fork is separate, missing-parent orphan is visible, cycles are bounded", () => {
  const f = forestFor([
    s("a", "b", "spawn"),
    s("b", "a", "spawn"),
    s("fork", "a", "fork"),
    s("orphan", "missing", "spawn"),
  ]);
  assert.equal(f.roots.length, 3);
  assert(f.roots.some((s) => s.id === "fork"));
  assert(f.roots.some((s) => s.id === "orphan"));
});
test("provider window duration is dynamic, not hardcoded quota types", () => {
  assert.equal(quotaWindow("10080"), "7 天窗口");
  assert.equal(quotaWindow("300"), "5 小时窗口");
  assert.equal(quotaWindow("17"), "17 分钟窗口");
  assert.equal(quotaWindow("custom"), "custom");
});

test("metadata-only history cannot display an invented zero or cached token total", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { SessionTable } = await import("./src/sessions.tsx");
  for (const record of [
    {
      ...s("legacy"),
      metadataOnly: true,
      usageAvailable: false,
      totalTokens: null,
    },
    { ...s("legacy"), metadataOnly: true, totalTokens: 777777 },
  ]) {
    const html = renderToStaticMarkup(
      createElement(SessionTable, { sessions: [record], onSelect: () => {} }),
    );
    assert.match(html, /Token 未知/);
    assert.match(html, />未知<\/td>/);
    assert.doesNotMatch(html, /777,777|777.8K/);
  }
});

test("metadata-only index can replay source history while preserving opaque pagination cursor", () => {
  const detail = {
    session: {
      ...s("old"),
      metadataOnly: true,
      totalTokens: null,
      usageAvailable: false,
    },
    historyAvailable: true,
    nextBefore: "db:1700000000000:25",
    events: [],
    agents: [],
    usage: null,
    notes: "",
    pinned: false,
  };
  assert.deepEqual(historyForDetail(detail), {
    available: true,
    nextBefore: "db:1700000000000:25",
  });
  assert.deepEqual(historyForDetail({ ...detail, nextBefore: null }), {
    available: true,
    nextBefore: null,
  });
  assert.deepEqual(historyForDetail({ ...detail, historyAvailable: false }), {
    available: false,
    nextBefore: null,
  });
  assert.equal(detail.usage, null);
});

test("full export traverses more than 1000 records and continues past empty revoked pages", async () => {
  const { collectExport } = await import("./src/exports.ts");
  let calls = 0;
  const out = await collectExport<{ id: number }>(async (cursor) => {
    const page = cursor === null ? 0 : Number(cursor);
    calls++;
    return {
      items:
        page === 3
          ? []
          : Array.from({ length: page === 11 ? 5 : 100 }, (_, i) => ({
              id: page * 100 + i,
            })),
      nextCursor: page === 11 ? null : String(page + 1),
      snapshotAt: "2026-10-26T00:00:00Z",
      snapshotCount: 1105,
    };
  });
  assert.equal(calls, 12);
  assert.equal(out.count, 1005);
  assert.equal(new Set(out.items.map((i) => i.id)).size, 1005);
  assert.equal(out.snapshotAt, "2026-10-26T00:00:00Z");
});
test("full export rejects repeated cursors, old one-page APIs, and a changed permission scope", async () => {
  const { collectExport } = await import("./src/exports.ts");
  await assert.rejects(
    collectExport(async () => ({
      items: [],
      nextCursor: "same",
      snapshotAt: "t",
    })),
    /游标重复/,
  );
  await assert.rejects(
    collectExport(async () => ({ items: [] }) as any),
    /未提供完整导出游标/,
  );
  let valid = true;
  await assert.rejects(
    collectExport(
      async () => {
        valid = false;
        return { items: [1], nextCursor: null, snapshotAt: "t" };
      },
      () => valid,
    ),
    /范围已切换/,
  );
});
test("unknown and stale quota cards remain explicit without zero or raw pool clutter", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QuotaCard } = await import("./src/components.tsx");
  const html = renderToStaticMarkup(
    createElement(QuotaCard, {
      quota: {
        id: "x",
        accountId: "unknown:x",
        sourceId: "s",
        pool: "internal_pool",
        window: "300",
        remainingPercent: null,
        resetsAt: null,
        observedAt: "2026-10-26T00:00:00Z",
        freshness: "stale",
        unbound: true,
      },
      compactView: true,
    }),
  );
  assert.match(html, /未知/);
  assert.match(html, /已过期/);
  assert.match(html, /账号待确认/);
  assert.doesNotMatch(html, /0%/);
  assert.match(html, /<details/);
});
test("expired quota does not advertise its old percentage as available balance", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QuotaCard } = await import("./src/components.tsx");
  const html = renderToStaticMarkup(
    createElement(QuotaCard, {
      quota: {
        id: "old",
        accountId: null,
        sourceId: "log",
        pool: "codex",
        window: "300",
        remainingPercent: 100,
        resetsAt: "2020-01-01T00:00:00Z",
        observedAt: "2019-12-31T00:00:00Z",
        freshness: "stale",
      },
    }),
  );
  const visible = html.split("<details")[0];
  assert.doesNotMatch(visible, /100%/);
  assert.match(visible, /未知/);
  assert.doesNotMatch(visible, /class="meter"/);
});
test("overview prefers latest valid observations without merging accounts or dropping history", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const base = {
    accountId: null,
    pool: "codex",
    window: "10080",
    remainingPercent: 9,
    resetsAt: "2026-11-01T12:00:00Z",
    freshness: "fresh",
  };
  const older = {
    ...base,
    id: "log",
    sourceId: "log",
    observedAt: "2026-10-27T11:59:00Z",
  };
  const latest = {
    ...base,
    id: "rpc",
    sourceId: "quota-probe:local",
    observedAt: "2026-10-27T11:59:50Z",
  };
  const expired = {
    ...older,
    id: "expired",
    window: "300",
    remainingPercent: 100,
    resetsAt: "2026-10-26T12:00:00Z",
  };
  const boundA = { ...latest, id: "a", accountId: "a" };
  const boundB = { ...latest, id: "b", accountId: "b" };
  const stale = { ...latest, id: "stale", window: "300", freshness: "stale" };
  const input = [older, expired, latest, boundA, boundB, stale];
  const result = quotasForOverview(input, now);
  assert.deepEqual(result.current.map((q) => q.id).sort(), ["a", "b", "rpc"]);
  assert.deepEqual(result.other.map((q) => q.id).sort(), [
    "expired",
    "log",
    "stale",
  ]);
  assert.equal(input.length, 6);
  assert.equal(latest.accountId, null);
  assert.equal(quotasForOverview([older], now).current[0].id, "log");
});
test("CSV exporter preserves data values and quotes formula-like metadata", async () => {
  const { exportCsv } = await import("./src/exports.ts");
  const csv = exportCsv([
    { id: "a", model: "=IMPORTXML(x)", total: 0 },
    { id: "b", model: 'a,"b', total: null },
  ]);
  assert.match(csv, /"'=IMPORTXML/);
  assert.match(csv, /"a,""b"/);
  assert.match(csv, /"0"/);
});

test("current quota values disappear on expiry, stale observations and failed reads", () => {
  const now = Date.parse("2026-10-28T00:00:00Z");
  const quota = {
    id: "q",
    accountId: "a",
    sourceId: "s",
    pool: "codex",
    window: "300",
    remainingPercent: 0,
    resetsAt: "2026-10-28T01:00:00Z",
    observedAt: "2026-10-28T00:00:00Z",
    freshness: "fresh",
  };
  assert.equal(quotaRemaining(quota, false, now), 0);
  assert.equal(
    quotaRemaining(
      { ...quota, remainingPercent: 100, resetsAt: "2026-10-27T00:00:00Z" },
      false,
      now,
    ),
    null,
  );
  assert.equal(
    quotaRemaining({ ...quota, freshness: "stale" }, false, now),
    null,
  );
  assert.equal(quotaRemaining(quota, true, now), null);
});

test("finished task badges retain their outcome without a misleading expiry warning", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { StateBadge } = await import("./src/components.tsx");
  for (const state of ["completed", "failed", "cancelled"] as const) {
    const html = renderToStaticMarkup(
      createElement(StateBadge, {
        session: { ...s("done"), state, freshness: "stale" },
      }),
    );
    assert.doesNotMatch(html.replace(/title="[^"]*"/g, ""), /过期/);
  }
  const unknown = renderToStaticMarkup(
    createElement(StateBadge, {
      session: { ...s("old"), state: "unknown", freshness: "stale" },
    }),
  );
  assert.match(unknown, /待确认/);
});
