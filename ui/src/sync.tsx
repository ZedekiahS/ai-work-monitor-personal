import { useEffect, useRef, useState } from "react";
import {
  api,
  mutate,
  useResource,
  date,
  number,
  download,
  type Accounts,
} from "./api";
import {
  Button,
  Panel,
  FormField,
  ErrorBox,
  ConfirmDialog,
  CopyButton,
} from "./components";

type Props = {
  revision: number;
  notify: (s: string, error?: boolean) => void;
  onChanged: () => void;
  accounts: Accounts | null;
};
type Sharing = {
  pair?: {
    id: string;
    name?: string;
    url: string;
    workspaceId: string;
    kind?: string;
  };
  connections?: {
    id: string;
    kind?: string;
    name?: string;
    url: string;
    active: boolean;
    status: string;
  }[];
  grants: any[];
  projects?: { id: string; label: string }[];
  pendingRevocations?: string[];
  pendingErases?: string[];
  blocked?: any[];
  status?: string;
};

export function PersonalSyncPage(props: Props) {
  return <ConnectionPage {...props} personal />;
}
export function EmployeeConnector(props: Props) {
  return <ConnectionPage {...props} />;
}

function ConnectionPage({
  personal = false,
  ...props
}: Props & { personal?: boolean }) {
  const sharing = useResource<Sharing>("/api/sharing", props.revision);
  const pending = useResource<any>("/api/connections/pending", props.revision);
  const active = sharing.data?.connections?.find((c) => c.active);
  const [spaces, setSpaces] = useState<any[]>([]),
    [workspaceId, setWorkspaceId] = useState("");
  const [link, setLink] = useState(""),
    [name, setName] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [url, setUrl] = useState(""),
    [recovery, setRecovery] = useState(""),
    [oneTime, setOneTime] = useState(""),
    [restart, setRestart] = useState<any>(null),
    [restartCode, setRestartCode] = useState(""),
    [confirmRestart, setConfirmRestart] = useState(false);
  const targetEpoch = useRef({ id: active?.id, serial: 0 });
  if (targetEpoch.current.id !== active?.id)
    targetEpoch.current = {
      id: active?.id,
      serial: targetEpoch.current.serial + 1,
    };
  const previousTarget = useRef(active?.id);
  useEffect(() => {
    if (previousTarget.current && previousTarget.current !== active?.id) {
      setOneTime("");
      setPreview(null);
      setLink("");
      setSpaces([]);
      setWorkspaceId("");
      setBusy(false);
      setError("");
      setRestart(null);
      setRestartCode("");
      setConfirmRestart(false);
    }
    previousTarget.current = active?.id;
  }, [active?.id]);
  const act = async (fn: (current: () => boolean) => Promise<any>) => {
    const serial = targetEpoch.current.serial;
    const current = () => serial === targetEpoch.current.serial;
    setBusy(true);
    setError("");
    try {
      await fn(current);
      if (current()) props.onChanged();
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <>
      <Panel
        title={personal ? "我的电脑同步" : "加入公司"}
        subtitle={
          personal
            ? "连接自己的同步服务，在已配对电脑间查看授权记录。"
            : "接受邀请后，再选择要共享的数据。"
        }
      >
        {error && <ErrorBox message={error} />}
        {!preview ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async (current) => {
                const result = await mutate("/api/connections/preview", {
                  link,
                });
                if (current()) setPreview(result);
              });
            }}
          >
            <FormField
              label={personal ? "新电脑配对链接" : "公司邀请或本人设备配对链接"}
            >
              <input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                required
                autoComplete="off"
              />
            </FormField>
            <Button type="submit" disabled={busy}>
              {busy ? "正在检查…" : "查看连接信息"}
            </Button>
          </form>
        ) : (
          <div>
            <h3>{preview.name}</h3>
            <p>{preview.url}</p>
            <p>
              {preview.kind === "join"
                ? "仅共享你随后选择的账号额度或项目用量。不会上传对话、代码或 AI 登录凭据。"
                : "此电脑将加入你已有的产品账号；共享范围仍需单独选择。"}
            </p>
            {preview.kind === "join" && (
              <FormField label="你的姓名">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                />
              </FormField>
            )}
            <Button
              disabled={busy || (preview.kind === "join" && !name.trim())}
              onClick={() =>
                void act(async (current) => {
                  const v = await mutate("/api/connections/accept", {
                    link,
                    name,
                  });
                  if (!current()) return;
                  setOneTime(v.recoveryCode ?? "");
                  setPreview(null);
                  setLink("");
                  if (v.pending) {
                    props.notify(v.stage === "joining" ? "正在确认加入结果，可稍后继续" : "已加入，尚需完成此电脑登记", true);
                    return;
                  }
                  props.notify("已连接，请选择共享范围");
                })
              }
            >
              确认加入
            </Button>
            <Button disabled={busy} onClick={() => setPreview(null)}>
              取消
            </Button>
          </div>
        )}
        <details className="section-disclosure">
          <summary>
            {personal ? "连接自建服务或恢复账号" : "恢复已有产品账号"}
          </summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async (current) => {
                const result = await mutate("/api/connections/login", {
                  url,
                  workspaceId,
                  recoveryCode: recovery,
                  personal,
                });
                if (!current()) return;
                if (result.chooseWorkspace) {
                  setSpaces(result.workspaces);
                  return;
                }
                setOneTime(result.recoveryCode ?? "");
                if (result.pending) {
                  props.notify("已登录，待网络恢复后登记此电脑", true);
                  return;
                }
                setSpaces([]);
                setRecovery("");
                props.notify("已恢复本人账号并注册此电脑");
              });
            }}
          >
            <FormField label="服务地址">
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://sync.example.com"
              />
            </FormField>
            <FormField label="产品恢复码">
              <input
                type="password"
                required
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
                autoComplete="off"
              />
            </FormField>
            {!!spaces.length && (
              <FormField label="选择服务空间">
                <select
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  required
                >
                  <option value="">请选择</option>
                  {spaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </FormField>
            )}
            <Button type="submit" disabled={busy}>
              登录并连接此电脑
            </Button>
          </form>
        </details>
        {oneTime && (
          <div role="status">
            <p>请保存产品恢复码，用于更换电脑或恢复登录。不要发给其他员工。</p>
            <input
              aria-label="产品恢复码"
              readOnly
              value={oneTime}
              onFocus={(e) => e.target.select()}
            />
            <CopyButton value={oneTime} label="复制恢复码" />
            <Button onClick={() => setOneTime("")}>已保存</Button>
          </div>
        )}
      </Panel>
      {sharing.error && (
        <ErrorBox message={sharing.error} onRetry={sharing.refresh} />
      )}
      {sharing.loading && !sharing.data && <p role="status">正在读取连接…</p>}
      {pending.error && (
        <ErrorBox message={pending.error} onRetry={pending.refresh} />
      )}
      {pending.data?.items?.map((p: any) => (
        <Panel key={p.id} title={p.name || p.url}>
          <p>{p.url}</p>
          <p>{p.stage === "joining" ? "加入结果尚未确认。网络恢复后可继续，不会重复加入。" : p.invalid ? "这次设备登记已撤销或凭据已更换。请先恢复本人身份，再重新连接此电脑。" : "已加入，尚未完成此电脑登记。网络恢复后可继续。"}</p>
          {!p.invalid &&
          <Button
            disabled={busy}
            onClick={() =>
              void act(async (current) => {
                const v = await mutate("/api/connections/resume", {
                  pendingId: p.id,
                });
                if (!current()) return;
                pending.refresh();
                setOneTime(v.recoveryCode ?? "");
                if (v.pending)
                  throw Error(v.error || "连接尚未完成，请稍后重试");
                props.notify("此电脑已连接");
              })
            }
          >
            {p.stage === "joining" ? "继续确认加入" : "继续登记此电脑"}
          </Button>}
          {p.invalid && <Button disabled={busy} onClick={() => { setRestart(p); setRestartCode(""); }}>恢复身份并重新登记</Button>}
          {p.stage !== "joining" &&
          <Button
            onClick={() =>
              void act(async (current) => {
                const v = await api(
                  "/api/connections/recovery?pendingId=" +
                    encodeURIComponent(p.id),
                );
                if (!current()) return;
                setOneTime(v.recoveryCode ?? "");
              })
            }
          >
            保存我的恢复码
          </Button>}
        </Panel>
      ))}
      {restart && <Panel title="重新连接此电脑" subtitle={restart.name || restart.url}>
        <p>{restart.url}</p>
        <p>输入本人的有效产品恢复码。确认后会取消这次失效登记并重新登记此电脑；原设备不会恢复，共享范围仍需另行选择。</p>
        <FormField label="本人产品恢复码">
          <input aria-label="本人产品恢复码" type="password" autoComplete="off" value={restartCode} onChange={e => setRestartCode(e.target.value)} />
        </FormField>
        <Button disabled={busy || !restartCode.trim()} onClick={() => setConfirmRestart(true)}>继续重新登记</Button>
        <Button disabled={busy} onClick={() => { setRestart(null); setRestartCode(""); }}>取消</Button>
      </Panel>}
      {restart && confirmRestart && <ConfirmDialog
        title="重新登记此电脑？"
        description={`将恢复你在 ${restart.name || restart.url} 的本人身份，取消此次失效登记并创建新的设备连接。已撤销的设备和共享不会恢复。`}
        confirm="确认恢复并重新登记"
        onClose={() => setConfirmRestart(false)}
        onConfirm={() => { void act(async current => {
          const result = await mutate("/api/connections/restart-registration", { pendingId: restart.id, recoveryCode: restartCode });
          if (!current()) return;
          setRestartCode(""); setRestart(null); pending.refresh();
          setOneTime(result.recoveryCode ?? "");
          props.notify(result.pending ? "本人身份已确认，请稍后继续登记" : "此电脑已重新连接，请选择共享范围", !!result.pending);
        }); }}
      />}
      <ConnectionTargets {...props} personal={personal} />
      {sharing.data?.pair &&
        active &&
        (!sharing.data.pair.kind ||
          sharing.data.pair.kind === (personal ? "personal" : "company")) && (
          <>
            <SharingPanel
              key={active.id + "share"}
              {...props}
              personal={personal}
              connection={active}
              sharing={sharing.data}
            />
            <OwnDevices
              key={active.id + "devices"}
              {...props}
              connection={active}
            />
            {personal && (
              <PersonalRecords
                key={active.id + "records"}
                revision={props.revision}
                connection={active}
              />
            )}
          </>
        )}
    </>
  );
}

