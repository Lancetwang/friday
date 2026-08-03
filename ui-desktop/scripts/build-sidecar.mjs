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

const result = spawnSync(
  "uv",
  [
    "run",
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
