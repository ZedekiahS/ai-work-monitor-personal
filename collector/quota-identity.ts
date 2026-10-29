import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { hash } from "../core/model.js";
import { Store } from "../core/store.js";
// A local switch guard only, never an AI account identity or an uploaded credential.
export function localLoginGuard() {
  try {
    const f = path.join(
      process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
      "auth.json",
    );
    if (fs.statSync(f).size > 1024 * 1024) return null;
    return hash(fs.readFileSync(f).toString("utf8"));
  } catch {
    return null;
  }
}
export function quotaIdentity(
  store: Store,
  displaySourceId: string,
  providerId: string | null,
  guard: string | null,
) {
  const key = "quotaIdentity:" + displaySourceId,
    previous = store.getSetting<any>(key, null);
  const fingerprint = providerId
    ? "provider:" + hash(providerId)
    : guard
      ? "local-login:" + guard
      : "unconfirmed:" + randomUUID();
  if (previous?.fingerprint === fingerprint) return previous;
  const value = {
    fingerprint,
    displaySourceId,
    sourceId: displaySourceId + ":" + randomUUID(),
    accountId: providerId
      ? "codex:" + hash(providerId)
      : "unknown:codex:" + randomUUID(),
    confirmed: !!providerId,
  };
  if (previous?.sourceId)
    store.setSetting("inactiveQuotaSources", [
      ...new Set([
        ...store.getSetting<string[]>("inactiveQuotaSources", []),
        previous.sourceId,
      ]),
    ]);
  store.setSetting(key, value);
  return value;
}
