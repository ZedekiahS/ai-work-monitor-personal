import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { App } from "./src/main";
import { SessionFilters, emptyFilters } from "./src/sessions";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

function visible(node: ReactTestInstance): boolean {
  for (
    let parent: ReactTestInstance | null = node;
    parent;
    parent = parent.parent
  ) {
    if (parent.props.hidden) return false;
  }
  return true;
}

test("source settings returns to the original task scope, filters and results page", async (t) => {
  const location = new URL("http://localhost/#history");
  let replacedHash = "";
  const win = Object.assign(new EventTarget(), {
    scrollTo() {},
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, hash: string) {
        replacedHash = location.hash = hash;
      },
    },
  });
  const sources = ["A", "B"].map((id) => ({
    id,
    label: `来源${id}`,
    kind: "manual",
    collectionEnabled: true,
  }));
  const globals = {
    window: win,
    location,
    document: { getElementById: () => null },
    EventSource: class {
      close() {}
    },
    localStorage: { getItem: () => null },
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input, location);
      if (url.pathname === "/api/settings")
        return Response.json({
          pollMs: 1500,
          staleMs: 15000,
          hooksEnabled: false,
          hooks: { status: "off", preview: "" },
          backups: [],
          notifications: { enabled: false },
        });
      if (url.pathname === "/api/sources/B" && init?.method === "DELETE") {
        sources[1].collectionEnabled = false;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/sources") return Response.json({ sources });
      if (url.pathname === "/api/accounts")
        return Response.json({ accounts: [] });
      if (url.pathname === "/api/notifications")
        return Response.json({ items: [] });
      if (url.pathname === "/api/sessions") {
        const page = Number(url.searchParams.get("page"));
        const title = `${url.searchParams.get("source")}-${url.searchParams.get("q")}-${page}`;
        return Response.json({
          items: [{ id: title, title, state: "completed" }],
          page,
          pageSize: 30,
          total: 36,
        });
      }
      throw Error("Unexpected request: " + url.pathname);
    },
  };
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  let app: ReactTestRenderer;
  t.after(async () => {
    if (app) await act(async () => app.unmount());
    for (const key of Object.keys(globals)) {
      if (descriptors[key])
        Object.defineProperty(globalThis, key, descriptors[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => {
    app = create(<App />);
  });
  const button = (label: string, scope: ReactTestInstance = app.root) =>
    scope
      .findAllByType("button")
      .find((node) => visible(node) && text(node).trim() === label);
  const click = async (label: string, scope?: ReactTestInstance) => {
    const item = button(label, scope);
    assert.ok(item, `expected visible button "${label}"`);
    await act(async () => {
      const before = location.hash;
      await item.props.onClick();
      if (location.hash !== before) win.dispatchEvent(new Event("hashchange"));
    });
  };
  const go = async (hash: string) =>
    act(async () => {
      location.hash = hash;
      win.dispatchEvent(new Event("hashchange"));
    });
  const filters = {
    ...emptyFilters,
    source: "B",
    q: "项目",
    account: "unknown",
    status: "completed",
  };
  const assertHistory = () => {
    assert.equal(location.hash, "#history");
    assert.deepEqual(
      app.root.findByType(SessionFilters).props.filters,
      filters,
    );
    assert.ok(
      button("B-项目-2"),
      "expected the same matching history row on page 2",
    );
    assert.match(text(app.root), /第 2 页/);
  };
  await act(async () =>
    app.root.findByType(SessionFilters).props.onChange(filters),
  );
  await click("下一页");
  assertHistory();
  await click("检查当前来源");
  const doctorHash = location.hash;
  await click("来源设置");
  const settingsHash = location.hash;
  assert.match(settingsHash, /from=history/);
  const checked = app.root
    .findAllByType("tr")
    .find((row) => text(row).includes("环境检查所选来源"));
  assert.ok(checked && text(checked).includes("来源B"));
  await click("停止此来源", checked);
  await click("停止此来源", app.root.findByType("dialog"));
  await click("返回 Monitor 任务");
  assertHistory();
  assert.match(text(app.root), /来源B.*已停止采集/);

  // Revisit the same entries via browser history. The task list stays at its original location.
  await go(settingsHash);
  await go(doctorHash);
  await go(settingsHash);
  await click("返回 Monitor 任务");
  assertHistory();

  // Open Doctor globally, choose a different source there, then use the browser's Back route.
  sources[1].collectionEnabled = true;
  await go("#environment");
  const sourceSelect = app.root.findAllByType("select").find(visible)!;
  assert.equal(sourceSelect.props.value, "");
  await act(async () =>
    sourceSelect.props.onChange({ target: { value: "A" } }),
  );
  await click("来源设置");
  assert.ok(!button("返回 Monitor 任务"), "global Doctor has no task origin");
  assert.equal(replacedHash, "#environment?source=A");
  await go(replacedHash);
  assert.equal(
    app.root.findAllByType("select").find(visible)!.props.value,
    "A",
  );
  await go("#settings?section=sources");
  assert.ok(!button("返回 Monitor 任务"), "direct settings has no task origin");
});
