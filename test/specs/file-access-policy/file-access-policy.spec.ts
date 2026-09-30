import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";
import $RefParser from "../../../lib/index.js";
import { FileAccessDeniedError } from "../../../lib/util/errors.js";
import { assertFileAllowed, isPathInsideRoot, resolvePhysicalPath } from "../../../lib/util/file-access-policy.js";
import type { LinkReader } from "../../../lib/util/file-access-policy.js";

interface TempTree {
  root: string;
}

async function makeTempTree(): Promise<TempTree> {
  const base = await fs.mkdtemp(nodePath.join(os.tmpdir(), "ref-parser-policy-"));
  const root = nodePath.join(base, "allowed");
  const outside = nodePath.join(base, "secret");
  await fs.mkdir(nodePath.join(root, "sub", "nested"), { recursive: true });
  await fs.mkdir(nodePath.join(root, "app"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  await fs.writeFile(
    nodePath.join(root, "main.json"),
    JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        inside: { $ref: "sub/nested/thing.json" },
        outside: { $ref: "../secret/thing.json" },
      },
    }),
  );
  await fs.writeFile(
    nodePath.join(root, "inside-main.json"),
    JSON.stringify({ type: "object", properties: { v: { $ref: "sub/nested/thing.json" } } }),
  );
  await fs.writeFile(
    nodePath.join(root, "outside-main.json"),
    JSON.stringify({ type: "object", properties: { v: { $ref: "../secret/thing.json" } } }),
  );
  await fs.writeFile(
    nodePath.join(root, "sub", "nested", "thing.json"),
    JSON.stringify({ type: "string", title: "inside-thing" }),
  );
  await fs.writeFile(nodePath.join(outside, "thing.json"), JSON.stringify({ type: "string", title: "outside-secret" }));

  // URL-encoded space in a directory name: encoded refs must be decoded to the real file.
  await fs.mkdir(nodePath.join(root, "with space"), { recursive: true });
  await fs.writeFile(
    nodePath.join(root, "with space", "encoded.json"),
    JSON.stringify({ type: "integer", title: "encoded-ok" }),
  );
  await fs.writeFile(
    nodePath.join(root, "encoded-main.json"),
    JSON.stringify({ type: "object", properties: { v: { $ref: "with%20space/encoded.json" } } }),
  );
  // "%2e%2e" decodes to "..": an encoded traversal attempt must still be rejected.
  await fs.writeFile(
    nodePath.join(root, "encoded-escape.json"),
    JSON.stringify({ type: "object", properties: { v: { $ref: "%2e%2e/secret/thing.json" } } }),
  );

  // Similar-prefix sibling directory must not be mistaken for the allowed root.
  await fs.mkdir(nodePath.join(base, "allowed-other"), { recursive: true });
  await fs.writeFile(
    nodePath.join(base, "allowed-other", "lookalike.json"),
    JSON.stringify({ type: "string", title: "lookalike" }),
  );
  await fs.writeFile(
    nodePath.join(root, "app", "start.json"),
    JSON.stringify({ type: "object", properties: { v: { $ref: "../../allowed-other/lookalike.json" } } }),
  );

  // Pure fragment references never open another file.
  await fs.writeFile(
    nodePath.join(root, "fragment.json"),
    JSON.stringify({
      type: "object",
      definitions: { name: { type: "string" } },
      properties: { name: { $ref: "#/definitions/name" } },
    }),
  );

  // Files for the wide-then-narrow resolution check.
  await fs.writeFile(
    nodePath.join(root, "wide.json"),
    JSON.stringify({ type: "object", properties: { v: { $ref: "../secret/thing.json" } } }),
  );
  await fs.writeFile(
    nodePath.join(root, "narrow-main.json"),
    JSON.stringify({ type: "object", properties: { v: { $ref: "app/start.json" } } }),
  );

  return { root };
}

async function rmrf(target: string) {
  await fs.rm(target, { recursive: true, force: true });
}

