import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextEnv = resolve(frontend, "next-env.d.ts");
const original = await readFile(nextEnv, "utf8");
const require = createRequire(import.meta.url);
const nextCli = require.resolve("next/dist/bin/next");

const code = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [nextCli, "build"], { cwd: frontend, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)));
});

// Next rewrites this generated reference for the active distDir. Keep the checked-in
// development reference stable so a production build does not dirty or break a live dev server.
if (await readFile(nextEnv, "utf8") !== original) await writeFile(nextEnv, original, "utf8");
process.exitCode = code;
