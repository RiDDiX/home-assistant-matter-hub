import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";
import externalizeAllPackagesExcept from "esbuild-plugin-noexternal";
import { rimraf } from "rimraf";

const src = path.resolve(import.meta.dirname, "src");
const dist = path.resolve(import.meta.dirname, "dist");

await rimraf(dist);
await buildBackend();

async function buildBackend() {
  process.stdout.write("Building Backend... ");
  await esbuild.build({
    bundle: true,
    entryPoints: [path.resolve(src, "cli.ts")],
    platform: "node",
    outdir: path.resolve(dist),
    treeShaking: true,
    target: "node20",
    format: "esm",
    minify: false,
    sourcemap: "linked",
    plugins: [
      stubBunImports(),
      // bootstrap.ts stays bundled so it sets the bundled @matter/nodejs config
      externalizeAllPackagesExcept([
        "@home-assistant-matter-hub/common",
        "@matter/general",
        "@matter/main",
        "@matter/model",
        "@matter/node",
        "@matter/nodejs",
        "@matter/protocol",
        "@matter/types",
      ]),
    ],
  });

  const stat = fs.statSync(path.resolve(dist, "cli.js"));
  process.stdout.write(`Done (${stat.size / 1024} KB)\n`);
}

function stubBunImports() {
  return {
    name: "stubBunImports",
    setup(build) {
      // Stub out bun: protocol imports with empty modules
      build.onResolve({ filter: /^bun(:|$)/ }, (args) => {
        return { path: args.path, namespace: "bun-stub" };
      });
      build.onLoad({ filter: /.*/, namespace: "bun-stub" }, () => {
        return {
          contents:
            "export default {}; export const Database = class {}; export const constants = {};",
          loader: "js",
        };
      });
    },
  };
}
