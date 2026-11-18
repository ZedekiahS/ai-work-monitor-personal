import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentPage } from "./src/environment";
import type { Source } from "./src/api";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const source = (id: string): Source => ({
  id,
  label: id,
  kind: "manual",
  environmentId: id,
  pathLabel: id,
  health: "unknown",
  lastScanAt: null,
  errorCount: 0,
  capabilities: {},
});
const report = (id: string, version: string) =>
  Response.json({
    sourceId: id,
    checkedAt: "2026-01-01",
    latest: null,
    directory: "readable",
    sessions: "found",
    archived: "missing",
    cli: { status: "available", version },
    hooks: { status: "off" },
  });

test("source checks run on demand and a late result cannot replace a different source", async (t) => {
  const requested: string[] = [];
  let finish!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/environment/source-check");
    const id = JSON.parse(init.body).sourceId;
    requested.push(id);
    return id === "A"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : report(id, "B-version");
  });
  let r!: ReactTestRenderer;
  let returned = 0;
  await act(async () => {
    r = create(
      <EnvironmentPage
        initialSourceId="A"
        sources={[source("A"), source("B")]}
        onSourceSettings={() => {}}
        onReturn={() => {
          returned++;
        }}
      />,
    );
  });
  t.after(() => act(() => r.unmount()));
  const button = (name: string) =>
    r.root.findAllByType("button").find((b) => b.children.includes(name))!;
  assert.deepEqual(requested, []);
  await act(async () => {
    void button("检查来源").props.onClick();
  });
  await act(() =>
    r.root.findByType("select").props.onChange({ target: { value: "B" } }),
  );
  await act(async () => {
    await button("检查来源").props.onClick();
  });
  await act(async () => {
    finish(report("A", "A-version"));
  });
  assert.deepEqual(requested, ["A", "B"]);
  assert.match(JSON.stringify(r.toJSON()), /B-version/);
  assert.doesNotMatch(JSON.stringify(r.toJSON()), /A-version/);
  await act(() => button("返回 Monitor 任务").props.onClick());
  assert.equal(returned, 1);
});

test("without active sources the local check reads only CLI and Hooks on demand", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/environment/source-check");
    assert.deepEqual(JSON.parse(init.body), {});
    calls++;
    return Response.json({
      sourceId: null,
      checkedAt: "2026-01-01",
      cli: { status: "available", version: "0.117.2" },
      hooks: { status: "off", lastEvent: null },
    });
  });
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      <EnvironmentPage
        sources={[{ ...source("old"), collectionEnabled: false }]}
        initialSourceId="old"
        onSourceSettings={() => {}}
      />,
    );
  });
  t.after(() => act(() => r.unmount()));
  assert.equal(calls, 0);
  const button = r.root
    .findAllByType("button")
    .find((b) => b.children.includes("检查本机"))!;
  await act(async () => {
    await button.props.onClick();
  });
  assert.equal(calls, 1);
  const text = JSON.stringify(r.toJSON());
  assert.match(text, /0\.117\.2/);
  assert.match(text, /本机 Monitor Hooks/);
  assert.doesNotMatch(text, /Monitor 最近收录的会话活动/);
});
