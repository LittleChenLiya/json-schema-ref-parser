# Bundle Provenance Format

The [`bundleWithProvenance()`](ref-parser.md#bundlewithprovenanceschema-options-callback) method returns a
`BundleWithProvenanceResult`:

```typescript
interface BundleWithProvenanceResult<S> {
  schema: S; // the bundled schema (same as bundle() returns)
  provenance: BundleProvenance; // how the bundle was assembled
}

interface BundleProvenance {
  nodes: BundleProvenanceNode[]; // external values moved into the bundle
  edges: BundleProvenanceEdge[]; // one entry per $ref occurrence
}
```

## Nodes

Each external value that was moved into the bundled schema produces exactly one node entry,
no matter how many references point to it:

```typescript
interface BundleProvenanceNode {
  pointer: string; // final JSON Pointer in the bundled schema, e.g. "#/definitions/person"
  sourceUri: string; // absolute URI of the source document, e.g. "https://example.com/person.json"
  sourcePointer: string; // original JSON Pointer fragment in the source document, e.g. "#/definitions/person"
}
```

`sourcePointer` is a URI fragment: it is `"#"` for a node that was moved from the root of its
document, and `"#/..."` (with RFC 6901 `~0`/`~1` escaping) otherwise. Concatenating
`sourceUri` and `sourcePointer` always yields the absolute URI the node was resolved from.

## Edges

Every `$ref` occurrence that was processed while bundling produces one edge. References that
share a moved node still get one edge each, so duplicate references can be traced individually:

```typescript
interface BundleProvenanceEdge extends BundleProvenanceNode {
  originalRef: string; // the $ref value as written in the input schema
  resolvedRef: string; // the rewritten $ref target in the bundled schema
  external: boolean; // whether the reference pointed outside the root document
  circular: boolean; // whether the reference is (in)directly circular
}
```

- `pointer` — the final JSON Pointer of this reference in the bundled schema. Walking the
  bundled schema at this pointer yields either a `{ $ref: resolvedRef }` object or, for the
  edge a node was moved to, the moved value itself.
- `resolvedRef` — the rewritten `$ref` target. For the edge a node was moved to, this equals
  `pointer`, since the value itself now lives there. For every other edge, walking the bundled
  schema at `resolvedRef` yields the single moved node for that edge's
  `sourceUri` + `sourcePointer`.

## Invariants

- Each (`sourceUri`, `sourcePointer`) pair appears at most once in `nodes`.
- Every external edge has a matching node with the same `sourceUri` and `sourcePointer`.
- Edges inside moved nodes keep their own source information, so circular reference chains
  (e.g. `a.json` → `b.json` → `a.json`) are fully traceable.
- When a nested `$id` changes the base URI, `sourceUri` reflects the resolved absolute URI
  of the resource that actually provided the value — including embedded resources that only
  exist inside another document. When two embedded resources declare the same `$id`
  ("anchor" conflict), the first registered resource wins, and the edges of both documents
  point at the single node that was moved for the shared URI.

## Errors

If bundling fails — for example because a referenced document does not exist — the thrown
error is located at the original reference position: its `path` property is the token array
of the `$ref` within the input schema (e.g. `["properties", "gone"]`) and its `source`
property identifies the document that could not be read.

## In-memory resolution

`bundleWithProvenance()` uses the same resolver plugins as every other method. To bundle
from memory only — with no filesystem or network access, even for relative URIs — disable the
built-in resolvers and provide your own:

```javascript
const docs = {
  "mem://schemas/root.json": { definitions: { a: { $ref: "a.json" } } },
  "mem://schemas/a.json": { type: "object" },
};

const { schema, provenance } = await $RefParser.bundleWithProvenance("mem://schemas/root.json", {
  resolve: {
    file: false,
    http: false,
    memory: {
      order: 1,
      canRead: (file) => file.url.startsWith("mem://"),
      read: (file) => {
        const doc = docs[file.url];
        if (doc === undefined) throw new Error("No in-memory document for " + file.url);
        return structuredClone(doc);
      },
    },
  },
});
```

## Printing edges

To see a live example of the format, run:

```shell
pnpm provenance:edges
```

This bundles three in-memory documents with shared references and a circular reference, and
prints every reference edge and its source location.