describe("resolve.file.allowedRoots", () => {
  let tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rmrf(nodePath.dirname(root))));
  });

  it("allows a relative ref that stays inside the root and rejects a ../ escape", async () => {
    const { root } = await makeTempTree();
    tempRoots.push(root);

    const allowedInside = await $RefParser.resolve(nodePath.join(root, "inside-main.json"), {
      resolve: { file: { allowedRoots: [root] } },
    });
    expect(allowedInside.exists("sub/nested/thing.json")).toBe(true);
    expect(allowedInside.get("sub/nested/thing.json#/title")).toBe("inside-thing");

    await expect(
      $RefParser.resolve(nodePath.join(root, "outside-main.json"), {
        resolve: { file: { allowedRoots: [root] } },
      }),
    ).rejects.toMatchObject({
      name: "FileAccessDeniedError",
      code: "EFILEACCESS",
      allowedRoots: [nodePath.resolve(root)],
    });
  });

  it("decodes URL-encoded paths before applying the boundary", async () => {
    const { root } = await makeTempTree();
    tempRoots.push(root);

    const ok = await $RefParser.resolve(nodePath.join(root, "encoded-main.json"), {
      resolve: { file: { allowedRoots: [root] } },
    });
    expect(ok.get("with space/encoded.json#/title")).toBe("encoded-ok");

    await expect(
      $RefParser.resolve(nodePath.join(root, "encoded-escape.json"), {
        resolve: { file: { allowedRoots: [root] } },
      }),
    ).rejects.toBeInstanceOf(FileAccessDeniedError);
  });

  it("does not treat a similar directory-name prefix as inside the root", async () => {
    const { root } = await makeTempTree();
    tempRoots.push(root);

    await expect(
      $RefParser.resolve(nodePath.join(root, "app", "start.json"), {
        resolve: { file: { allowedRoots: [root] } },
      }),
    ).rejects.toBeInstanceOf(FileAccessDeniedError);
  });

  it("allows pure-fragment references without opening another file", async () => {
    const { root } = await makeTempTree();
    tempRoots.push(root);

    const schema = await $RefParser.dereference(nodePath.join(root, "fragment.json"), {
      resolve: { file: { allowedRoots: [root] } },
    });
    expect(schema.properties.name.type).toBe("string");
  });

  it("supports first-wide then second-narrow allowlists across two parses", async () => {
    const { root } = await makeTempTree();
    tempRoots.push(root);
    const parent = nodePath.dirname(root);

    // Wide: allowing the temp parent includes the secret sibling directory.
    const wide = await $RefParser.resolve(nodePath.join(root, "wide.json"), {
      resolve: { file: { allowedRoots: [parent] } },
    });
    expect(wide.get("../secret/thing.json#/title")).toBe("outside-secret");

    // Narrow: a second, independent parse with only the root must reject the same escape.
    await expect(
      $RefParser.resolve(nodePath.join(root, "wide.json"), {
        resolve: { file: { allowedRoots: [root] } },
      }),
    ).rejects.toBeInstanceOf(FileAccessDeniedError);
  });

  it("accepts allowedRoots as a single directory string", async () => {
    const { root } = await makeTempTree();
    tempRoots.push(root);

    const refs = await $RefParser.resolve(nodePath.join(root, "inside-main.json"), {
      resolve: { file: { allowedRoots: root } },
    });
    expect(refs.exists("sub/nested/thing.json")).toBe(true);
  });

  it("rejects links that point outside the root via a controllable readLink fixture", async () => {
    const { root } = await makeTempTree();
    tempRoots.push(root);
    const linkPath = nodePath.join(root, "link-to-secret");
    const outsideFile = nodePath.join(nodePath.dirname(root), "secret", "thing.json");
    const insideFile = nodePath.join(root, "sub", "nested", "thing.json");
    await fs.writeFile(
      nodePath.join(root, "link-main.json"),
      JSON.stringify({ type: "object", properties: { v: { $ref: "link-to-secret" } } }),
    );

    // Controlled fixture: no real symlink is created; assertFileAllowed is told the link's
    // target through the readLink hook. This deterministically covers the link-escape
    // boundary on every platform, including Windows where creating real links may be
    // unavailable. It runs before any read, so the missing physical link is irrelevant.
    const outsideReader: LinkReader = (candidate) =>
      nodePath.resolve(candidate) === nodePath.resolve(linkPath) ? outsideFile : undefined;
    await expect(assertFileAllowed(linkPath, [root], { readLink: outsideReader })).rejects.toBeInstanceOf(
      FileAccessDeniedError,
    );

    // A link whose target stays inside the root is allowed.
    const insideReader: LinkReader = (candidate) =>
      nodePath.resolve(candidate) === nodePath.resolve(linkPath) ? insideFile : undefined;
    await assertFileAllowed(linkPath, [root], { readLink: insideReader });
  });

  it("rejects real symlinks/junctions pointing outside the root when link creation is available", async () => {
    const { root } = await makeTempTree();
    tempRoots.push(root);
    const linkPath = nodePath.join(root, "real-link");
    const outsideTarget = nodePath.join(nodePath.dirname(root), "secret");
    await fs.writeFile(
      nodePath.join(root, "real-link-main.json"),
      JSON.stringify({ type: "object", properties: { v: { $ref: "real-link/thing.json" } } }),
    );

    let linkCreated = false;
    if (process.platform === "win32") {
      // Directory junctions do not require elevated privileges on Windows, unlike symlinks.
      try {
        await fs.symlink(outsideTarget, linkPath, "junction");
        linkCreated = true;
      } catch {
        // Fall through to the virtual readLink fixture below.
      }
    } else {
      try {
        await fs.symlink(outsideTarget, linkPath, "dir");
        linkCreated = true;
      } catch {
        return; // environment forbids link creation; the virtual fixture covers this case
      }
    }
    if (!linkCreated) return;

    await expect(
      $RefParser.resolve(nodePath.join(root, "real-link-main.json"), {
        resolve: { file: { allowedRoots: [root] } },
      }),
    ).rejects.toBeInstanceOf(FileAccessDeniedError);
  });

  it("leaves reads unrestricted when allowedRoots is not configured", async () => {
    const { root } = await makeTempTree();
    tempRoots.push(root);

    const refs = await $RefParser.resolve(nodePath.join(root, "wide.json"));
    expect(refs.get("../secret/thing.json#/title")).toBe("outside-secret");
  });
});

