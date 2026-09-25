#!/usr/bin/env node
/**
 * Prints the reference edges and source locations of a bundled schema.
 *
 * Usage:
 *   node scripts/bundle-provenance.mjs                 Run the built-in in-memory demo
 *   node scripts/bundle-provenance.mjs <schema.json>   Bundle a schema from disk
 *   node scripts/bundle-provenance.mjs <schema.json> --map <uri>=<file> [...]
 *
 * All documents are served through an in-memory resolver; the bundler never
 * touches the filesystem or the network for anything that was not preloaded.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

async function loadParser() {
  try {
    return await import("../dist/lib/index.js");
  } catch {
    console.error("dist/ not found, building...");
    execSync("pnpm build", { stdio: "inherit" });
    return await import("../dist/lib/index.js");
  }
}

/** Three in-memory documents with a shared reference and a cycle. */
function demoDocuments() {
  return {
    "mem://root.json": {
      $id: "mem://root.json",
      definitions: {
        first: { $ref: "mem://shared.json#/definitions/thing" },
        second: { $ref: "mem://shared.json#/definitions/thing" },
        looper: { $ref: "mem://loop.json" },
      },
    },
    "mem://shared.json": {
      definitions: {
        thing: { type: "string", title: "shared thing" },
      },
    },
    "mem://loop.json": {
      $id: "mem://loop.json",
      type: "object",
      properties: {
        child: { $ref: "mem://loop.json" },
      },
    },
  };
}

function memoryResolver(docs) {
  return {
    order: 1,
    canRead: () => true,
    read(file) {
      if (Object.prototype.hasOwnProperty.call(docs, file.url)) {
        return docs[file.url];
      }
      throw new Error(`No in-memory document for ${file.url}`);
    },
  };
}

async function main() {
  const $RefParser = (await loadParser()).default;
  const args = process.argv.slice(2);
  const docs = {};
  let rootUri;

  const schemaPath = args.find((arg) => !arg.startsWith("--") && !arg.includes("="));
  if (schemaPath) {
    rootUri = pathToFileURL(schemaPath).href;
    docs[rootUri] = await readFile(schemaPath, "utf8");
    const mapIndex = args.indexOf("--map");
    for (let i = mapIndex + 1; mapIndex !== -1 && i < args.length; i++) {
      const [uri, file] = args[i].split("=");
      if (!uri || !file) {
        continue;
      }
      docs[uri] = await readFile(file, "utf8");
    }
  } else {
    Object.assign(docs, demoDocuments());
    rootUri = "mem://root.json";
  }

  const startedAt = Date.now();
  const { provenance } = await $RefParser.bundleWithProvenance(rootUri, {
    resolve: { memory: memoryResolver(docs) },
  });
  const elapsedMs = Date.now() - startedAt;

  console.log(`# Bundled ${rootUri} in ${elapsedMs}ms`);
  console.log("# Moved-in nodes (original document URI, original pointer => final pointer)");
  for (const node of provenance.nodes) {
    console.log(`NODE ${node.sourceUri}${node.sourcePointer} => ${node.bundlePointer}`);
  }
  console.log("# Reference edges (final pointer <= original location, original $ref => rewritten $ref)");
  for (const edge of provenance.edges) {
    const rewritten = edge.moved ? "(moved here)" : edge.resolvedRef;
    console.log(
      `EDGE ${edge.bundlePointer} <= ${edge.sourceUri}${edge.sourcePointer} : ${edge.originalRef} => ${rewritten}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
