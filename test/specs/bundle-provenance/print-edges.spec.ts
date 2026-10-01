import { describe, it, expect } from "vitest";
import $RefParser from "../../../lib/index.js";
import type { ParserOptions } from "../../../lib/index.js";
import { memoryResolverOptions } from "./helpers.js";

/**
 * Prints the bundle's reference edges and their source locations.
 *
 * Run it directly with:
 *
 *   pnpm provenance:edges
 *
 * The scenario is built from three in-memory documents with shared references
 * and a circular reference, served by an in-memory resolver only (no network,
 * no filesystem).
 */
describe("print bundle provenance", () => {
  it("prints every reference edge and its source location", async () => {
    const docs = {
      "mem://schemas/root.json": {
        definitions: {
          a: { $ref: "a.json" },
          bee: { $ref: "b.json#/definitions/bee" },
        },
        properties: {
          aAgain: { $ref: "a.json" },
          beeAgain: { $ref: "b.json#/definitions/bee" },
        },
      },
      "mem://schemas/a.json": {
        type: "object",
        properties: {
          name: { type: "string" },
          bee: { $ref: "b.json#/definitions/bee" },
        },
      },
      "mem://schemas/b.json": {
        definitions: {
          bee: {
            type: "object",
            properties: {
              a: { $ref: "a.json" },
            },
          },
        },
      },
    };

    const { schema, provenance } = await $RefParser.bundleWithProvenance("mem://schemas/root.json", {
      resolve: memoryResolverOptions(docs).resolve,
    } as ParserOptions);

    console.log("");
    console.log("Moved nodes (each external node is bundled exactly once):");
    for (const node of provenance.nodes) {
      console.log(`  ${node.pointer}  <=  ${node.sourceUri}${node.sourcePointer}`);
    }
    console.log("");
    console.log("Reference edges (final pointer | original $ref | source | rewritten $ref):");
    for (const edge of provenance.edges) {
      console.log(
        `  ${edge.pointer}  |  ${edge.originalRef}  |  ${edge.sourceUri}${edge.sourcePointer}  |  ${edge.resolvedRef}`,
      );
    }
    console.log("");
    console.log(JSON.stringify(provenance, null, 2));

    expect(provenance.nodes.length).toBeGreaterThan(0);
    expect(provenance.edges.length).toBeGreaterThan(0);
    expect(schema).toBeDefined();
  });
});
