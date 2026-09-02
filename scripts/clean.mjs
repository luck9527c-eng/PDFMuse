import { rm } from "node:fs/promises";
import path from "node:path";

const buildDirectories = ["dist", "dist-electron", "release"];

await Promise.all(
  buildDirectories.map((directory) => rm(path.resolve(directory), { recursive: true, force: true })),
);
