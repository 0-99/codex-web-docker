import Module from "node:module";
import path from "node:path";
import { execFileWithOptionalTools, spawnWithOptionalTools } from "./optional-tools";

export function installModuleAliasHook(): void {
  const moduleWithLoad = Module as typeof Module & {
    _load: (
      request: string,
      parent: NodeModule | undefined,
      isMain: boolean,
    ) => unknown;
  };
  const originalLoad = moduleWithLoad._load;
  const desktopRoot = path.resolve(__dirname, "../../scratch/asar") + path.sep;
  const childProcess = originalLoad.call(moduleWithLoad, "node:child_process", module, false) as object;
  const desktopChildProcess = Object.create(childProcess) as Record<string, unknown>;
  desktopChildProcess.spawn = spawnWithOptionalTools;
  desktopChildProcess.execFile = execFileWithOptionalTools;

  moduleWithLoad._load = function moduleAliasLoad(
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
  ): unknown {
    if (
      (request === "child_process" || request === "node:child_process") &&
      parent?.filename?.startsWith(desktopRoot)
    ) {
      return desktopChildProcess;
    }
    if (request === "electron") {
      return originalLoad.call(this, path.resolve(
        path.resolve(__dirname, "../.."),
        "src/server/electron/index.js",
      ), parent, isMain);
    }

    return originalLoad.call(this, request, parent, isMain);
  };
}
