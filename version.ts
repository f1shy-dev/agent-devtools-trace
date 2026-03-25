#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const packageJsonPath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const skillPath = resolve(root, "skills/trace-server/SKILL.md");

function run(command: string, args: string[]) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  }).trim();
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function ensureCleanRepo() {
  const status = run("git", ["status", "--porcelain=v1"]);
  if (status) fail("repo is dirty; commit or stash changes before bumping version");
}

function parseNextVersion() {
  const next = process.argv[2]?.trim();
  if (!next) fail("usage: bunx version <x.y.z>");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(next)) {
    fail(`invalid semver: ${next}`);
  }
  return next;
}

function updatePackageJson(nextVersion: string) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version: string;
    bin?: Record<string, string>;
  };
  const currentVersion = pkg.version;
  if (currentVersion === nextVersion) fail(`package.json is already at ${nextVersion}`);
  pkg.version = nextVersion;
  pkg.bin = {
    ...(pkg.bin ?? {}),
    version: "./version.ts",
  };
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return currentVersion;
}

function updatePackageLock(nextVersion: string) {
  const lock = JSON.parse(readFileSync(packageLockPath, "utf8")) as {
    version?: string;
    packages?: Record<string, { version?: string; bin?: Record<string, string> }>;
  };
  lock.version = nextVersion;
  lock.packages ??= {};
  lock.packages[""] ??= {};
  lock.packages[""].version = nextVersion;
  lock.packages[""].bin = {
    ...(lock.packages[""].bin ?? {}),
    version: "version.ts",
  };
  writeFileSync(packageLockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function updateSkill(currentVersion: string, nextVersion: string) {
  const skill = readFileSync(skillPath, "utf8");
  const updated = skill.replace(
    `  version: \"${currentVersion}\"`,
    `  version: \"${nextVersion}\"`,
  );
  if (updated === skill) fail(`failed to update ${skillPath}`);
  writeFileSync(skillPath, updated);
}

function commit(nextVersion: string) {
  run("git", ["add", "package.json", "package-lock.json", "skills/trace-server/SKILL.md", "version.ts"]);
  run("git", ["commit", "-m", `chore: bump version to ${nextVersion}`]);
  run("git", ["tag", `v${nextVersion}`]);
}

const nextVersion = parseNextVersion();
ensureCleanRepo();
const currentVersion = updatePackageJson(nextVersion);
updatePackageLock(nextVersion);
updateSkill(currentVersion, nextVersion);
commit(nextVersion);
console.log(`bumped version: ${currentVersion} -> ${nextVersion}`);
