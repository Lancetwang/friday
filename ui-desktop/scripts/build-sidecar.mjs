import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const build = join(root, "ui-desktop", ".sidecar-build");
const binaries = join(root, "ui-desktop", "src-tauri", "binaries");
const triple = execFileSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).trim();

if (!triple) throw new Error("Could not determine the Rust target triple.");
mkdirSync(build, { recursive: true });
mkdirSync(binaries, { recursive: true });

// macOS runners expose a Homebrew CPython that PyInstaller then embeds;
// its framework references /usr/local or /opt/homebrew dylibs that do not
// exist on user machines, so the gateway dies at launch. Force a managed
// python-build-standalone interpreter (matching the proven Windows builds)
// so the frozen sidecar is self-contained.
const pythonArgs =
  process.platform === "darwin" ? ["--python", "3.13", "--managed-python"] : [];

// The phone bridge is an optional extra, so a default `uv run` resolves without
// it and PyInstaller silently ships a sidecar whose Feishu switch cannot work.
// Naming it here keeps the artifact a function of this file rather than of
// whichever extras the machine running the build happens to have installed.
const result = spawnSync(
  "uv",
  [
    "run",
    ...pythonArgs,
    "--extra",
    "feishu",
    "--with",
    "pyinstaller",
    "pyinstaller",
    "--noconfirm",
    "--clean",
    "--onefile",
    "--noupx",
    "--name",
    `friday-app-server-${triple}`,
    "--paths",
    join(root, "src"),
    "--collect-data",
    "friday",
    "--copy-metadata",
    "friday-agent",
    "--distpath",
    binaries,
    "--workpath",
    join(build, "work"),
    "--specpath",
    build,
    join(root, "src", "friday", "app_server.py"),
  ],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
