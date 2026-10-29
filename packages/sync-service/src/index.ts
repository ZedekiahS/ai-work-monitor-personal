import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { SyncService } from "./kernel.js";
const host = process.env.SYNC_HOST ?? "127.0.0.1";
const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
if (!loopback && (!process.env.SYNC_TLS_CERT || !process.env.SYNC_TLS_KEY))
  throw Error("Remote sync requires TLS certificate and key");
const service = new SyncService({
  secure: !loopback,
  connectionString: process.env.PERSONAL_DATABASE_URL ?? "",
  origins: (process.env.SYNC_ALLOWED_ORIGINS ?? "http://127.0.0.1:4318").split(
    ",",
  ),
});
await service.init({
  token: process.env.SYNC_OWNER_TOKEN ?? "",
  name: process.env.SYNC_OWNER_NAME,
});
const cert = process.env.SYNC_TLS_CERT,
  key = process.env.SYNC_TLS_KEY;
const server =
  cert && key
    ? https.createServer(
        { cert: fs.readFileSync(cert), key: fs.readFileSync(key) },
        service.handler,
      )
    : http.createServer(service.handler);
server.listen(
  Number(process.env.SYNC_PORT ?? 4321),
  process.env.SYNC_HOST ?? "127.0.0.1",
  () => console.log("Personal sync service ready"),
);
const expire = setInterval(() => void service.expire(), 60000);
expire.unref();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => void service.close().then(() => process.exit(0))),
  );
