import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { create, act, type ReactTestRenderer } from "react-test-renderer";
import { AccountsPage, OverviewPage, SettingsPage } from "./src/pages";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const text = (n: any): string =>
  typeof n === "string"
    ? n
    : Array.isArray(n)
      ? n.map(text).join("")
      : (n?.children ?? []).map(text).join("");
const source = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind: "manual",
  environmentId: "fixture",
  pathLabel: id,
  health: "healthy",
  lastScanAt: new Date().toISOString(),
  errorCount: 0,
  capabilities: {},
  collectionEnabled: true,
  ...extra,
});
async function render(
  sources: ReturnType<typeof source>[],
  settings: boolean | "accounts",
  verify: (r: ReactTestRenderer) => void,
) {
  const original = globalThis.fetch;
  const locationDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  if (settings === "accounts")
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { hash: "#accounts" },
    });
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url === "/api/sources") return Response.json({ sources });
    if (url === "/api/settings")
      return Response.json({
        hooksEnabled: false,
        hooks: { status: "disabled", preview: {}, explanation: "" },
        notifications: { enabled: false },
        pollMs: 1500,
        staleMs: 15000,
        backups: [],
      });
    if (url === "/api/sharing")
      return Response.json({ grants: [], pendingRevocations: [], blocked: [] });
    if (url === "/api/overview")
      return Response.json({
        sources,
        quotas: [],
        scan: { phase: "idle", errors: 0 },
        activity: { items: [] },
        recentCompleted: [],
        todayUsage: { total: 0 },
      });
    if (url === "/api/connections/pending") return Response.json({ items: [] });
    if (url === "/api/quota/sources") return Response.json({ sources: [] });
    throw Error("unexpected fixture request " + url);
  };
  let r!: ReactTestRenderer;
  const props = {
    revision: 0,
    notify: () => {},
    onChanged: () => {},
    onSelect: () => {},
    onNavigate: () => {},
    accounts: null,
  };
  try {
    await act(async () => {
      r = create(
        settings === "accounts" ? (
          <AccountsPage
            {...props}
            sources={sources}
            onEnableCompany={() => {}}
          />
        ) : settings ? (
          <SettingsPage {...props} />
        ) : (
          <OverviewPage {...props} />
        ),
      );
    });
    verify(r);
  } finally {
    if (r) await act(async () => r.unmount());
    globalThis.fetch = original;
    if (settings === "accounts") {
      if (locationDescriptor)
        Object.defineProperty(globalThis, "location", locationDescriptor);
      else Reflect.deleteProperty(globalThis, "location");
    }
  }
}

test("overview excludes preserved historical source errors and scan state from current collection health", async () => {
  await render(
    [
      source("active"),
      source("old-stale", {
        collectionEnabled: false,
        lastScanAt: "2026-01-01T00:00:00Z",
      }),
      source("old-failed", {
        collectionEnabled: false,
        health: "unavailable",
        errorCount: 6,
      }),
      source("old-scanning", { collectionEnabled: false, health: "scanning" }),
    ],
    false,
    (r) => {
      const summary = text(
        r.root.findByProps({ className: "collector-summary " }),
      );
      assert.equal(summary, "采集正常");
      assert.doesNotMatch(
        text(r.toJSON()),
        /old-stale|old-failed|old-scanning|采集已过期|个来源需检查/,
      );
    },
  );
});

test("current unavailable, unknown and stale sources remain visible; no configured source is not healthy", async () => {
  await render(
    [
      source("active-unknown", { health: "unknown", lastScanAt: null }),
      source("active-failed", { health: "unavailable", errorCount: 2 }),
      source("active-stale", { lastScanAt: "2026-01-01T00:00:00Z" }),
    ],
    false,
    (r) => {
      const result = text(r.toJSON());
      assert.match(result, /3 个来源需检查/);
      assert.match(result, /active-unknown：需要检查/);
      assert.match(result, /active-failed：2 个采集问题/);
      assert.match(result, /active-stale：采集已过期/);
    },
  );
  await render(
    [source("history-only", { collectionEnabled: false, health: "scanning" })],
    false,
    (r) => {
      assert.match(text(r.toJSON()), /未启用采集来源/);
      assert.doesNotMatch(text(r.toJSON()), /采集正常|正在读取记录/);
    },
  );
});

test("settings marks history as disabled and only offers stop on configured sources", async () => {
  await render(
    [
      source("active"),
      source("history-only", { collectionEnabled: false, health: "scanning" }),
    ],
    true,
    (r) => {
      const row = r.root
        .findAllByType("tr")
        .find((n) => text(n).includes("history-only"))!;
      assert.match(text(row), /历史来源 · 未启用/);
      assert.doesNotMatch(text(row), /读取中|停止此来源/);
      assert.equal(
        r.root
          .findAllByType("button")
          .filter((n) => text(n).trim() === "停止此来源").length,
        1,
      );
    },
  );
});

test("accounts retains historical sources for attribution while labelling them as disabled", async () => {
  await render(
    [
      source("active"),
      source("history-only", {
        collectionEnabled: false,
        health: "unavailable",
      }),
    ],
    "accounts",
    (r) => {
      const row = r.root
        .findAllByType("tr")
        .find((n) => text(n).includes("history-only"))!;
      assert.match(text(row), /历史来源 · 未启用/);
      assert.doesNotMatch(text(row), /无法访问/);
      assert.equal(
        r.root
          .findAllByType("option")
          .filter((n) => n.props.value === "history-only").length,
        1,
        "historical source stays selectable for account attribution",
      );
    },
  );
});
