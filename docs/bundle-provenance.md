# Bundle Provenance

The [`bundleWithProvenance()`](ref-parser.md#bundlewithprovenanceschema-options) method bundles a schema exactly like [`bundle()`](ref-parser.md#bundleschema-options-callback), but also returns a `provenance` object that explains every rewrite the bundler performed. This is useful for auditing, for mapping validation errors in the bundled schema back to the original documents, and for verifying that a bundle is faithful to its sources.

```javascript
let { schema, provenance } = await $RefParser.bundleWithProvenance(rootUri, options);
```

## Safety guarantees

- **The input schema is never modified.** `mutateInputSchema` defaults to `false` for this entry point.
- **Only caller-provided resolvers are used.** The built-in `file` and `http` resolvers are disabled unless you explicitly configure `options.resolve.file` / `options.resolve.http`. A relative URI is only ever resolved against the base URI of the document that contains it and then handed to _your_ resolver — it can never silently trigger a filesystem or network read.
- **Errors point at the original reference.** When a document cannot be resolved, the thrown error carries `error.source` (the URI of the document that contained the `$ref`) and `error.path` (the JSON Pointer of the `$ref` within that document, as an array of tokens).

## Provenance format

```typescript
interface BundleProvenance {
  edges: BundleProvenanceEdge[]; // one per $ref occurrence
  nodes: BundleProvenanceNode[]; // one per moved-in node
}

interface BundleProvenanceEdge {
  sourceUri: string; // URI of the document that originally contained this $ref
  sourcePointer: string; // JSON Pointer of the $ref node within that document
  originalRef: string; // the $ref value, exactly as written
  targetUri: string; // URI of the document the $ref resolved to
  targetPointer: string; // JSON Pointer of the resolved node within that document
  bundlePointer: string; // JSON Pointer of this edge within the bundled schema
  resolvedRef?: string; // the final $ref value in the bundle (absent if moved here)
  moved: boolean; // true if the node was moved into the bundle at this edge
  external: boolean; // true if the edge brought in a node from another document
  circular: boolean; // true if the edge is directly circular
}

interface BundleProvenanceNode {
  sourceUri: string; // URI of the document the node was moved from
  sourcePointer: string; // JSON Pointer of the node within that document
  bundlePointer: string; // JSON Pointer of the node within the bundled schema
}
```

### Rules

- **Every `$ref` occurrence produces exactly one edge.** If the same external node is referenced from three places, there are three edges — each with its own `sourceUri`/`sourcePointer` — but the node is moved into the bundle exactly once, so exactly one of the edges has `moved: true` and there is exactly one matching entry in `nodes`.
- **Edges are recorded after all rewrites.** `resolvedRef` is the value you will actually find at `bundlePointer` in the bundled schema, including rewrites caused by nested `$id` scopes, anchors, and circular references.
- **`$id` and anchors.** `targetUri` is the canonical URI of the resource that contains the target node. When a nested `$id` changes the base URI, or when a nested resource is known by an anchor (its own `$id`), `targetUri` reflects that canonical URI, while `sourceUri`/`sourcePointer` still locate the `$ref` in the physical document where it was written. Two resources that declare the same relative `$id` in different documents get different canonical URIs, so their edges never collide.
- **Circular references.** A circular edge is still recorded: the moved node keeps its own `$id` scope, and the circular edge's `resolvedRef` (usually `"#"` or a root-qualified pointer) resolves against that scope.
- **JSON Pointers are RFC 6901.** `~` and `/` inside property names appear escaped (`~0`, `~1`) in all pointer fields.

## Inspecting a bundle from the command line

```sh
# Runs a built-in demo with three in-memory documents (a shared reference and a cycle)
pnpm bundle:provenance

# Bundles a schema from disk; additional documents are preloaded into memory with --map
pnpm bundle:provenance schema.json --map mem://shared.json=shared.json
```

The command prints one `NODE` line per moved-in node and one `EDGE` line per reference edge, each with its original document URI and JSON Pointer.
