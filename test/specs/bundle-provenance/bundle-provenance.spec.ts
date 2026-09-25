import { describe, it, expect } from "vitest";
import $RefParser from "../../../lib/index.js";
import type { BundleProvenance, BundleProvenanceEdge } from "../../../lib/index.js";

type Docs = Record<string, unknown>;

/**
 * An in-memory resolver. It is the only resolver used in these tests, so any
 * document that is not in `docs` fails resolution instead of hitting the
 * filesystem or the network.
 */
function memoryResolver(docs: Docs) {
  return {
    order: 1,
    canRead: /^mem:\/\//,
    read(file: { url: string }) {
      if (Object.prototype.hasOwnProperty.call(docs, file.url)) {
        // Return a copy, like a real parser would, so fixtures stay pristine
        return structuredClone(docs[file.url]);
      }
      throw new Error(`No in-memory document for ${file.url}`);
    },
  };
}

function memOptions(docs: Docs) {
  return { resolve: { mem: memoryResolver(docs) } };
}

/** Resolves a JSON Pointer (RFC 6901) against a plain object. */
function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "#" || pointer === "") {
    return doc;
  }
  if (!pointer.startsWith("#/")) {
    return undefined;
  }
  let node: any = doc;
  for (const token of pointer.slice(2).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    node = node[key];
  }
  return node;
}

/** Strips the canonical root-document URI prefix from a rewritten $ref. */
function toInternalPointer(ref: string, rootUri: string): string {
  if (ref.startsWith("#")) {
    return ref;
  }
  if (ref.startsWith(rootUri + "#")) {
    return ref.slice(rootUri.length);
  }
  throw new Error(`Ref "${ref}" is not internal to ${rootUri}`);
}

function edgeAt(provenance: BundleProvenance, bundlePointer: string): BundleProvenanceEdge {
  const edge = provenance.edges.find((candidate) => candidate.bundlePointer === bundlePointer);
  if (!edge) {
    throw new Error(`No provenance edge at ${bundlePointer}`);
  }
  return edge;
}

