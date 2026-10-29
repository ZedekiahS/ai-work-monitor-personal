import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { create, act, type ReactTestRenderer } from "react-test-renderer";
import { PersonalSyncPage } from "./src/sync";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const text = (n: any): string =>
  typeof n === "string"
    ? n
    : Array.isArray(n)
      ? n.map(text).join("")
      : (n?.children ?? []).map(text).join("");
const button = (r: ReactTestRenderer, s: string) =>
  r.root.findAllByType("button").find((n) => text(n).includes(s))!;
test("receiver switch discards sharing draft and one-use pairing link; recovery survives clipboard rejection", async () => {
  let active = "A";
  const calls: { url: string; body: any }[] = [];
  const original = globalThis.fetch;
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {
          throw Error("denied");
        },
      },
    },
  });
  globalThis.fetch = async (input: any, init: any) => {
    const url = String(input),
      body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    let value: any = {};
    if (url === "/api/sharing")
      value = {
        pair: {
          id: active,
          url: "https://sync.example",
          workspaceId: active,
          kind: "personal",
          name: "Space " + active,
        },
        connections: ["A", "B"].map((id) => ({
          id,
          active: id === active,
          name: "Space " + id,
          kind: "personal",
          url: "https://sync.example",
        })),
        grants: [],
        projects: [],
      };
    if (url === "/api/sync/select") active = body.id;
    if (url.startsWith("/api/connections/devices"))
      value = { devices: [], connectionId: active };
    if (url === "/api/connections/pair-code")
      value = { link: "aiwm://device?code=old-A", connectionId: active };
    if (url.startsWith("/api/connections/pending")) value = { items: [] };
    if (url.startsWith("/api/connections/records")) value = { items: [] };
    if (url === "/api/connections/recovery")
      value = { recoveryCode: "new-recovery-code", connectionId: active };
    return new Response(JSON.stringify(value), { status: 200 });
  };
  let r!: ReactTestRenderer,
    revision = 0;
  const props = () => ({
    revision,
    notify: () => {},
    onChanged: () => {
      revision++;
      r.update(
        <React.StrictMode>
          <PersonalSyncPage {...props()} />
        </React.StrictMode>,
      );
    },
    accounts: { accounts: [{ id: "acct", label: "My account" }] } as any,
  });
  try {
    await act(async () => {
      r = create(
        <React.StrictMode>
          <PersonalSyncPage {...props()} />
        </React.StrictMode>,
      );
    });
    await act(async () => {
      r.root
        .findAllByType("input")
        .find((n) => n.props.type === "checkbox")!
        .props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      await button(r, "添加我的另一台电脑").props.onClick();
    });
    assert.ok(button(r, "复制配对链接"));
    await act(async () => {
      await button(r, "选择").props.onClick();
    });
    assert.equal(active, "B");
    assert.equal(
      r.root.findAllByType("input").find((n) => n.props.type === "checkbox")!
        .props.checked,
      false,
      "A draft must not transfer to B",
    );
    assert.equal(
      button(r, "复制配对链接"),
      undefined,
      "A link must not appear for B",
    );
    await act(async () => {
      await button(r, "更新").props.onClick();
    });
    const recoveryButton = r.root
      .findAllByType("button")
      .find((n) => text(n).includes("更新") && text(n).includes("恢复码"))!;
    await act(async () => {
      await recoveryButton.props.onClick();
    });
    assert.ok(
      button(r, "复制恢复码"),
      "clipboard failure must retain save/retry control",
    );
    const req = calls.find((c) => c.url === "/api/connections/recovery");
    assert.equal(req?.body.connectionId, "B");
  } finally {
    if (r) await act(async () => r.unmount());
    globalThis.fetch = original;
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
  }
});

