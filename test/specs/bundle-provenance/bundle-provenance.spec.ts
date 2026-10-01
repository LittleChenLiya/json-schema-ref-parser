import { describe, it, expect, vi, afterEach } from "vitest";
import $RefParser from "../../../lib/index.js";
import type { ParserOptions } from "../../../lib/index.js";
import { memoryResolverOptions, expectProvenanceConsistent } from "./helpers.js";

/**
 * Three in-memory documents with shared references and a cycle:
 *
 *   root.json --(a.json)--> a.json --(b.json#/definitions/bee)--> bee
 *     |                                                          |
 *     +--(b.json#/definitions/bee)--> bee ---(a.json)------------+--> a.json  (cycle)
 *
 * "a.json" and "b.json#/definitions/bee" are each referenced twice from the
 * root, plus once more from inside each other (forming the cycle).
 */
function sharedCycleDocs() {
  return {
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
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bundleWithProvenance", () => {
  it("bundles shared references and a cycle from in-memory documents, with provenance", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const docs = sharedCycleDocs();
    const docsSnapshot = structuredClone(docs);
    const parser = new $RefParser();
    const result = await parser.bundleWithProvenance("mem://schemas/root.json", {
      resolve: memoryResolverOptions(docs).resolve,
    } as ParserOptions);

    // No network access happened: only the in-memory resolver was used
    expect(fetchSpy).not.toHaveBeenCalled();

    const { schema, provenance } = result;
    expect(schema).toBeDefined();

    // Each external node was moved exactly once
    expect(provenance.nodes).toHaveLength(2);
    expect(provenance.nodes).toContainEqual({
      pointer: "#/definitions/a",
      sourceUri: "mem://schemas/a.json",
      sourcePointer: "#",
    });
    expect(provenance.nodes).toContainEqual({
      pointer: "#/definitions/bee",
      sourceUri: "mem://schemas/b.json",
      sourcePointer: "#/definitions/bee",
    });

    // Every reference edge was kept, including the duplicates and the cycle
    expect(provenance.edges).toHaveLength(6);

    // The three edges that reference a.json each keep their own source location
    const aEdges = provenance.edges.filter((edge) => edge.sourceUri === "mem://schemas/a.json");
    expect(aEdges).toHaveLength(3);
    expect(aEdges.map((edge) => edge.pointer).sort()).toEqual([
      "#/definitions/a",
      "#/definitions/bee/properties/a",
      "#/properties/aAgain",
    ]);
    for (const edge of aEdges) {
      expect(edge.originalRef).toBe("a.json");
      expect(edge.sourcePointer).toBe("#");
      expect(edge.external).toBe(true);
    }

    // The three edges that reference b.json#/definitions/bee
    const beeEdges = provenance.edges.filter(
      (edge) => edge.sourceUri === "mem://schemas/b.json" && edge.sourcePointer === "#/definitions/bee",
    );
    expect(beeEdges).toHaveLength(3);
    expect(beeEdges.map((edge) => edge.pointer).sort()).toEqual([
      "#/definitions/a/properties/bee",
      "#/definitions/bee",
      "#/properties/beeAgain",
    ]);

    // The rewritten $ref targets in the schema match the provenance map
    expectProvenanceConsistent(schema, provenance);

    // The bundled schema only contains internal references
    const bundledJson = JSON.stringify(schema);
    for (const ref of [...bundledJson.matchAll(/"\$ref":"([^"]+)"/g)].map((match) => match[1])) {
      expect(ref.startsWith("#")).toBe(true);
    }

    // The bundle can be read back by the original parser
    const reader = new $RefParser();
    const dereferenced: any = await reader.dereference(structuredClone(schema));
    expect(dereferenced.definitions.a.type).toBe("object");
    // Shared nodes were moved once, so reference equality is preserved
    expect(dereferenced.properties.aAgain).toBe(dereferenced.definitions.a);
    expect(dereferenced.properties.beeAgain).toBe(dereferenced.definitions.bee);
    // The cycle survived the round-trip
    expect(dereferenced.definitions.a.properties.bee).toBe(dereferenced.definitions.bee);
    expect(dereferenced.definitions.bee.properties.a).toBe(dereferenced.definitions.a);

    // The in-memory source documents were not modified
    expect(docs).toEqual(docsSnapshot);
  });

  it("works as a static method and with callbacks", async () => {
    const docs = sharedCycleDocs();
    const options = { resolve: memoryResolverOptions(docs).resolve } as ParserOptions;

    const result = await $RefParser.bundleWithProvenance("mem://schemas/root.json", options);
    expect(result.provenance.edges).toHaveLength(6);
    expectProvenanceConsistent(result.schema, result.provenance);

    const callbackResult = await new Promise<any>((resolvePromise, rejectPromise) => {
      const parser = new $RefParser();
      parser.bundleWithProvenance("mem://schemas/root.json", options, (err: Error | null, value?: any) => {
        if (err) {
          rejectPromise(err);
        } else {
          resolvePromise(value);
        }
      });
    });
    expect(callbackResult.provenance.nodes).toHaveLength(2);
  });

  it("does not modify an input schema object", async () => {
    const docs = sharedCycleDocs();
    const rootSchema = {
      definitions: {
        a: { $ref: "a.json" },
      },
      properties: {
        aAgain: { $ref: "a.json" },
      },
    };
    const snapshot = structuredClone(rootSchema);

    const parser = new $RefParser();
    const result = await parser.bundleWithProvenance("mem://schemas/root.json", rootSchema, {
      mutateInputSchema: false,
      resolve: memoryResolverOptions(docs).resolve,
    } as ParserOptions);

    expect(rootSchema).toEqual(snapshot);
    expect(result.schema).not.toBe(rootSchema);
    expectProvenanceConsistent(result.schema, result.provenance);
  });

  it("maps escaped JSON Pointers (~0 and ~1) back to their source", async () => {
    const docs = {
      "mem://esc/root.json": {
        definitions: {
          slash: { $ref: "shared.json#/definitions/a~1b" },
          tilde: { $ref: "shared.json#/definitions/c~0d" },
        },
      },
      "mem://esc/shared.json": {
        definitions: {
          "a/b": { type: "string" },
          "c~d": { type: "number" },
        },
      },
    };

    const result = await $RefParser.bundleWithProvenance("mem://esc/root.json", {
      resolve: memoryResolverOptions(docs).resolve,
    } as ParserOptions);

    const { schema, provenance } = result;
    expect(provenance.edges).toHaveLength(2);
    expect(provenance.edges).toContainEqual(
      expect.objectContaining({
        pointer: "#/definitions/slash",
        originalRef: "shared.json#/definitions/a~1b",
        sourceUri: "mem://esc/shared.json",
        sourcePointer: "#/definitions/a~1b",
      }),
    );
    expect(provenance.edges).toContainEqual(
      expect.objectContaining({
        pointer: "#/definitions/tilde",
        originalRef: "shared.json#/definitions/c~0d",
        sourceUri: "mem://esc/shared.json",
        sourcePointer: "#/definitions/c~0d",
      }),
    );

    expectProvenanceConsistent(schema, provenance);

    const dereferenced: any = await $RefParser.dereference(structuredClone(schema));
    expect(dereferenced.definitions.slash).toEqual({ type: "string" });
    expect(dereferenced.definitions.tilde).toEqual({ type: "number" });
  });

  it("explains rewrites when a nested $id changes the base URI", async () => {
    const docs = {
      "mem://id/root.json": {
        $id: "mem://id/root.json",
        definitions: {
          thing: { $ref: "lib.json#/definitions/wrapper" },
        },
      },
      "mem://id/lib.json": {
        $id: "mem://id/lib.json",
        definitions: {
          wrapper: {
            $id: "nested.json",
            definitions: {
              inner: { type: "integer" },
            },
            properties: {
              self: { $ref: "nested.json#/definitions/inner" },
            },
          },
        },
      },
    };
    const docsSnapshot = structuredClone(docs);

    const result = await $RefParser.bundleWithProvenance("mem://id/root.json", {
      resolve: memoryResolverOptions(docs).resolve,
    } as ParserOptions);

    const { schema, provenance } = result;

    // The wrapper was moved in from lib.json
    expect(provenance.nodes).toContainEqual({
      pointer: "#/definitions/thing",
      sourceUri: "mem://id/lib.json",
      sourcePointer: "#/definitions/wrapper",
    });

    // The inner reference resolved against the nested $id ("nested.json"),
    // and the mapping records that resource as its source
    const innerEdge = provenance.edges.find((edge) => edge.pointer === "#/definitions/thing/properties/self");
    expect(innerEdge).toBeDefined();
    expect(innerEdge!.originalRef).toBe("nested.json#/definitions/inner");
    expect(innerEdge!.sourceUri).toBe("mem://id/nested.json");
    expect(innerEdge!.sourcePointer).toBe("#/definitions/inner");

    expectProvenanceConsistent(schema, provenance);

    // The bundled schema is still readable and resolves through the nested $id
    const dereferenced: any = await $RefParser.dereference(structuredClone(schema));
    expect(dereferenced.definitions.thing.properties.self).toEqual({ type: "integer" });

    expect(docs).toEqual(docsSnapshot);
  });

  it("explains rewrites when embedded $id anchors conflict", async () => {
    // Both documents embed a schema resource with the same $id ("anchor.json"),
    // so both resolve their references against the same absolute URI. The first
    // resource registered wins, and the provenance map shows why both edges
    // point at the same moved node.
    const docs = {
      "mem://anc/root.json": {
        definitions: {
          one: { $ref: "doc1.json#/definitions/use" },
          two: { $ref: "doc2.json#/definitions/use" },
        },
      },
      "mem://anc/doc1.json": {
        $id: "mem://anc/doc1.json",
        definitions: {
          anchored: {
            $id: "anchor.json",
            definitions: {
              target: { type: "string", const: "from-doc1" },
            },
          },
          use: { $ref: "anchor.json#/definitions/target" },
        },
      },
      "mem://anc/doc2.json": {
        $id: "mem://anc/doc2.json",
        definitions: {
          anchored: {
            $id: "anchor.json",
            definitions: {
              target: { type: "string", const: "from-doc2" },
            },
          },
          use: { $ref: "anchor.json#/definitions/target" },
        },
      },
    };

    const result = await $RefParser.bundleWithProvenance("mem://anc/root.json", {
      resolve: memoryResolverOptions(docs).resolve,
    } as ParserOptions);

    const { schema, provenance } = result;

    // Both references resolved to the conflicting anchor URI, and each kept its own edge
    const anchorEdges = provenance.edges.filter((edge) => edge.sourceUri === "mem://anc/anchor.json");
    expect(anchorEdges).toHaveLength(2);
    expect(anchorEdges.map((edge) => edge.pointer).sort()).toEqual(["#/definitions/one", "#/definitions/two"]);
    for (const edge of anchorEdges) {
      expect(edge.sourcePointer).toBe("#/definitions/target");
    }

    // The anchor target was moved exactly once, and both edges agree on it
    const anchorNodes = provenance.nodes.filter((node) => node.sourceUri === "mem://anc/anchor.json");
    expect(anchorNodes).toHaveLength(1);

    expectProvenanceConsistent(schema, provenance);

    // The first registered anchor resource won the conflict
    const dereferenced: any = await $RefParser.dereference(structuredClone(schema));
    expect(dereferenced.definitions.one.const).toBe("from-doc1");
    expect(dereferenced.definitions.two.const).toBe("from-doc1");
  });

  it("locates errors at the original reference position when a document is missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const docs = {
      "mem://schemas/root.json": {
        properties: {
          gone: { $ref: "missing.json#/definitions/x" },
        },
      },
    };

    const parser = new $RefParser();
    let caught: any;
    try {
      await parser.bundleWithProvenance("mem://schemas/root.json", {
        resolve: memoryResolverOptions(docs).resolve,
      } as ParserOptions);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.message).toContain("missing.json");
    // The error is located at the original reference position in the root schema
    expect(caught.path).toEqual(["properties", "gone"]);
    expect(String(caught.source)).toContain("missing.json");

    // The missing document did not fall back to the network
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
