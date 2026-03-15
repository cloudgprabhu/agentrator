#!/usr/bin/env node

import { Command } from "commander";
import { registerAuth } from "./commands/auth.js";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerSpawn, registerSpawnRole, registerBatchSpawn } from "./commands/spawn.js";
import { registerSession } from "./commands/session.js";
import { registerSend } from "./commands/send.js";
import { registerReviewCheck } from "./commands/review-check.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerOpen } from "./commands/open.js";
import { registerStart, registerStop } from "./commands/start.js";
import { registerLifecycleWorker } from "./commands/lifecycle-worker.js";
import { registerVerify } from "./commands/verify.js";
import { registerConfig } from "./commands/config.js";

const program = new Command();

program
  .name("aom")
  .description("Agent Orchestrator — manage parallel AI coding agents")
  .version("0.1.0");

registerAuth(program);
registerInit(program);
registerStart(program);
registerStop(program);
registerStatus(program);
registerSpawn(program);
registerSpawnRole(program);
registerBatchSpawn(program);
registerSession(program);
registerSend(program);
registerReviewCheck(program);
registerDashboard(program);
registerOpen(program);
registerLifecycleWorker(program);
registerVerify(program);
registerConfig(program);

program.parse();
