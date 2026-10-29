import fs from "node:fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
let desktopKey: Buffer | undefined;
export async function receiveDesktopKey() {
  if (!process.send) return;
  desktopKey = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("系统凭据存储未就绪")), 10000);
    const receive = (v: any) => {
      if (v?.type !== "credential-key") return;
      const key = Buffer.from(v.key ?? "", "base64");
      if (key.length !== 32) {
        clearTimeout(timer);
        reject(Error("系统凭据存储不可用"));
        return;
      }
      clearTimeout(timer);
      process.off("message", receive);
      resolve(key);
    };
    process.on("message", receive);
    process.send!({ type: "credential-key-request" });
  });
}
export const protectedSettings = new Set([
  "hubPair",
  "hubPairs",
  "productIdentities",
  "pendingRegistrations",
]);
export class Credentials {
  private cached: Buffer | undefined;
  constructor(private dir: string) {}
  private key() {
    if (desktopKey) return desktopKey;
    if (this.cached) return this.cached;
    if (fs.existsSync(path.join(this.dir, "credential-key.dpapi")))
      throw Error("请使用桌面端解锁产品凭据");
    const file = path.join(this.dir, "credential-key.local");
    if (!fs.existsSync(file))
      fs.writeFileSync(file, randomBytes(32), { mode: 0o600, flag: "wx" });
    const key = fs.readFileSync(file);
    if (key.length !== 32) throw Error("产品凭据存储不可用，请恢复产品登录");
    return (this.cached = key);
  }
  seal(value: unknown) {
    const key = this.key(),
      iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv),
      data = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
    return {
      encrypted: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }
  open(value: any) {
    if (value?.encrypted !== 1) return value;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key(),
        Buffer.from(value.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(value.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    } catch {
      throw Error("产品凭据无法解锁，请使用桌面端或恢复产品登录");
    }
  }
}
