import { spawn } from "node:child_process";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

export interface ShellExecutorOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export function makeShellExecutor(opts: ShellExecutorOptions): ToolExecutor {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run a shell command and return its combined stdout+stderr. Use this for any task where no dedicated tool exists.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Bash command to execute, e.g. 'cat foo.txt'.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  };

  return {
    tool,
    async execute(args) {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command)
        return JSON.stringify({ error: "missing 'command' string arg" });
      return new Promise((resolve) => {
        const child = spawn("bash", ["-c", command], {
          cwd: opts.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(
            JSON.stringify({
              error: `timeout after ${timeoutMs}ms`,
              partial: out.slice(0, 2000),
            }),
          );
        }, timeoutMs);
        child.stdout.on("data", (c) => {
          out += c.toString();
        });
        child.stderr.on("data", (c) => {
          err += c.toString();
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(
            [
              out,
              err && `--- stderr ---\n${err}`,
              `--- exit ${code ?? "?"} ---`,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        });
      });
    },
  };
}
