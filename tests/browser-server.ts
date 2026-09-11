// Test-only entry point: never imported by the real server or CLI.
import { Harness } from "../src/harness.js";
import { serve } from "../src/server.js";
import { createDriver } from "../src/agent.js";
import {
  artifact,
  catalog,
  testConfig,
  mockTransport,
  submission,
  reasoning,
} from "./fixtures.js";
const config = await testConfig();
config.port = 18788;
const fetcher = mockTransport([
  [reasoning, submission(artifact())],
  [submission(artifact("A smaller, stranger museum"), "edit")],
  [submission(artifact("Mobile museum"), "mobile")],
]);
const server = await serve(
  new Harness(config, createDriver(fetcher), async () => catalog),
);
process.on("SIGTERM", () => void server.close());
process.on("SIGINT", () => void server.close());
console.log("Offline browser fixture ready on port 18788");
