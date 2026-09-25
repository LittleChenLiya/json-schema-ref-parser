import $RefParser from "../../lib/index.js";
import type { BundleProvenance, BundleProvenanceEdge, BundleProvenanceNode } from "../../lib/index.js";

async function checkBundleWithProvenanceTypes() {
  const result = await $RefParser.bundleWithProvenance(
    { definitions: { a: { $ref: "mem://other.json" } } },
    { resolve: { mem: { canRead: /^mem:/, read: "{}" } } },
  );

  const provenance: BundleProvenance = result.provenance;
  const edge: BundleProvenanceEdge = provenance.edges[0];
  const node: BundleProvenanceNode = provenance.nodes[0];

  const sourceUri: string = edge.sourceUri;
  const sourcePointer: string = edge.sourcePointer;
  const originalRef: string = edge.originalRef;
  const targetUri: string = edge.targetUri;
  const targetPointer: string = edge.targetPointer;
  const bundlePointer: string = edge.bundlePointer;
  const resolvedRef: string | undefined = edge.resolvedRef;
  const moved: boolean = edge.moved;
  const external: boolean = edge.external;
  const circular: boolean = edge.circular;
  const nodeSourceUri: string = node.sourceUri;
  const nodeSourcePointer: string = node.sourcePointer;
  const nodeBundlePointer: string = node.bundlePointer;

  void sourceUri;
  void sourcePointer;
  void originalRef;
  void targetUri;
  void targetPointer;
  void bundlePointer;
  void resolvedRef;
  void moved;
  void external;
  void circular;
  void nodeSourceUri;
  void nodeSourcePointer;
  void nodeBundlePointer;

  const parser = new $RefParser();
  const instanceResult = await parser.bundleWithProvenance("mem://root.json", { type: "object" }, {});
  void instanceResult.schema;
  void instanceResult.provenance;
}

void checkBundleWithProvenanceTypes;
