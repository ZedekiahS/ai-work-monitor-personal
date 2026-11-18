import { useRef, useState } from "react";
import { api, ApiError, download, mutate, type Settings } from "./api";
import { Button } from "./components";
import {
  exportPreferences,
  guardPreferencePatch,
  parsePreferences,
  preferencePatch,
  preferencesOf,
  previewPreferences,
  targetPreferences,
  type PreferenceChoice,
} from "./preferences";

type Preview = {
  title: string;
  choice: PreferenceChoice;
  rows: ReturnType<typeof previewPreferences>;
};
const settingsUrl = "/api/settings";

export function PreferenceControls({
  busy,
  setBusy,
  dirty,
  notify,
  onApplied,
}: {
  busy: boolean;
  setBusy: (value: string) => void;
  dirty: boolean;
  notify: (message: string, error?: boolean) => void;
  onApplied: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const input = useRef<HTMLInputElement>(null);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy("preferences");
    try {
      await fn();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "偏好设置操作失败，请重试。",
        true,
      );
    } finally {
      setBusy("");
    }
  }
  async function review(
    title: string,
    choice: PreferenceChoice,
    conflict = false,
  ) {
    setPreview(null);
    const current = preferencesOf(await api<Settings>(settingsUrl));
    const rows = previewPreferences(
      current,
      targetPreferences(current, choice),
    );
    setPreview(rows.length ? { title, choice, rows } : null);
    if (!rows.length) notify("当前设置已与所选偏好一致");
    else if (conflict) notify("当前设置已有变化，请核对更新后的差异。");
  }
  async function apply() {
    if (!preview || dirty) return;
    const saved = await api<Settings>(settingsUrl);
    const current = preferencesOf(saved);
    const target = targetPreferences(current, preview.choice);
    const rows = previewPreferences(current, target);
    if (!rows.length) {
      setPreview(null);
      onApplied();
      notify("当前设置已与所选偏好一致");
      return;
    }
    if (JSON.stringify(rows) !== JSON.stringify(preview.rows)) {
      setPreview({ ...preview, rows });
      notify("当前设置已有变化，请核对更新后的差异。");
      return;
    }
    try {
      await mutate(
        settingsUrl,
        guardPreferencePatch(saved, preferencePatch(current, target, current)),
      );
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
      await review(preview.title, preview.choice, true);
      return;
    }
    setPreview(null);
    onApplied();
    notify("偏好已应用");
  }
  return (
    <details className="section-disclosure">
      <summary>通知预设与偏好文件</summary>
      <div className="settings-form preference-controls">
        <div className="actions" role="group" aria-label="选择通知预设">
          <Button
            disabled={busy || dirty}
            onClick={() => run(() => review("日常提醒", "daily"))}
          >
            日常提醒
          </Button>
          <Button
            disabled={busy || dirty}
            onClick={() => run(() => review("关闭提醒", "silent"))}
          >
            关闭提醒
          </Button>
        </div>
        <div className="actions" role="group" aria-label="偏好文件">
          <Button
            disabled={busy || dirty}
            onClick={() => input.current?.click()}
          >
            导入偏好
          </Button>
          <input
            hidden
            ref={input}
            type="file"
            accept=".json,application/json"
            aria-label="选择 Monitor 偏好文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file && !dirty)
                void run(async () => {
                  setPreview(null);
                  if (file.size > 16 * 1024)
                    throw Error(
                      "偏好文件过大，请选择 Monitor 导出的 JSON 文件。",
                    );
                  await review(file.name, parsePreferences(await file.text()));
                });
            }}
          />
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const saved = await api<Settings>(settingsUrl);
                download("monitor-preferences.json", exportPreferences(saved));
              })
            }
          >
            导出已保存偏好
          </Button>
        </div>
        {dirty && (
          <p className="muted">请先保存当前修改，再应用预设或导入偏好。</p>
        )}
        {preview && !dirty && (
          <section aria-label="偏好变更预览">
            <h3>{preview.title}</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>设置项</th>
                    <th>当前值</th>
                    <th>应用后</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      <td>{row.from}</td>
                      <td>{row.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="actions">
              <Button disabled={busy} onClick={() => setPreview(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => run(apply)}
              >
                确认应用
              </Button>
            </div>
          </section>
        )}
      </div>
    </details>
  );
}