describe("bundleWithProvenance", () => {
  const sharedDocs: Docs = {
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

  it("bundles shared references and a cycle, with a consistent source mapping", async () => {
    const parser = new $RefParser();
    const { schema, provenance } = await parser.bundleWithProvenance(
      "mem://root.json",
      sharedDocs["mem://root.json"],
      memOptions(sharedDocs),
    );
    const bundled = schema as any;

    // The shared node was moved in exactly once
    const thingNodes = provenance.nodes.filter(
      (node) => node.sourceUri === "mem://shared.json" && node.sourcePointer === "#/definitions/thing",
    );
    expect(thingNodes).toHaveLength(1);
    expect(thingNodes[0].bundlePointer).toBe("#/definitions/first");
    expect(bundled.definitions.first).toEqual({ type: "string", title: "shared thing" });

    // ...but each reference edge kept its own source
    const first = edgeAt(provenance, "#/definitions/first");
    expect(first).toMatchObject({
      sourceUri: "mem://root.json",
      sourcePointer: "#/definitions/first",
      originalRef: "mem://shared.json#/definitions/thing",
      targetUri: "mem://shared.json",
      targetPointer: "#/definitions/thing",
      moved: true,
      external: true,
    });

    const second = edgeAt(provenance, "#/definitions/second");
    expect(second).toMatchObject({
      sourceUri: "mem://root.json",
      sourcePointer: "#/definitions/second",
      originalRef: "mem://shared.json#/definitions/thing",
      targetUri: "mem://shared.json",
      targetPointer: "#/definitions/thing",
      moved: false,
      external: true,
    });
    expect(second.resolvedRef).toBe("#/definitions/first");
    expect(bundled.definitions.second).toEqual({ $ref: "#/definitions/first" });

    // The cycle was moved in once and its inner edge points back at the moved node
    const looper = edgeAt(provenance, "#/definitions/looper");
    expect(looper).toMatchObject({
      sourceUri: "mem://root.json",
      sourcePointer: "#/definitions/looper",
      originalRef: "mem://loop.json",
      targetUri: "mem://loop.json",
      targetPointer: "#",
      moved: true,
    });

    const child = edgeAt(provenance, "#/definitions/looper/properties/child");
    expect(child).toMatchObject({
      sourceUri: "mem://loop.json",
      sourcePointer: "#/properties/child",
      originalRef: "mem://loop.json",
      targetUri: "mem://loop.json",
      targetPointer: "#",
      moved: false,
    });
    // The moved node keeps its own $id scope, so the circular edge is a
    // fragment-only ref against that scope
    expect(child.resolvedRef).toBe("#");
    expect(bundled.definitions.looper.$id).toBe("mem://loop.json");

    // Every rewritten $ref in the bundle matches the provenance, and every
    // provenance target exists in the bundle
    for (const edge of provenance.edges) {
      const node = resolveJsonPointer(bundled, edge.bundlePointer) as any;
      expect(node, `node at ${edge.bundlePointer}`).toBeDefined();
      if (edge.moved) {
        expect(provenance.nodes.some((n) => n.bundlePointer === edge.bundlePointer)).toBe(true);
      } else {
        expect(node.$ref, `$ref at ${edge.bundlePointer}`).toBe(edge.resolvedRef);
      }
      if (edge.resolvedRef) {
        const target = resolveJsonPointer(bundled, toInternalPointer(edge.resolvedRef, "mem://root.json"));
        expect(target, `target of ${edge.resolvedRef}`).toBeDefined();
      }
    }

    // The bundle can be read back by the original parser
    const bundledDocs = { ...sharedDocs, "mem://root.json": bundled };
    const reparsed = await $RefParser.parse(structuredClone(bundled));
    expect(reparsed).toEqual(bundled);
    const dereferenced: any = await $RefParser.dereference(structuredClone(bundled), {
      resolve: { mem: memoryResolver(bundledDocs) },
    });
    expect(dereferenced.definitions.second).toEqual({ type: "string", title: "shared thing" });
    // The cycle survives as reference equality
    expect(dereferenced.definitions.looper.properties.child).toBe(dereferenced.definitions.looper);
  });

  it("maps duplicate references to the same node, edge by edge", async () => {
    const docs: Docs = {
      "mem://root.json": {
        definitions: {
          a: { $ref: "mem://shared.json#/definitions/thing" },
          b: { $ref: "mem://shared.json#/definitions/thing" },
          c: { $ref: "mem://shared.json#/definitions/thing" },
        },
      },
      "mem://shared.json": {
        definitions: { thing: { type: "boolean" } },
      },
    };

    const { schema, provenance } = await $RefParser.bundleWithProvenance(
      "mem://root.json",
      docs["mem://root.json"],
      memOptions(docs),
    );
    const bundled = schema as any;

    const sharedEdges = provenance.edges.filter((edge) => edge.targetUri === "mem://shared.json");
    expect(sharedEdges).toHaveLength(3);
    expect(sharedEdges.filter((edge) => edge.moved)).toHaveLength(1);
    expect(provenance.nodes.filter((node) => node.sourceUri === "mem://shared.json")).toHaveLength(1);

    const movedEdge = sharedEdges.find((edge) => edge.moved)!;
    for (const edge of sharedEdges) {
      expect(edge.sourceUri).toBe("mem://root.json");
      expect(edge.originalRef).toBe("mem://shared.json#/definitions/thing");
      expect(edge.targetPointer).toBe("#/definitions/thing");
      const node = resolveJsonPointer(bundled, edge.bundlePointer) as any;
      if (edge.moved) {
        expect(node).toEqual({ type: "boolean" });
      } else {
        expect(node.$ref).toBe(edge.resolvedRef);
        expect(edge.resolvedRef).toBe(movedEdge.bundlePointer);
      }
    }
  });

  it("records escaped JSON Pointers verbatim", async () => {
    const docs: Docs = {
      "mem://root.json": {
        definitions: {
          weird: { $ref: "mem://esc.json#/definitions/a~1b~0c" },
        },
      },
      "mem://esc.json": {
        definitions: {
          "a/b~c": { type: "integer" },
        },
      },
    };

    const { schema, provenance } = await $RefParser.bundleWithProvenance(
      "mem://root.json",
      docs["mem://root.json"],
      memOptions(docs),
    );

    const edge = edgeAt(provenance, "#/definitions/weird");
    expect(edge.targetPointer).toBe("#/definitions/a~1b~0c");
    expect(edge.originalRef).toBe("mem://esc.json#/definitions/a~1b~0c");
    expect(edge.moved).toBe(true);
    expect((schema as any).definitions.weird).toEqual({ type: "integer" });

    const node = provenance.nodes.find((candidate) => candidate.sourceUri === "mem://esc.json")!;
    expect(node.sourcePointer).toBe("#/definitions/a~1b~0c");
    expect(resolveJsonPointer(docs["mem://esc.json"], node.sourcePointer)).toEqual({ type: "integer" });
  });

  it("explains rewrites when a nested $id changes the base URI", async () => {
    const docs: Docs = {
      "mem://root.json": {
        $id: "mem://root.json",
        nested: {
          $id: "mem://nested/",
          inner: { $ref: "shared.json#/definitions/thing" },
        },
      },
      "mem://nested/shared.json": {
        definitions: { thing: { type: "number" } },
      },
    };

    const { schema, provenance } = await $RefParser.bundleWithProvenance(
      "mem://root.json",
      docs["mem://root.json"],
      memOptions(docs),
    );
    const bundled = schema as any;

    // The relative $ref resolved against the nested $id, not against the root document
    const edge = edgeAt(provenance, "#/nested/inner");
    expect(edge).toMatchObject({
      sourceUri: "mem://root.json",
      sourcePointer: "#/nested/inner",
      originalRef: "shared.json#/definitions/thing",
      targetUri: "mem://nested/shared.json",
      targetPointer: "#/definitions/thing",
      moved: true,
    });
    expect(bundled.nested.inner).toEqual({ type: "number" });

    // The bundle still reads correctly: the nested $id scope is intact
    const bundledDocs = { ...docs, "mem://root.json": bundled };
    const dereferenced: any = await $RefParser.dereference(structuredClone(bundled), {
      resolve: { mem: memoryResolver(bundledDocs) },
    });
    expect(dereferenced.nested.inner).toEqual({ type: "number" });
  });

  it("keeps same-named anchors in different documents distinct", async () => {
    const docs: Docs = {
      "mem://root.json": {
        $id: "mem://root.json",
        definitions: {
          fromA: { $ref: "mem://docs/a/doc.json" },
          fromB: { $ref: "mem://docs/b/doc.json" },
        },
      },
      "mem://docs/a/doc.json": {
        $id: "mem://docs/a/doc.json",
        item: { $id: "anchor", type: "string" },
        value: { $ref: "anchor" },
      },
      "mem://docs/b/doc.json": {
        $id: "mem://docs/b/doc.json",
        item: { $id: "anchor", type: "number" },
        value: { $ref: "anchor" },
      },
    };

    const { schema, provenance } = await $RefParser.bundleWithProvenance(
      "mem://root.json",
      docs["mem://root.json"],
      memOptions(docs),
    );
    const bundled = schema as any;

    // Both documents declare a nested resource with the same anchor name ("anchor"),
    // but their absolute URIs differ, so each $ref resolves to its own resource
    const fromA = edgeAt(provenance, "#/definitions/fromA");
    const fromB = edgeAt(provenance, "#/definitions/fromB");
    expect(fromA.targetUri).toBe("mem://docs/a/doc.json");
    expect(fromB.targetUri).toBe("mem://docs/b/doc.json");
    expect(fromA.moved).toBe(true);
    expect(fromB.moved).toBe(true);

    const anchorA = edgeAt(provenance, "#/definitions/fromA/value");
    const anchorB = edgeAt(provenance, "#/definitions/fromB/value");
    expect(anchorA).toMatchObject({
      sourceUri: "mem://docs/a/doc.json",
      originalRef: "anchor",
      targetUri: "mem://docs/a/anchor",
    });
    expect(anchorB).toMatchObject({
      sourceUri: "mem://docs/b/doc.json",
      originalRef: "anchor",
      targetUri: "mem://docs/b/anchor",
    });

    // Both anchors were moved in as separate nodes, with their own values
    expect(bundled.definitions.fromA.value).toMatchObject({ type: "string" });
    expect(bundled.definitions.fromB.value).toMatchObject({ type: "number" });

    const anchorNodes = provenance.nodes.filter((node) => node.sourceUri.endsWith("/anchor"));
    expect(anchorNodes.map((node) => node.sourceUri).sort()).toEqual(["mem://docs/a/anchor", "mem://docs/b/anchor"]);

    // The bundle still reads correctly
    const bundledDocs = { ...docs, "mem://root.json": bundled };
    const dereferenced: any = await $RefParser.dereference(structuredClone(bundled), {
      resolve: { mem: memoryResolver(bundledDocs) },
    });
    expect(dereferenced.definitions.fromA.value).toMatchObject({ type: "string" });
    expect(dereferenced.definitions.fromB.value).toMatchObject({ type: "number" });
  });

  it("locates missing-document errors at the original reference", async () => {
    const docs: Docs = {
      "mem://root.json": {
        definitions: {
          gone: { $ref: "mem://missing.json#/nope" },
        },
      },
    };

    const parser = new $RefParser();
    let error: any;
    try {
      await parser.bundleWithProvenance("mem://root.json", docs["mem://root.json"], memOptions(docs));
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain("mem://missing.json");
    expect(error.source).toBe("mem://root.json");
    expect(error.path).toEqual(["definitions", "gone"]);
  });

  it("never falls back to filesystem or network resolvers", async () => {
    const docs: Docs = {
      "mem://root.json": {
        definitions: {
          remote: { $ref: "https://example.com/secret.json" },
        },
      },
    };

    let error: any;
    try {
      await $RefParser.bundleWithProvenance("mem://root.json", docs["mem://root.json"], memOptions(docs));
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.message).toContain("https://example.com/secret.json");
    expect(error.source).toBe("mem://root.json");
    expect(error.path).toEqual(["definitions", "remote"]);

    // A relative URI is only ever passed to the caller-provided resolver
    const relativeDocs: Docs = {
      "mem://root.json": {
        definitions: {
          local: { $ref: "./other.json" },
        },
      },
    };
    let relativeError: any;
    try {
      await $RefParser.bundleWithProvenance(
        "mem://root.json",
        relativeDocs["mem://root.json"],
        memOptions(relativeDocs),
      );
    } catch (err) {
      relativeError = err;
    }
    expect(relativeError).toBeDefined();
    expect(relativeError.message).toContain("mem://root.json/other.json");
    expect(relativeError.source).toBe("mem://root.json");
    expect(relativeError.path).toEqual(["definitions", "local"]);
  });

  it("does not modify the input schema", async () => {
    const input = {
      $id: "mem://root.json",
      definitions: {
        first: { $ref: "mem://shared.json#/definitions/thing" },
        second: { $ref: "mem://shared.json#/definitions/thing" },
      },
    };
    const docs: Docs = {
      "mem://root.json": input,
      "mem://shared.json": {
        definitions: { thing: { type: "string" } },
      },
    };
    const snapshot = JSON.stringify(input);

    const { schema } = await $RefParser.bundleWithProvenance("mem://root.json", input, memOptions(docs));

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(schema).not.toBe(input);
    expect((schema as any).definitions.second).toEqual({ $ref: "#/definitions/first" });
  });
});
