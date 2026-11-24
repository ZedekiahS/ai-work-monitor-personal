import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import type { Source } from "./src/api";
import { EnvironmentPage } from "./src/environment";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

function textOf(element: ReactTestInstance): string {
  return element.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

function button(renderer: ReactTestRenderer, name: string) {
  return renderer.root
    .findAllByType("button")
    .find((element) => textOf(element).trim() === name)!;
}

test("opened files without indexed sessions and errors on this PC have separate, actionable results", async (t) => {
  const source: Source = {
    id: "chosen",
    label: "笔记本历史",
    kind: "manual",
    environmentId: "B",
    pathLabel: "B",
    health: "unknown",
    lastScanAt: null,
    errorCount: 0,
    capabilities: {},
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/environment/source-check");
    assert.deepEqual(JSON.parse(init.body), { sourceId: source.id });
    return Response.json({
      sourceId: source.id,
      checkedAt: "2026-11-19T10:00:00Z",
      latest: null,
      directory: "readable",
      sessions: "found",
      archived: "missing",
      cli: { status: "unrecognized", version: null },
      hooks: { status: "off", lastEvent: null },
    });
  });
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      <EnvironmentPage
        sources={[source]}
        initialSourceId={source.id}
        onSourceSettings={() => {}}
      />,
    );
  });
  t.after(() => act(() => r.unmount()));
  await act(async () => {
    await button(r, "检查来源").props.onClick();
  });
  const selected = textOf(r.root.findByProps({ "aria-label": "所选来源" }));
  const machine = textOf(r.root.findByProps({ "aria-label": "本机运行环境" }));
  assert.match(selected, /可打开的会话日志文件/);
  assert.match(selected, /暂无此来源的会话记录.*重新扫描来源/);
  assert.doesNotMatch(selected, /CLI|Hooks/);
  assert.match(machine, /版本号无法识别.*codex --version/);
  assert.doesNotMatch(machine, /会话日志/);
});

test("manual Codex diagnostics give next steps for findings and distinct failure states", async (t) => {
  let response: unknown;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "/api/environment/codex-doctor");
    calls++;
    return Response.json(response);
  });
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      <EnvironmentPage
        sources={[]}
        initialSourceId=""
        onSourceSettings={() => {}}
      />,
    );
  });
  t.after(() => act(() => r.unmount()));
  assert.equal(calls, 0);
  const diagnose = () =>
    act(async () => {
      await button(r, "运行 Codex 诊断").props.onClick();
    });
  response = {
    state: "complete",
    overall: "fail",
    counts: { ok: 2, warning: 1, fail: 2 },
    attention: ["网络", "登录", "其他检查"],
  };
  await diagnose();
  const steps = r.root
    .findByProps({ "aria-label": "建议操作" })
    .findAllByType("li")
    .map(textOf);
  assert.equal(steps.length, 3);
  assert.match(steps[0], /网络.*代理设置/);
  assert.match(steps[1], /登录.*确认当前账号已登录/);
  assert.match(steps[2], /其他检查.*codex doctor/);
  for (const [state, expected] of [
    ["missing", /找不到 codex 命令.*codex --version/],
    ["unsupported", /JSON 诊断.*更新 Codex CLI/],
    ["timeout", /超时.*再运行诊断/],
    ["failed", /命令执行失败.*codex doctor/],
    ["incompatible_report", /无法识别.*诊断报告.*codex doctor/],
  ] as const) {
    response = { state };
    await diagnose();
    assert.match(textOf(r.root.findByProps({ role: "status" })), expected);
  }
});
