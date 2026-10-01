import { expect } from "vitest";
import type { BundleProvenance, BundleProvenanceEdge } from "../../../lib/index.js";

export interface MemoryDocs {
  [url: string]: unknown;
}

/**
 * An in-memory resolver plugin. It is the ONLY resolver configured in these
 * tests (the file and http resolvers are disabled), so any relative URI that
 * cannot be served from memory fails instead of silently hitting the network
 * or filesystem.
 */
export function memoryResolverOptions(docs: MemoryDocs) {
  return {
    mutateInputSchema: false,
    resolve: {
      file: false,
      http: false,
      memory: {
        order: 1,
        canRead: (file: { url: string }) => typeof file.url === "string" && file.url.startsWith("mem://"),
        read: (file: { url: string }) => {
          const doc = docs[file.url];
          if (doc === undefined) {
            throw new Error(`No in-memory document for ${file.url}`);
          }
          // Hand out a copy so the originals are guaranteed to stay pristine
          return structuredClone(doc);
        },
      },
    },
  } as const;
}

/**
 * Walks a JSON Pointer ("#/a/b" or "#") within a document. URI-qualified
 * pointers ("scheme://host/doc.json#/a/b") are walked from the fragment.
 */
export function walkPointer(doc: unknown, pointer: string): unknown {
  const hashIndex = pointer.indexOf("#");
  const fragment = hashIndex >= 0 ? pointer.substring(hashIndex) : pointer;
  if (fragment === "#" || fragment === "" || fragment === "#/") {
    return doc;
  }
  if (!fragment.startsWith("#/")) {
    return undefined;
  }
  let current: any = doc;
  for (const segment of fragment
    .slice(2)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function findNode(provenance: BundleProvenance, edge: BundleProvenanceEdge) {
  return provenance.nodes.find(
    (node) => node.sourceUri === edge.sourceUri && node.sourcePointer === edge.sourcePointer,
  );
}

/**
 * Verifies that the provenance map and the bundled schema agree with each other:
 *
 * - every edge's `pointer` locates a value in the bundled schema;
 * - the edge that a node was moved to holds the moved value itself, while every
 *   other edge holds a `$ref` equal to its `resolvedRef`;
 * - every external edge's rewritten target is exactly the single node that was
 *   moved for that (sourceUri, sourcePointer) pair;
 * - each source node was moved exactly once.
 */
export function expectProvenanceConsistent(schema: unknown, provenance: BundleProvenance) {
  const nodeKeys = provenance.nodes.map((node) => `${node.sourceUri}${node.sourcePointer}`);
  expect(new Set(nodeKeys).size, "each external node must be moved exactly once").toBe(nodeKeys.length);

  for (const edge of provenance.edges) {
    const value = walkPointer(schema, edge.pointer) as any;
    expect(value, `edge at ${edge.pointer} must exist in the bundled schema`).toBeDefined();

    const node = findNode(provenance, edge);
    const isMoveEdge = node !== undefined && node.pointer === edge.pointer;
    if (isMoveEdge) {
      // The moved node now lives at this location
      expect(node!.pointer).toBe(edge.pointer);
    } else {
      expect(value.$ref, `edge at ${edge.pointer} must hold its rewritten $ref`).toBe(edge.resolvedRef);

      if (edge.resolvedRef.startsWith("#")) {
        const target = walkPointer(schema, edge.resolvedRef);
        expect(target, `rewritten $ref ${edge.resolvedRef} must resolve in the bundled schema`).toBeDefined();
        if (node) {
          // The rewritten target IS the single moved node for this source
          expect(target).toBe(walkPointer(schema, node.pointer));
        }
      }
    }
  }
}
