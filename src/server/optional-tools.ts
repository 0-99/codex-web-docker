import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const optionalTools = new Set(["gh", "git"]);
// Desktop's GitHub helper recognizes exit 127 as a missing executable only
// when stderr also contains "gh: ... not found".
const unavailableScript = 'echo "$1: command not found (unavailable in the Codex Web runtime)" >&2; exit 127';

function executableOnPath(command: string, searchPath: string): boolean {
  for (const directory of searchPath.split(path.delimiter)) {
    try {
      accessSync(path.join(directory || ".", command), constants.X_OK);
      if (statSync(path.join(directory || ".", command)).isFile()) return true;
    } catch {
      // Continue looking in the next PATH directory.
    }
  }
  return false;
}

/**
 * Desktop probes optional commands with spawn(). An ENOENT error event without
 * a listener terminates Node. Return a normal, unsuccessful child instead so
 * the caller's existing exit-code handling marks the capability unavailable.
 * No successful version or GitHub response is fabricated.
 */
export function spawnWithOptionalTools(
  command: string,
  argsOrOptions: readonly string[] | SpawnOptions = [],
  spawnOptions: SpawnOptions = {},
): ChildProcess {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  const options = (Array.isArray(argsOrOptions) ? spawnOptions : argsOrOptions) as SpawnOptions;
  const searchPath = options.env
    ? options.env.PATH ?? "/usr/bin:/bin"
    : process.env.PATH ?? "/usr/bin:/bin";
  if (optionalTools.has(command) && !executableOnPath(command, searchPath)) {
    const child = spawn("/bin/sh", ["-c", unavailableScript, "codex-web", command], {
      ...options,
      shell: false,
    });
    return child;
  }
  const child = spawn(command, [...args], options);
  if (optionalTools.has(command)) {
    // A present but unusable executable can still fail asynchronously with
    // EACCES or ENOENT. Keep the error scoped to this optional tool.
    child.on("error", (error) => {
      const code = "code" in error ? String(error.code) : "error";
      console.warn(`[optional-tool] ${command} could not start: ${code}`);
    });
  }
  return child;
}

/** Preserve execFile's callback and promise adapters while avoiding ENOENT. */
export function execFileWithOptionalTools(...callArgs: unknown[]): ChildProcess {
  const [command, argsOrOptions] = callArgs;
  if (typeof command !== "string" || !optionalTools.has(command)) {
    return Reflect.apply(execFile, undefined, callArgs) as ChildProcess;
  }
  const options = (Array.isArray(argsOrOptions)
    ? callArgs[2]
    : argsOrOptions) as SpawnOptions | undefined;
  const searchPath = options?.env
    ? options.env.PATH ?? "/usr/bin:/bin"
    : process.env.PATH ?? "/usr/bin:/bin";
  if (executableOnPath(command, searchPath)) {
    return Reflect.apply(execFile, undefined, callArgs) as ChildProcess;
  }
  const callback = callArgs.findLast((value) => typeof value === "function");
  return Reflect.apply(execFile, undefined, [
    "/bin/sh", ["-c", unavailableScript, "codex-web", command],
    typeof options === "object" && options !== null ? options : {}, callback,
  ]) as ChildProcess;
}

// Node's native execFile has a custom promisify result with both streams.
// Keep that contract when Desktop wraps the returned function with promisify().
(execFileWithOptionalTools as unknown as Record<symbol, unknown>)[promisify.custom] =
  (...callArgs: unknown[]) => {
    let child: ChildProcess | undefined;
    const promise = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>(
      (resolve, reject) => {
        child = execFileWithOptionalTools(...callArgs, (
          error: Error | null,
          stdout: string | Buffer,
          stderr: string | Buffer,
        ) => {
          if (error) {
            Object.assign(error, { stdout, stderr });
            reject(error);
          } else {
            resolve({ stdout, stderr });
          }
        });
      },
    ) as Promise<{ stdout: string | Buffer; stderr: string | Buffer }> & {
      child?: ChildProcess;
    };
    promise.child = child;
    return promise;
  };
