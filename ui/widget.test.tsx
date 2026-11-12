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
  UsageWidget,
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

test("short click opens details; long hold drags without opening; cancellation and keyboard work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let renderer: any;
  let opened = 0;
  const commands: string[] = [];
  await act(async () => {
    renderer = create(
      <QuotaOrb
        remaining={60}
        label="7 天"
        identity="工作"
        tooltip="工作 · codex · 刚刚更新"
        onExpand={() => opened++}
        onDrag={(v) => commands.push(v)}
      />,
    );
  });
  const button = () => renderer.root.findByType("button");
  const event = {
    button: 0,
    pointerId: 1,
    currentTarget: { setPointerCapture() {} },
  };
  await act(async () => {
    button().props.onPointerDown(event);
    t.mock.timers.tick(100);
    button().props.onPointerUp(event);
    button().props.onClick({ detail: 1 });
  });
  assert.equal(opened, 1);
  assert.deepEqual(commands, []);
  await act(async () => {
    button().props.onPointerDown(event);
    t.mock.timers.tick(350);
  });
  assert.match(renderer.root.findByType("div").props.className, /is-held/);
  await act(async () => {
    button().props.onPointerMove(event);
    button().props.onPointerUp(event);
    button().props.onClick({ detail: 1 });
  });
  assert.deepEqual(commands, ["dragStart", "dragMove", "dragEnd"]);
  assert.equal(opened, 1);
  await act(async () => {
    button().props.onPointerDown(event);
    button().props.onPointerCancel();
    t.mock.timers.tick(400);
  });
  assert.equal(commands.length, 3);
  await act(async () => button().props.onClick({ detail: 0 }));
  assert.equal(opened, 2);
  assert.match(button().props.title, /工作 · codex · 刚刚更新/);
  assert.match(flatten(renderer.toJSON()), /工作/);
  await act(async () => renderer.unmount());
});

test("hidden widget pauses UI polling and events, resumes once, and never stops collection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const previous = new Map(
    ["document", "window", "fetch", "EventSource"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  const listeners = new Map<string, () => void>();
  const classes = { add() {}, remove() {}, toggle() {} };
  const doc = {
    hidden: false,
    title: "",
    body: { classList: classes },
    documentElement: { classList: classes },
    addEventListener: (k: string, v: () => void) => listeners.set(k, v),
    removeEventListener: (k: string) => listeners.delete(k),
  };
  const streams: any[] = [],
    requests: string[] = [];
  class Events {
    closed = false;
    onmessage: (() => void) | null = null;
    constructor() {
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  Object.assign(globalThis, {
    document: doc,
    window: { addEventListener() {}, removeEventListener() {} },
    EventSource: Events,
    fetch: async (url: string) => {
      requests.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes("accounts")
            ? { accounts: [] }
            : { quotas: [], sources: [] },
      };
    },
  });
  let renderer: any;
  try {
    await act(async () => {
      renderer = create(<UsageWidget />);
    });
    const initial = requests.length;
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(requests.length, initial + 2);
    await act(async () => {
      streams[0].onmessage();
      doc.hidden = true;
      listeners.get("visibilitychange")!();
    });
    const hidden = requests.length;
    await act(async () => {
      t.mock.timers.tick(30000);
      streams[0].onmessage();
      t.mock.timers.tick(500);
    });
    assert.equal(requests.length, hidden);
    assert.equal(streams[0].closed, true);
    await act(async () => {
      doc.hidden = false;
      listeners.get("visibilitychange")!();
    });
    assert.equal(requests.length, hidden + 2);
    assert.equal(streams.length, 2);
    assert.ok(
      requests.every((url) => ["/api/overview", "/api/accounts"].includes(url)),
    );
    await act(async () => renderer.unmount());
    assert.equal(streams[1].closed, true);
    assert.equal(listeners.size, 0);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
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
  assert.equal(
    renderer.root.findByProps({ role: "switch" }).props["aria-checked"],
    true,
  );
  await act(async () =>
    renderer.root.findByProps({ role: "switch" }).props.onClick(),
  );
  assert.deepEqual(commands.pop(), ["pinned", false]);
  await act(async () =>
    renderer.update(
      <WidgetView
        {...props}
        preferences={{ ...props.preferences, pinned: false }}
      />,
    ),
  );
  assert.equal(
    renderer.root.findByProps({ role: "switch" }).props["aria-checked"],
    false,
  );
  await act(async () =>
    renderer.root.findByProps({ role: "switch" }).props.onClick(),
  );
  assert.deepEqual(commands.pop(), ["pinned", true]);
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
