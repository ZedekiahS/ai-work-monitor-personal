import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { create, act } from "react-test-renderer";
import {
  WidgetView,
  latestWidgetQuotas,
  widgetQuotaKey,
  resetCountdown,
  QuotaOrb,
} from "./src/widget";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const flatten = (n: any): string =>
  typeof n === "string"
    ? n
    : Array.isArray(n)
      ? n.map(flatten).join("")
      : (n?.children ?? []).map(flatten).join("");
const quota = (sourceId: string, extra: any = {}) => ({
  id: sourceId,
  sourceId,
  accountId: null,
  unbound: true,
  pool: "pool",
  window: "300",
  remainingPercent: 0,
  resetsAt: null,
  freshness: "fresh",
  observedAt: "2026-11-12T01:00:00Z",
  ...extra,
});
test("unknown sources stay separate; confirmed same-account multi-device observations are not added", () => {
  const qs = latestWidgetQuotas([
    quota("a"),
    quota("b"),
    quota("a", { id: "a-new", observedAt: "2026-11-12T02:00:00Z" }),
  ]);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].id, "a-new");
  assert.equal(
    latestWidgetQuotas([
      quota("a", { accountId: "known", unbound: false }),
      quota("b", { accountId: "known", unbound: false }),
    ]).length,
    1,
  );
});
test("balance widget preserves zero and unknown reset; missing selection never substitutes another account", async () => {
  let renderer: any;
  const q = quota("a");
  const commands: any[] = [];
  const props: any = {
    overview: {
      quotas: [
        q,
        quota("a", { id: "week", window: "10080", remainingPercent: 68 }),
      ],
      sources: [],
    },
    accounts: null,
    preferences: {
      scale: 1,
      pinned: true,
      collapsed: false,
      sessionId: "",
      quotaKey: widgetQuotaKey(q),
    },
    error: "",
    message: "",
    busy: false,
    onCommand(...v: any[]) {
      commands.push(v);
    },
    onRefresh() {},
  };
  await act(async () => {
    renderer = create(<WidgetView {...props} />);
  });
  let text = flatten(renderer.toJSON());
  assert.match(text, /0%/);
  assert.match(text, /68%/);
  assert.match(text, /重置时间未知/);
  assert.doesNotMatch(text, /Token|Agent|分钟后重置/);
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "缩小水球" }).props.onClick(),
  );
  assert.deepEqual(commands.pop(), ["scale", 0.9]);
  await act(async () =>
    renderer.update(
      <WidgetView
        {...props}
        preferences={{ ...props.preferences, quotaKey: "missing-account" }}
      />,
    ),
  );
  text = flatten(renderer.toJSON());
  assert.match(text, /已关注额度暂不可用/);
  assert.doesNotMatch(text, /68%/);
  await act(async () =>
    renderer.update(
      <WidgetView
        {...props}
        overview={{
          ...props.overview,
          quotas: [q, quota("another", { remainingPercent: 88 })],
        }}
        preferences={{ ...props.preferences, quotaKey: "" }}
      />,
    ),
  );
  text = flatten(renderer.toJSON());
  assert.match(text, /请选择账号/);
  assert.doesNotMatch(text, /88%/);
  await act(async () =>
    renderer.update(<WidgetView {...props} error="无法连接本机采集服务" />),
  );
  text = flatten(renderer.toJSON());
  assert.match(text, /未知/);
  assert.doesNotMatch(text, /68%|0% 剩余/);
  await act(async () =>
    renderer.update(
      <WidgetView
        {...props}
        preferences={{ ...props.preferences, collapsed: true }}
        message="浮窗设置未保存"
      />,
    ),
  );
  assert.ok(renderer.root.findByProps({ "aria-label": "浮窗设置未保存" }));
  await act(async () => renderer.unmount());
});
test("water orb distinguishes empty from unknown and renders only the reported level", async () => {
  let renderer: any;
  for (const level of [0, 68, 100, null]) {
    await act(async () => {
      renderer = create(
        <QuotaOrb remaining={level} label="5 小时" onExpand={() => {}} />,
      );
    });
    const water = renderer.root.findAll(
      (n) => n.props["data-water-percent"] !== undefined,
    );
    assert.equal(water.length, level !== null && level > 0 ? 1 : 0);
    if (water.length) assert.equal(water[0].props["data-water-percent"], level);
    assert.match(
      flatten(renderer.toJSON()),
      level === null ? /待更新/ : new RegExp(String(level) + "%"),
    );
    await act(async () => renderer.unmount());
  }
  assert.equal(resetCountdown(null), "重置时间未知");
  assert.equal(resetCountdown("invalid"), "重置时间未知");
});
