// Script to find missing i18n keys in frontend code compared to en.json
// Usage: node scripts/find-missing-i18n.js

const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "../src");
const LOCALES_DIR = path.join(__dirname, "../src/i18n/locales");
const EN_JSON = path.join(LOCALES_DIR, "en.json");

function walk(dir, ext = [".js", ".jsx", ".ts", ".tsx"]) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const res = path.resolve(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(walk(res, ext));
    else if (ext.includes(path.extname(entry.name))) files.push(res);
  }
  return files;
}

function extractKeysFromCode(file) {
  const content = fs.readFileSync(file, "utf8");
  const regex = /\bt\(["'`]([\w.-]+)["'`]/g;
  const keys = [];
  let match;
  while ((match = regex.exec(content))) {
    keys.push(match[1]);
  }
  return keys;
}

function flatten(obj, prefix = "") {
  let keys = [];
  for (const k in obj) {
    if (typeof obj[k] === "object" && obj[k] && !Array.isArray(obj[k])) {
      keys = keys.concat(flatten(obj[k], prefix ? `${prefix}.${k}` : k));
    } else {
      keys.push(prefix ? `${prefix}.${k}` : k);
    }
  }
  return keys;
}

function setNested(obj, path, value) {
  const parts = path.split(".");
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!curr[parts[i]]) curr[parts[i]] = {};
    curr = curr[parts[i]];
  }
  curr[parts[parts.length - 1]] = value;
}

function main() {
  const enObj = JSON.parse(fs.readFileSync(EN_JSON, "utf8"));
  const enKeys = new Set(flatten(enObj));
  const codeFiles = walk(SRC_DIR);
  const usedKeys = new Set();
  for (const file of codeFiles) {
    for (const key of extractKeysFromCode(file)) {
      usedKeys.add(key);
    }
  }
  const missing = Array.from(usedKeys).filter((k) => !enKeys.has(k));
  const addMode = process.argv.includes("--add");
  if (missing.length) {
    console.log("Missing i18n keys in en.json:");
    for (const k of missing) console.log("  " + k);
    if (addMode) {
      for (const k of missing) {
        setNested(enObj, k, "TODO: Add translation");
      }
      fs.writeFileSync(EN_JSON, JSON.stringify(enObj, null, 2) + "\n");
      console.log(
        `\nAdded ${missing.length} missing keys to en.json with placeholder values.`,
      );
    }
  } else {
    console.log("No missing i18n keys found!");
  }
}

main();