function ConnectionTargets(props: Props & { personal: boolean }) {
  const r = useResource<Sharing>("/api/sharing", props.revision);
  if (!r.data?.connections?.length) return null;
  return (
    <Panel title="已连接的服务">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>服务</th>
              <th>状态</th>
              <th>当前授权目标</th>
            </tr>
          </thead>
          <tbody>
            {r.data.connections
              .filter(
                (c) =>
                  !c.kind ||
                  c.kind === (props.personal ? "personal" : "company"),
              )
              .map((c) => (
                <tr key={c.id}>
                  <td>{c.name ?? c.url}</td>
                  <td>{c.status || "等待同步"}</td>
                  <td>
                    {c.active ? (
                      "当前目标"
                    ) : (
                      <Button
                        onClick={async () => {
                          try {
                            await mutate("/api/sync/select", { id: c.id });
                            props.onChanged();
                          } catch (e) {
                            props.notify((e as Error).message, true);
                          }
                        }}
                      >
                        选择
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <SyncStatus revision={props.revision} />
    </Panel>
  );
}

type Target = NonNullable<Sharing["connections"]>[number];
function SharingPanel(
  props: Props & { personal: boolean; connection: Target; sharing: Sharing },
) {
  const r = { data: props.sharing },
    [accounts, setAccounts] = useState<string[]>([]),
    [projects, setProjects] = useState<string[]>([]),
    [projectAliases, setProjectAliases] = useState<Record<string, string>>({}),
    [quota, setQuota] = useState(false),
    [usage, setUsage] = useState(false),
    [from, setFrom] = useState(() =>
      new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16),
    ),
    [to, setTo] = useState(() =>
      new Date(
        Date.now() + 30 * 86400000 - new Date().getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16),
    ),
    [days, setDays] = useState(30),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<any>(null);
  const toggle = (xs: string[], id: string, yes: boolean) =>
    yes ? [...xs, id] : xs.filter((x) => x !== id);
  const submit = async () => {
    setBusy(true);
    try {
      await mutate("/api/sharing", {
        connectionId: props.connection.id,
        accountIds: accounts,
        projectIds: usage ? projects : [],
        projectAliases,
        shareQuota: quota,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        retentionDays: days,
      });
      props.notify("授权已保存");
      props.onChanged();
    } catch (e) {
      props.notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={props.personal ? "选择同步范围" : "选择共享范围"}>
      <p>
        接收方：<strong>{props.connection.name ?? props.connection.url}</strong>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset>
          <legend>账号</legend>
          {!props.accounts ? (
            <p>账号列表尚未可用，请重新读取账号后选择共享范围。</p>
          ) : (
            !props.accounts.accounts.length && (
              <p>
                尚无已确认账号。
                <a
                  href={
                    "#accounts?return=" +
                    (props.personal ? "personal" : "company")
                  }
                >
                  确认账号并返回
                </a>
              </p>
            )
          )}
          {props.accounts?.accounts.map((a) => (
            <label className="check" key={a.id}>
              <input
                type="checkbox"
                checked={accounts.includes(a.id)}
                onChange={(e) =>
                  setAccounts(toggle(accounts, a.id, e.target.checked))
                }
              />
              {a.label}
            </label>
          ))}
        </fieldset>
        <label className="check">
          <input
            type="checkbox"
            checked={quota}
            onChange={(e) => setQuota(e.target.checked)}
          />
          共享账号额度
        </label>
        {quota && (
          <p className="small muted">
            额度属于整个账号，可能包含其他项目或私人活动；不是项目专属余额。
          </p>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={usage}
            onChange={(e) => setUsage(e.target.checked)}
          />
          共享所选项目的用量与任务状态
        </label>
        {usage && (
          <fieldset>
            <legend>项目</legend>
            {r.data?.projects?.map((p) => (
              <label className="check" key={p.id}>
                <input
                  type="checkbox"
                  checked={projects.includes(p.id)}
                  onChange={(e) =>
                    setProjects(toggle(projects, p.id, e.target.checked))
                  }
                />
                {p.label}
              </label>
            ))}
          </fieldset>
        )}
        {usage &&
          projects.map((id) => (
            <FormField
              key={id}
              label={
                (r.data?.projects?.find((p) => p.id === id)?.label ??
                  "所选项目") + "的共享名称"
              }
            >
              <input
                maxLength={80}
                value={projectAliases[id] ?? "项目 " + id.slice(-6)}
                onChange={(e) =>
                  setProjectAliases({ ...projectAliases, [id]: e.target.value })
                }
              />
            </FormField>
          ))}
        <div className="sharing-fields">
          <FormField label="开始时间">
            <input
              type="datetime-local"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </FormField>
          <FormField label="结束时间">
            <input
              type="datetime-local"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </FormField>
          <FormField label="保留天数">
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </FormField>
        </div>
        <details>
          <summary>查看将发送的字段</summary>
          <p>
            账号与项目标识、观察时间、模型、任务状态、Token
            增量；勾选额度时包括额度窗口、余额比例和重置时间。不包含对话、代码、终端输出或文件路径。
          </p>
        </details>
        <Button
          type="submit"
          disabled={
            busy ||
            !accounts.length ||
            (!quota && !usage) ||
            (usage && !projects.length)
          }
        >
          {busy ? "保存中…" : "授权并开始同步"}
        </Button>
      </form>
      {!!r.data?.grants.length && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>账号</th>
                <th>共享范围</th>
                <th>有效时间</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {r.data.grants
                .filter((g) => g.connectionId === props.connection.id)
                .map((g) => (
                  <tr key={g.id}>
                    <td>
                      {g.accountIds
                        .map(
                          (id: string) =>
                            props.accounts?.accounts.find((a) => a.id === id)
                              ?.label ?? "已移除账号",
                        )
                        .join("、")}
                    </td>
                    <td>
                      {[
                        g.shareQuota ? "账号额度" : "",
                        g.projectIds.length ? "所选项目用量与状态" : "",
                      ]
                        .filter(Boolean)
                        .join("、")}
                    </td>
                    <td>
                      {date(g.from)} 至 {date(g.to)}
                    </td>
                    <td>
                      {g.revoked || g.revokedAt
                        ? "已撤回"
                        : Date.parse(g.to) <= Date.now()
                          ? "已到期"
                          : Date.parse(g.from) > Date.now()
                            ? "尚未开始"
                            : g.paused
                              ? "已暂停"
                              : "共享中"}
                    </td>
                    <td>
                      {!g.revoked && !g.revokedAt && (
                        <>
                          {Date.parse(g.to) > Date.now() && (
                            <Button
                              onClick={async () => {
                                try {
                                  await mutate(
                                    "/api/sharing/" +
                                      encodeURIComponent(g.id) +
                                      "/pause",
                                    {
                                      paused: !g.paused,
                                      connectionId: props.connection.id,
                                    },
                                  );
                                  props.onChanged();
                                } catch (e) {
                                  props.notify((e as Error).message, true);
                                }
                              }}
                            >
                              {g.paused ? "继续" : "暂停"}
                            </Button>
                          )}
                          <Button onClick={() => setConfirm(g)}>撤回</Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={
            "撤回向“" +
            (props.connection.name ?? props.connection.url) +
            "”的授权？"
          }
          description="本机立即停止发送，服务确认后删除不再获授权的记录。离线时等待重连；已下载的导出文件无法收回。"
          confirm="撤回授权"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await mutate(
                "/api/sharing/" + encodeURIComponent(confirm.id),
                { connectionId: props.connection.id },
                "DELETE",
              );
              setConfirm(null);
              props.onChanged();
            } catch (e) {
              props.notify((e as Error).message, true);
            }
          }}
        />
      )}
    </Panel>
  );
}

function OwnDevices(props: Props & { connection: Target }) {
  const target = props.connection.id;
  const r = useResource<any>(
      "/api/connections/devices?connectionId=" + encodeURIComponent(target),
      props.revision,
    ),
    [link, setLink] = useState(""),
    [recoveryCode, setRecoveryCode] = useState(""),
    [saveError, setSaveError] = useState(""),
    [revokeDevice, setRevokeDevice] = useState<any>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const showRecovery = async (rotate: boolean) => {
    try {
      const v = rotate
        ? await mutate("/api/connections/recovery", { connectionId: target })
        : await api(
            "/api/connections/recovery?connectionId=" +
              encodeURIComponent(target),
          );
      if (!alive.current || v.connectionId !== target) return;
      setRecoveryCode(v.recoveryCode);
      setLink("");
      setSaveError("");
      if (rotate)
        try {
          await navigator.clipboard.writeText(v.recoveryCode);
        } catch {
          setSaveError("复制未完成，请选择恢复码手动保存，或重试复制。");
        }
    } catch (e) {
      if (alive.current) props.notify((e as Error).message, true);
    }
  };
  return (
    <Panel
      title="我的已连接电脑"
      subtitle={"接收方：" + (props.connection.name ?? props.connection.url)}
    >
      {r.loading && !r.data && <p>正在读取电脑列表…</p>}
      {!r.loading && !r.error && !r.data?.devices?.length && (
        <p>尚无已连接电脑。</p>
      )}
      {r.error && <ErrorBox message={r.error} />}
      <ul>
        {r.data?.devices?.map((d: any) => (
          <li key={d.id}>
            {d.label} ·{" "}
            {d.revokedAt
              ? "已撤销"
              : d.lastSeenAt
                ? `服务最后接收 ${date(d.lastSeenAt, true)}`
                : "尚无接收记录"}
            {!d.revokedAt && (
              <Button
                onClick={() => setRevokeDevice(d)}
              >
                撤销此电脑
              </Button>
            )}
          </li>
        ))}
      </ul>
      {revokeDevice && <ConfirmDialog title="撤销这台电脑的连接？"
        description={`将撤销 ${revokeDevice.label} 在 ${props.connection.name ?? props.connection.url} 的连接，其现有凭据将不能继续同步。其他电脑不受影响。撤回已经共享的数据请另行撤回对应授权。`}
        confirm="确认撤销此电脑" onClose={() => setRevokeDevice(null)}
        onConfirm={() => { void (async () => {
          try { await mutate("/api/connections/devices/" + revokeDevice.id, { connectionId: target }, "DELETE"); if(alive.current)props.onChanged(); }
          catch(e){if(alive.current)props.notify((e as Error).message,true);}
        })(); }} />}
      <Button
        onClick={async () => {
          try {
            const v = await mutate("/api/connections/pair-code", {
              connectionId: target,
            });
            if (alive.current && v.connectionId === target) setLink(v.link);
          } catch (e) {
            props.notify((e as Error).message, true);
          }
        }}
      >
        添加我的另一台电脑
      </Button>
      <details>
        <summary>凭据管理</summary>
        <Button
          onClick={async () => {
            try {
              await mutate("/api/connections/rotate", { connectionId: target });
              props.notify("此电脑凭据已更新");
            } catch (e) {
              props.notify((e as Error).message, true);
            }
          }}
        >
          更新此电脑凭据
        </Button>
        <Button onClick={() => showRecovery(true)}>更新产品恢复码</Button>
        <Button onClick={() => showRecovery(false)}>查看并保存恢复码</Button>
      </details>
      {recoveryCode && (
        <div role="status">
          <p>请保存此恢复码。更新后旧恢复码失效，已连接电脑不受影响。</p>
          <input
            aria-label="产品恢复码"
            readOnly
            value={recoveryCode}
            onFocus={(e) => e.target.select()}
          />
          {saveError && <p role="alert">{saveError}</p>}
          <CopyButton value={recoveryCode} label="复制恢复码" />
          <Button
            onClick={() => {
              setRecoveryCode("");
              setSaveError("");
            }}
          >
            已保存
          </Button>
        </div>
      )}
      {link && (
        <>
          <p>仅供你本人的新电脑使用，十分钟内有效。</p>
          <input
            aria-label="配对链接"
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
          />
          <CopyButton value={link} label="复制配对链接" />
        </>
      )}
    </Panel>
  );
}

function PersonalRecords({
  revision,
  connection,
}: {
  revision: number;
  connection: Target;
}) {
  const targetQuery = "connectionId=" + encodeURIComponent(connection.id);
  const r = useResource<any>(
      "/api/connections/records?" + targetQuery,
      revision,
    ),
    summary = useResource<any>(
      "/api/connections/overview?" + targetQuery,
      revision,
    ),
    [shown, setShown] = useState(100);
  return (
    <Panel title="我的跨电脑记录">
      {summary.data?.usage?.map((v: any) => (
        <p key={v.accountId}>
          账号 {v.accountId.slice(-6)} · Token 合计 {number(v.total)} ·{" "}
          {v.taskCount} 个任务
        </p>
      ))}
      {summary.data?.quotas?.map((v: any, i: number) => (
        <p key={i}>
          账号{" "}
          {v.accountId.startsWith("unknown") ? "未确认" : v.accountId.slice(-6)}{" "}
          · {v.quota.window} 分钟窗口 ·{" "}
          {Date.now() - Date.parse(v.observedAt) > 300000 ||
          (v.quota.resetsAt && Date.parse(v.quota.resetsAt) <= Date.now())
            ? "额度已过期"
            : v.quota.remainingPercent == null
              ? "余额未知"
              : v.quota.remainingPercent + "%"}
        </p>
      ))}
      {r.error && <ErrorBox message={r.error} />}
      {summary.error && <ErrorBox message={summary.error} />}
      <p>
        {r.loading && !r.data
          ? "正在读取授权记录…"
          : r.error
            ? "授权记录读取失败，请重试。"
            : r.data?.items?.length
              ? `已读取 ${number(r.data.items.length)} 条授权记录`
              : "尚无授权记录"}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>发生时间</th>
              <th>模型</th>
              <th>Token</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {r.data?.items?.slice(0, shown).map((r: any) => (
              <tr key={r.eventId}>
                <td>{date(r.payload.occurredAt, true)}</td>
                <td>{r.payload.model || "未提供"}</td>
                <td>
                  {r.payload.usage
                    ? number(r.payload.usage.input + r.payload.usage.output)
                    : "—"}
                </td>
                <td>
                  {r.payload.kind === "usage_correction"
                    ? "用量更正"
                    : r.payload.state || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.data?.items?.length > shown && (
        <Button onClick={() => setShown(shown + 100)}>显示更多</Button>
      )}
      <Button
        onClick={async () => {
          const v = await api(
            "/api/connections/records?export=1&" + targetQuery,
          );
          download("my-synced-records.json", JSON.stringify(v, null, 2));
        }}
      >
        导出全部授权记录
      </Button>
    </Panel>
  );
}

export function SyncStatus({
  revision,
  onNavigate,
}: {
  revision: number;
  onNavigate?: () => void;
}) {
  const r = useResource<Sharing>("/api/sharing", revision),
    pending =
      (r.data?.pendingRevocations?.length ?? 0) +
      (r.data?.pendingErases?.length ?? 0);
  if (!pending && !r.data?.blocked?.length) return null;
  return (
    <div role="status" className="notice warning">
      {pending ? `${pending} 项撤回或删除等待服务确认。` : ""}
      {r.data?.blocked?.length
        ? "部分共享已暂停，请确认账号归属或处理同步冲突。"
        : ""}
      {onNavigate && <Button onClick={onNavigate}>查看同步</Button>}
    </div>
  );
}