async function connectorFixture(
  run: (f: {
    renderer: () => ReactTestRenderer;
    switchTarget: () => Promise<void>;
    active: () => string;
  }) => Promise<void>,
  extra: (
    url: string,
    body: any,
  ) => Promise<Response | undefined> | Response | undefined,
  grants: any[] = [],
) {
  const original = globalThis.fetch;
  let active = "A",
    revision = 0,
    r!: ReactTestRenderer;
  globalThis.fetch = async (input: any, init: any) => {
    const url = String(input),
      body = init?.body ? JSON.parse(init.body) : null;
    const custom = await extra(url, body);
    if (custom) return custom;
    if (url === "/api/sync/select") active = body.id;
    if (url === "/api/sharing")
      return Response.json({
        pair: {
          id: active,
          url: "https://sync.example",
          workspaceId: active,
          kind: "personal",
          name: "Space " + active,
        },
        connections: ["A", "B"].map((id) => ({
          id,
          active: id === active,
          name: "Space " + id,
          kind: "personal",
          url: "https://sync.example",
        })),
        grants,
        projects: [],
      });
    if (url.startsWith("/api/connections/devices"))
      return Response.json({ devices: [], connectionId: active });
    return Response.json({ items: [] });
  };
  const props = () =>
    ({
      revision,
      notify: () => {},
      onChanged: () => {
        revision++;
        r.update(
          <React.StrictMode>
            <PersonalSyncPage {...props()} />
          </React.StrictMode>,
        );
      },
      accounts: { accounts: [{ id: "acct", label: "My account" }] },
    }) as any;
  try {
    await act(async () => {
      r = create(
        <React.StrictMode>
          <PersonalSyncPage {...props()} />
        </React.StrictMode>,
      );
    });
    await run({
      renderer: () => r,
      active: () => active,
      switchTarget: async () => {
        await act(async () => {
          await button(r, "选择").props.onClick();
        });
      },
    });
  } finally {
    if (r) await act(async () => r.unmount());
    globalThis.fetch = original;
  }
}

test("late A pairing/recovery responses cannot appear for B or after returning to A", async () => {
  let pair!: (r: Response) => void, recovery!: (r: Response) => void;
  await connectorFixture(
    async (f) => {
      const r = f.renderer();
      await act(async () => {
        void button(r, "添加我的另一台电脑").props.onClick();
        void button(r, "查看并保存恢复码").props.onClick();
      });
      assert.equal(typeof pair, "function");
      assert.equal(typeof recovery, "function");
      await f.switchTarget();
      assert.equal(f.active(), "B");
      await act(async () => {
        pair(
          Response.json({
            connectionId: "A",
            link: "aiwm://device?code=STALE-PAIR-A",
          }),
        );
        recovery(
          Response.json({
            connectionId: "A",
            recoveryCode: "STALE-RECOVERY-A",
          }),
        );
      });
      assert.equal(button(r, "复制配对链接"), undefined);
      assert.equal(button(r, "复制恢复码"), undefined);
      assert.ok(!JSON.stringify(r.toJSON()).includes("STALE-"));
      await f.switchTarget();
      assert.equal(f.active(), "A");
      assert.ok(!JSON.stringify(r.toJSON()).includes("STALE-"));
    },
    (url) => {
      if (url === "/api/connections/pair-code")
        return new Promise((resolve) => {
          pair = resolve;
        });
      if (url.startsWith("/api/connections/recovery?connectionId=A"))
        return new Promise((resolve) => {
          recovery = resolve;
        });
    },
  );
});

test("single-use recovery returned for pending A is cleared on A-B-A receiver change", async () => {
  await connectorFixture(
    async (f) => {
      const r = f.renderer();
      await act(async () => {
        await button(r, "保存我的恢复码").props.onClick();
      });
      assert.ok(JSON.stringify(r.toJSON()).includes("RECOVERY-A"));
      await f.switchTarget();
      assert.equal(f.active(), "B");
      assert.ok(!JSON.stringify(r.toJSON()).includes("RECOVERY-A"));
      await f.switchTarget();
      assert.ok(!JSON.stringify(r.toJSON()).includes("RECOVERY-A"));
    },
    (url) => {
      if (url === "/api/connections/pending")
        return Response.json({
          items: [
            { id: "pending-A", name: "Space A", url: "https://sync.example" },
          ],
        });
      if (url.includes("/api/connections/recovery?pendingId="))
        return Response.json({
          pendingId: "pending-A",
          recoveryCode: "RECOVERY-A",
          name: "Space A",
        });
    },
  );
});

test("expired grant is explicitly expired and cannot offer pause/resume as active sharing", async () => {
  await connectorFixture(
    async (f) => {
      const r = f.renderer();
      assert.ok(text(r.toJSON()).includes("已到期"));
      assert.ok(!text(r.toJSON()).includes("共享中"));
      assert.equal(button(r, "暂停"), undefined);
      assert.equal(button(r, "继续"), undefined);
    },
    () => undefined,
    [
      {
        id: "expired",
        connectionId: "A",
        accountIds: ["acct"],
        projectIds: [],
        shareQuota: true,
        from: "2020-01-01T00:00:00Z",
        to: "2020-01-02T00:00:00Z",
        paused: false,
      },
    ],
  );
});

