// The command queue: the only path from a human action to a state change.
import fs from "node:fs";
import { appendJsonl, commandsFile, exists, nowIso, readJsonl } from "./util.mjs";
import { appendEvent } from "./ledger.mjs";

export function enqueue(root, command) {
  appendJsonl(commandsFile(root), { ts: nowIso(), ...command });
}

export function drainCommands(root, handler) {
  const file = commandsFile(root);
  if (!exists(file)) return 0;
  const processing = `${file}.processing`;
  try {
    fs.renameSync(file, processing);
  } catch {
    return 0;
  }
  const commands = readJsonl(processing);
  let applied = 0;
  for (const command of commands) {
    try {
      handler(command);
      applied++;
    } catch (err) {
      appendEvent(root, {
        campaign: command.campaign,
        type: "error",
        data: { command: command.type, message: err.message },
      });
    }
  }
  fs.unlinkSync(processing);
  return applied;
}
