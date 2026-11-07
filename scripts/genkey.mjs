import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";

const force = process.argv.includes("--force");
const path = new URL("../src/key.js", import.meta.url);
if (existsSync(path) && !force) { console.log("key: 既存を維持"); process.exit(0); }
const k = randomBytes(12).toString("base64url");
writeFileSync(path, `export const KEY = ${JSON.stringify(k)};\n`);
console.log("key: 生成", k);