for (const returnToA of [false, true]) test(`late pending A recovery does not reappear after ${returnToA ? "A-B-A" : "A-B"}`, async () => {
  let resolve!: (r: Response) => void;
  await connectorFixture(
    async (f) => {
      const r = f.renderer();
      await act(async () => {
        void button(r, "保存我的恢复码").props.onClick();
      });
      assert.equal(typeof resolve, "function");
      await f.switchTarget();
      assert.equal(f.active(), "B");
      if (returnToA) { await f.switchTarget(); assert.equal(f.active(), "A"); }
      await act(async () => {
        resolve(
          Response.json({
            pendingId: "pending-A",
            recoveryCode: "LATE-RECOVERY-A",
            name: "Space A",
            url: "https://sync.example",
          }),
        );
      });
      assert.ok(!JSON.stringify(r.toJSON()).includes("LATE-RECOVERY-A"));
    },
    (url) => {
      if (url === "/api/connections/pending")
        return Response.json({
          items: [
            { id: "pending-A", name: "Space A", url: "https://sync.example" },
          ],
        });
      if (url.includes("/api/connections/recovery?pendingId="))
        return new Promise((r) => {
          resolve = r;
        });
    },
  );
});

test("unknown join result remains recoverable without claiming membership or exposing recovery credentials", async () => {
  const calls: string[] = [];
  await connectorFixture(async f => {
    const r = f.renderer();
    assert.match(text(r.toJSON()), /加入结果尚未确认/);
    assert.equal(button(r, "继续登记此电脑"), undefined);
    assert.equal(button(r, "保存我的恢复码"), undefined);
    await act(async () => button(r, "继续确认加入").props.onClick());
    assert.ok(calls.includes("/api/connections/resume"));
  }, (url, body) => {
    calls.push(url);
    if (url === "/api/connections/pending") return Response.json({items:[{id:"join-A",stage:"joining",name:"Company",url:"https://company.example"}]});
    if (url === "/api/connections/resume") { assert.equal(body.pendingId,"join-A"); return Response.json({pending:true,stage:"joining",error:"请稍后继续确认加入"}); }
  });
});

test("invalid pending registration requires explicit identity recovery and confirmation, never an ordinary retry", async () => {
  const sent: any[] = [];
  await connectorFixture(async f => {
    const r = f.renderer();
    assert.match(text(r.toJSON()), /登记已撤销或凭据已更换/);
    assert.equal(button(r, "继续登记此电脑"), undefined);
    await act(async () => button(r, "恢复身份并重新登记").props.onClick());
    assert.equal(button(r,"继续重新登记").props.disabled,true);
    await act(async () => r.root.findByProps({"aria-label":"本人产品恢复码"}).props.onChange({target:{value:"valid-owner-proof"}}));
    await act(async () => button(r,"继续重新登记").props.onClick());
    assert.equal(sent.length,0);
    assert.match(text(r.toJSON()), /已撤销的设备和共享不会恢复/);
    await act(async () => button(r,"确认恢复并重新登记").props.onClick());
    assert.deepEqual(sent,[{pendingId:"invalid-A",recoveryCode:"valid-owner-proof"}]);
    assert.equal(r.root.findAllByProps({"aria-label":"本人产品恢复码"}).length,0);
  }, (url,body) => {
    if(url==="/api/connections/pending")return Response.json({items:sent.length?[]:[{id:"invalid-A",invalid:true,stage:"registering",name:"A",url:"https://sync.example"}]});
    if(url==="/api/connections/restart-registration"){sent.push(body);return Response.json({ok:true});}
  });
});

test("device revocation requires a named receiver confirmation and a receiver change dismisses it", async () => {
  const deleted: any[]=[];
  await connectorFixture(async f=>{
    const r=f.renderer();
    await act(async()=>button(r,"撤销此电脑").props.onClick());
    assert.equal(deleted.length,0);
    assert.match(text(r.toJSON()),/Space A.*现有凭据将不能继续同步/);
    await f.switchTarget();
    assert.equal(button(r,"确认撤销此电脑"),undefined);
    await act(async()=>button(r,"撤销此电脑").props.onClick());
    await act(async()=>button(r,"确认撤销此电脑").props.onClick());
    assert.deepEqual(deleted,[{connectionId:"B"}]);
  },(url,body)=>{
    if(url.startsWith("/api/connections/devices?"))return Response.json({devices:[{id:"d",label:"我的电脑",lastSeenAt:"2026-10-29T00:00:00Z"}]});
    if(url==="/api/connections/devices/d"){deleted.push(body);return Response.json({ok:true});}
  });
});
