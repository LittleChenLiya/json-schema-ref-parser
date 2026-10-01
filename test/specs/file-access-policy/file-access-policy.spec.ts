import { afterAll, beforeAll, describe, expect, it } from "vitest";
import $RefParser from "../../../lib/index.js";
import fileResolver from "../../../lib/resolvers/file.js";
import { ResolverError } from "../../../lib/util/errors.js";
import { isPathWithinRoots } from "../../../lib/util/file-access-policy.js";
import type { FileInfo } from "../../../lib/types/index.js";

const isDom = typeof window !== "undefined" && typeof (window as any).document !== "undefined";

// The file access policy is enforced by the Node.js file resolver, so these
// tests only run in Node. Browser builds never read from the filesystem.
describe.skipIf(isDom)("options.resolve.file.allowedPaths (file access policy)", () => {
  let fs: typeof import("node:fs");
  let os: typeof import("node:os");
  let nodePath: typeof import("node:path");

  let tmpDir: string;
  let allowedDir: string;
  let defsDir: string;
  let evilDir: string;

  const writeJson = (file: string, value: unknown) => {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  };

  // Paths passed to $RefParser use forward slashes on every platform
  const toPosix = (p: string) => p.replace(/\\/g, "/");

  const policy = (roots: string[]) => ({ resolve: { file: { allowedPaths: roots } } }) as any;

  beforeAll(async () => {
    fs = await import("node:fs");
    os = await import("node:os");
    nodePath = await import("node:path");

    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ref-parser-policy-"));
    allowedDir = nodePath.join(tmpDir, "allowed");
    defsDir = nodePath.join(allowedDir, "defs");
    // A sibling directory whose name shares a prefix with the allowed root
    evilDir = nodePath.join(tmpDir, "allowed-evil");
    fs.mkdirSync(defsDir, { recursive: true });
    fs.mkdirSync(evilDir, { recursive: true });

    // Inside the allowed root
    writeJson(nodePath.join(defsDir, "ok.json"), { type: "string" });
    writeJson(nodePath.join(defsDir, "my schema.json"), { type: "number" });

    // Outside the allowed root
    writeJson(nodePath.join(tmpDir, "secret.json"), {
      type: "object",
      properties: { password: { type: "string" } },
    });
    writeJson(nodePath.join(evilDir, "prefix.json"), { type: "boolean" });

    // Root schemas
    writeJson(nodePath.join(allowedDir, "main-inside.json"), {
      properties: { ok: { $ref: "./defs/ok.json" } },
    });
    writeJson(nodePath.join(allowedDir, "main-escape.json"), {
      properties: { bad: { $ref: "../secret.json" } },
    });
    writeJson(nodePath.join(allowedDir, "main-encoded.json"), {
      properties: { ok: { $ref: "./defs/my%20schema.json" } },
    });
    writeJson(nodePath.join(allowedDir, "main-encoded-escape.json"), {
      properties: { bad: { $ref: "%2e%2e/secret.json" } },
    });
    writeJson(nodePath.join(allowedDir, "main-prefix.json"), {
      properties: { bad: { $ref: "../allowed-evil/prefix.json" } },
    });
    writeJson(nodePath.join(allowedDir, "main-fragment.json"), {
      definitions: { thing: { type: "integer" } },
      properties: { thing: { $ref: "#/definitions/thing" } },
    });
    writeJson(nodePath.join(allowedDir, "main-link.json"), {
      properties: { bad: { $ref: "./link-outside.json" } },
    });
  });

  afterAll(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows a $ref that stays inside the allowed root", async () => {
    const schema: any = await $RefParser.dereference(
      toPosix(nodePath.join(allowedDir, "main-inside.json")),
      policy([allowedDir]),
    );
    expect(schema.properties.ok).to.deep.equal({ type: "string" });
  });

  it("rejects a ../ $ref that escapes the allowed root", async () => {
    try {
      await $RefParser.dereference(toPosix(nodePath.join(allowedDir, "main-escape.json")), policy([allowedDir]));
      expect.fail("Expected the escape to be rejected");
    } catch (err) {
      expect(err).to.be.an.instanceOf(ResolverError);
      expect((err as Error).message).to.contain("outside of the allowed paths");
    }
  });

  it("rejects the root schema itself when it is outside the allowed root", async () => {
    try {
      await $RefParser.dereference(toPosix(nodePath.join(tmpDir, "secret.json")), policy([allowedDir]));
      expect.fail("Expected the root schema to be rejected");
    } catch (err) {
      expect(err).to.be.an.instanceOf(ResolverError);
      expect((err as Error).message).to.contain("outside of the allowed paths");
    }
  });

  it("rejects a symlink inside the allowed root that points outside of it", async () => {
    const linkPath = nodePath.join(allowedDir, "link-outside.json");
    let symlinkCreated = true;
    try {
      fs.symlinkSync(nodePath.join(tmpDir, "secret.json"), linkPath, "file");
    } catch {
      // Windows may refuse to create symlinks without elevated privileges.
      symlinkCreated = false;
    }

    if (symlinkCreated) {
      try {
        await $RefParser.dereference(toPosix(nodePath.join(allowedDir, "main-link.json")), policy([allowedDir]));
        expect.fail("Expected the symlink escape to be rejected");
      } catch (err) {
        expect(err).to.be.an.instanceOf(ResolverError);
        expect((err as Error).message).to.contain("outside of the allowed paths");
      }
    } else {
      // Controlled fixture: simulate the canonicalized (post-realpath) locations
      // exactly as the file resolver would compute them for a symlink that
      // resolves outside of the allowed root.
      const resolvedLinkTarget = nodePath.join(tmpDir, "secret.json");
      expect(isPathWithinRoots(resolvedLinkTarget, [allowedDir])).to.equal(false);
      expect(isPathWithinRoots(nodePath.join(allowedDir, "defs", "ok.json"), [allowedDir])).to.equal(true);

      // ...and verify enforcement through a controlled file resolver fixture,
      // invoking the built-in resolver directly with a policy attached.
      const file = {
        url: toPosix(nodePath.join(tmpDir, "secret.json")),
        hash: "",
        extension: ".json",
        data: "",
      } as FileInfo;
      await expect(fileResolver.read.call({ allowedPaths: [allowedDir] }, file)).rejects.toBeInstanceOf(ResolverError);
      const allowedFile = { ...file, url: toPosix(nodePath.join(defsDir, "ok.json")) } as FileInfo;
      const contents = await fileResolver.read.call({ allowedPaths: [allowedDir] }, allowedFile);
      expect(JSON.parse(contents.toString())).to.deep.equal({ type: "string" });
    }
  });

  it("resolves URL-encoded paths inside the root and rejects encoded traversal", async () => {
    const schema: any = await $RefParser.dereference(
      toPosix(nodePath.join(allowedDir, "main-encoded.json")),
      policy([allowedDir]),
    );
    expect(schema.properties.ok).to.deep.equal({ type: "number" });

    try {
      await $RefParser.dereference(
        toPosix(nodePath.join(allowedDir, "main-encoded-escape.json")),
        policy([allowedDir]),
      );
      expect.fail("Expected the encoded escape to be rejected");
    } catch (err) {
      expect(err).to.be.an.instanceOf(ResolverError);
      expect((err as Error).message).to.contain("outside of the allowed paths");
    }
  });

  it("rejects a sibling directory that only shares a name prefix with the allowed root", async () => {
    try {
      await $RefParser.dereference(toPosix(nodePath.join(allowedDir, "main-prefix.json")), policy([allowedDir]));
      expect.fail("Expected the prefix-sibling escape to be rejected");
    } catch (err) {
      expect(err).to.be.an.instanceOf(ResolverError);
      expect((err as Error).message).to.contain("outside of the allowed paths");
    }
  });

  it("allows pure fragment $refs without touching the filesystem policy", async () => {
    const schema: any = await $RefParser.dereference(
      toPosix(nodePath.join(allowedDir, "main-fragment.json")),
      policy([allowedDir]),
    );
    expect(schema.properties.thing).to.deep.equal({ type: "integer" });
  });

  it("applies the policy per parse: a wide policy succeeds where a narrow one rejects", async () => {
    const mainPrefix = toPosix(nodePath.join(allowedDir, "main-prefix.json"));

    // Wide: the whole temp dir is allowed, so the sibling directory is readable
    const wide: any = await $RefParser.dereference(mainPrefix, policy([tmpDir]));
    expect(wide.properties.bad).to.deep.equal({ type: "boolean" });

    // Narrow: only "allowed/" is permitted, so the same $ref is now rejected
    try {
      await $RefParser.dereference(mainPrefix, policy([allowedDir]));
      expect.fail("Expected the narrow policy to reject the same $ref");
    } catch (err) {
      expect(err).to.be.an.instanceOf(ResolverError);
      expect((err as Error).message).to.contain("outside of the allowed paths");
    }
  });
});
