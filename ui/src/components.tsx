import React from "react";
import { quotaWindow, quotaRemaining } from "./observation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  date,
  relativeTime,
  freshNames,
  number,
  stateNames,
  type Quota,
  type Scan,
  type Session,
  shortId,
} from "./api";

const paths: Record<string, ReactNode> = {
  overview: (
    <>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h5v-6h4v6h5V10" />
    </>
  ),
  live: (
    <>
      <path d="M2 12h4l3-8 6 16 3-8h4" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  usage: (
    <>
      <path d="M4 20V10m6 10V4m6 16v-7m6 7V7" />
    </>
  ),
  accounts: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-4v4" />
    </>
  ),
  company: (
    <>
      <rect x="3" y="8" width="7" height="13" rx="1" />
      <path d="M10 21h11V3H10v5m4-1h3m-3 4h3m-3 4h3M6 12h1m-1 4h1" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="10" cy="18" r="2" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7a9 9 0 1 0 1 7M20 2v5h-5" />
    </>
  ),
  arrow: <path d="M5 19 19 5H8m11 0v11" />,
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  bell: (
    <>
      <path d="M5 16h14l-2-3V8a5 5 0 0 0-10 0v5zM10 20h4" />
    </>
  ),
  check: <path d="m5 12 4 4L20 5" />,
  plus: <path d="M12 4v16M4 12h16" />,
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m8 4 12 8-12 8z" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  shield: (
    <>
      <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  pin: (
    <>
      <path d="m9 3 8 0-1 6 3 3v2H5v-2l3-3zM12 14v8" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
    </>
  ),
  warning: (
    <>
      <path d="m12 3 10 18H2zM12 9v5m0 3v1" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H4v16h6m4-12 4 4-4 4m-4-4h11" />
    </>
  ),
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.overview}
    </svg>
  );
}
export function Button({
  children,
  icon,
  variant = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: string;
  variant?: string;
}) {
  return (
    <button {...props} className={`button ${variant} ${props.className || ""}`}>
      {icon && <Icon name={icon} size={16} />} {children}
    </button>
  );
}
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <div className="panel-heading">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Empty({
  title = "还没有记录",
  description,
  icon = "history",
  action,
}: {
  title?: string;
  description?: string;
  icon?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={27} />
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function ErrorBox({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="alert error">
      <Icon name="warning" />
      <span>
        {message.includes("401")
          ? "连接已失效，请重新打开 AI Work Monitor。"
          : message}
      </span>
      {onRetry && <Button onClick={onRetry}>重试</Button>}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      正在加载…
    </div>
  );
}
export function StateBadge({
  session,
}: {
  session: Pick<Session, "state" | "evidence" | "freshness" | "lastState">;
}) {
  const terminal = ["completed", "failed", "cancelled"].includes(session.state);
  const fresh = terminal || session.freshness === "fresh";
  const inferred = session.evidence === "inferred";
  const label = stateNames[session.state] || session.state;
  return (
    <span
      className={`badge state-${session.state} ${!fresh ? "muted" : ""}`}
      title={`${session.evidence === "confirmed" ? "明确事件证据" : inferred ? "推断证据" : "证据不足"} · ${freshNames[session.freshness] || session.freshness}${!fresh ? ` · 最后观察：${stateNames[session.lastState] || session.lastState}` : ""}`}
    >
      <i />
      {label}
      {inferred && " · 推断"}
      {!fresh && (
        <small>
          {session.freshness === "unavailable" ? "来源不可用" : "过期"}
        </small>
      )}
    </span>
  );
}
export function Freshness({ value }: { value: string }) {
  return (
    <span className={`tiny-label ${value === "fresh" ? "mint" : "amber"}`}>
      {freshNames[value] || value || "待确认"}
    </span>
  );
}
export function ScanBanner({ scan }: { scan: Scan | null | undefined }) {
  if (!scan || (scan.phase === "idle" && !scan.errors)) return null;
  const progress = scan.filesTotal
    ? Math.min(100, Math.round((scan.filesDone / scan.filesTotal) * 100))
    : 0;
  return (
    <div
      className={`scan-banner ${scan.phase === "error" ? "error" : ""}`}
      role="status"
    >
      <div>
        <span className="status-dot" />
        <strong>
          {scan.phase === "scanning"
            ? "正在读取历史记录"
            : scan.phase === "error"
              ? "采集需要检查"
              : "部分记录未能导入"}
        </strong>
        <span>
          {number(scan.filesDone)} / {number(scan.filesTotal)} 个文件
        </span>
        <span>{number(scan.eventsImported)} 条事件</span>
        {scan.errors > 0 && (
          <span className="amber">
            {number(scan.errors)} 个解析/访问问题，详见诊断
          </span>
        )}
      </div>
      <progress max={100} value={progress} aria-label="文件扫描进度" />
    </div>
  );
}
export function QuotaCard({
  quota,
  label,
  compactView = false,
  onBind,
}: {
  quota: Quota;
  label?: string;
  compactView?: boolean;
  onBind?: () => void;
}) {
  const expired = !!quota.resetsAt && Date.parse(quota.resetsAt) <= Date.now();
  const percent = quotaRemaining(quota);
  const unbound =
    quota.unbound || !quota.accountId || quota.accountId.startsWith("unknown:");
  return (
    <article className={`quota-card ${compactView ? "quota-compact" : ""}`}>
      <div className="between">
        <strong className="quota-account" title={label}>
          {unbound ? "Codex · 账号待确认" : label || "未命名账号"}
        </strong>
        {(expired || quota.freshness !== "fresh") && (
          <Freshness value={expired ? "stale" : quota.freshness} />
        )}
      </div>
      <h3>{quotaWindow(quota.window)}</h3>

      <div className="quota-value">
        {percent === null ? "未知" : `${Math.round(percent * 10) / 10}%`}
        <span>{percent === null ? "暂不可用" : "剩余"}</span>
      </div>
      {percent !== null && (
        <div className="meter" aria-label={`剩余 ${percent}%`}>
          <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
        </div>
      )}
      <p className="quota-reset" title={date(quota.resetsAt)}>
        {expired
          ? "已到期，等待刷新"
          : quota.resetsAt
            ? `${relativeTime(quota.resetsAt)} 重置`
            : "重置时间未知"}
      </p>
      {unbound && (
        <div className="quota-binding">
          {onBind && (
            <button className="text-button" onClick={onBind}>
              关联账号
            </button>
          )}
        </div>
      )}
      <details className="quota-details">
        <summary>额度详情</summary>
        <dl>
          {quota.remainingPercent !== null && percent === null && (
            <>
              <dt>上次记录</dt>
              <dd>{Math.round(quota.remainingPercent * 10) / 10}% 剩余</dd>
            </>
          )}
          <dt>额度池</dt>
          <dd>{quota.pool || "未知"}</dd>
          <dt>来源</dt>
          <dd>
            {quota.sourceId.startsWith("quota-probe:")
              ? "本机查询"
              : "会话日志"}
          </dd>
          <dt>更新时间</dt>
          <dd>{date(quota.observedAt)}</dd>
          <dt>重置时间</dt>
          <dd>{date(quota.resetsAt)}</dd>
        </dl>
      </details>
    </article>
  );
}

export function CopyButton({
  value,
  label = "复制 ID",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  return (
    <>
      <Button
        icon={copied ? "check" : "copy"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setCopyError(false);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
            setCopyError(true);
          }
        }}
      >
        {copied ? "已复制" : label}
      </Button>
      {copyError && <span role="alert">复制未完成，请手动选择并复制。</span>}
    </>
  );
}
export function ConfirmDialog({
  title,
  description,
  confirm,
  onConfirm,
  onClose,
  danger = true,
}: {
  title: string;
  description: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
  danger?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="confirm-dialog" onCancel={onClose}>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      <div className="actions">
        <Button onClick={onClose}>取消</Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirm}
        </Button>
      </div>
    </dialog>
  );
}
export function JsonPreview({ value }: { value: unknown }) {
  return (
    <pre className="json-preview">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
export function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
