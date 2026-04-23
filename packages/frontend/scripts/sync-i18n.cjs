// Script to sync missing i18n keys from en.json to all other locale files
// Usage: node scripts/sync-i18n.js

const fs = require("fs");
const path = require("path");

const localesDir = path.join(__dirname, "../src/i18n/locales");
const baseLocale = "en.json";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function syncKeys(base, target) {
  let changed = false;
  for (const key in base) {
    if (!(key in target)) {
      target[key] = "";
      changed = true;
    } else if (
      typeof base[key] === "object" &&
      base[key] &&
      !Array.isArray(base[key])
    ) {
      if (typeof target[key] !== "object" || !target[key]) target[key] = {};
      changed = syncKeys(base[key], target[key]) || changed;
    }
  }
  return changed;
}

function main() {
  const basePath = path.join(localesDir, baseLocale);
  const baseObj = readJson(basePath);
  const files = fs
    .readdirSync(localesDir)
    .filter((f) => f.endsWith(".json") && f !== baseLocale);
  for (const file of files) {
    const filePath = path.join(localesDir, file);
    const targetObj = readJson(filePath);
    if (syncKeys(baseObj, targetObj)) {
      writeJson(filePath, targetObj);
      console.log(`Updated: ${file}`);
    } else {
      console.log(`No changes: ${file}`);
    }
  }
}

main();
