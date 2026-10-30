import { startApp } from "./app.ts";
import { loadConfig } from "./config.ts";

let app;
try {
  app = await startApp(loadConfig());
} catch (e) {
  console.error(`server not started: ${(e as Error).message}`);
  process.exit(2);
}
console.error(`agent-api-sdk listening on ${app.url}  (web UI at ${app.url}/, API at ${app.url}/api/v1)`);
const shutdown = async (signal: string) => {
  console.error(`${signal}: stopping worker and server`);
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
