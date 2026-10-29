import { useState } from "react";
import { useResource, mutate, date, type Accounts } from "./api";
import { Panel, FormField, Button, ErrorBox } from "./components";
export function QuotaSources({
  revision,
  accounts,
  notify,
  onChanged,
}: {
  revision: number;
  accounts: Accounts | null;
  notify: (s: string, error?: boolean) => void;
  onChanged: () => void;
}) {
  const r = useResource<any>("/api/quota/sources", revision),
    [selected, setSelected] = useState(""),
    [account, setAccount] = useState(""),
    [days, setDays] = useState(7),
    [busy, setBusy] = useState(false);
  if (r.error) return <ErrorBox message={r.error} onRetry={r.refresh} />;
  if (r.loading && !r.data) return <p>正在读取额度来源…</p>;
  if (!r.data?.sources?.length)
    return (
      <Panel title="额度来源">
        <p>尚无额度观察，请在总览刷新额度后确认账号。</p>
      </Panel>
    );
  return (
    <Panel title="额度来源">
      <p>
        账号未确认时，需要你确认当前登录的账号后才能共享。确认只在所选期限内有效，登录状态变化会暂停共享。
      </p>
      {r.error && <ErrorBox message={r.error} />}
      <ul>
        {r.data.sources.map((s: any) => (
          <li key={s.id}>
            {s.label} ·{" "}
            {s.confirmed ? "已确认" : s.manual ? "已由你确认" : "账号未确认"} ·{" "}
            {date(s.observedAt, true)}
            {!s.confirmed && !s.manual && (
              <Button onClick={() => setSelected(s.id)}>确认归属</Button>
            )}
          </li>
        ))}
      </ul>
      {selected && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await mutate("/api/quota/bind", {
                sourceId: selected,
                accountId: account,
                to: new Date(Date.now() + days * 86400000).toISOString(),
              });
              setSelected("");
              notify("额度来源已关联，请重新选择共享范围");
              onChanged();
              const back = new URLSearchParams(
                location.hash.split("?")[1] ?? "",
              ).get("return");
              if (back)
                location.hash =
                  back === "company" ? "company" : "accounts?sync=1";
            } catch (e) {
              notify((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <FormField label="当前登录的账号">
            <select
              required
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">选择你已添加的账号名称</option>
              {accounts?.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="确认有效天数">
            <input
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </FormField>
          <Button type="submit" disabled={busy || !account}>
            确认并关联
          </Button>
          <Button onClick={() => setSelected("")}>取消</Button>
        </form>
      )}
    </Panel>
  );
}