describe("file access policy helpers", () => {
  it("compares path segments for the root boundary", () => {
    const root = nodePath.join(nodePath.sep, "srv", "app");
    expect(isPathInsideRoot(nodePath.join(root, "a", "b.json"), root)).toBe(true);
    expect(isPathInsideRoot(root, root)).toBe(true);
    expect(isPathInsideRoot(nodePath.join(nodePath.sep, "srv", "application", "x.json"), root)).toBe(false);
    expect(isPathInsideRoot(nodePath.join(nodePath.sep, "srv", "app2", "x.json"), root)).toBe(false);
  });

  it("follows a virtual link chain and resolves relative targets", async () => {
    const dir = nodePath.resolve("data", "allowed");
    const links = new Map<string, string>([
      [nodePath.join(dir, "link"), "target.json"],
      [nodePath.join(dir, "target.json"), nodePath.resolve("data", "elsewhere", "real.json")],
    ]);
    const readLink: LinkReader = (candidate) => links.get(nodePath.resolve(candidate));

    const physical = await resolvePhysicalPath(nodePath.join(dir, "link"), readLink);
    expect(physical).toBe(nodePath.resolve("data", "elsewhere", "real.json"));
    expect(isPathInsideRoot(physical, dir)).toBe(false);
  });

  it("keeps a non-existent path at its normalized lexical location", async () => {
    const dir = nodePath.resolve("data", "allowed");
    const physical = await resolvePhysicalPath(nodePath.join(dir, "sub", "..", "missing.json"), async () => undefined);
    expect(physical).toBe(nodePath.join(dir, "missing.json"));
  });
});
