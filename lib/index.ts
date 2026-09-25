import $Refs from "./refs.js";
import _parse from "./parse.js";
import normalizeArgs from "./normalize-args.js";
import type { NormalizedArguments } from "./normalize-args.js";
import resolveExternal from "./resolve-external.js";
import _bundle from "./bundle.js";
import { createBundleProvenance } from "./bundle.js";
import type { BundleProvenance, BundleProvenanceEdge, BundleProvenanceNode } from "./bundle.js";
import _dereference from "./dereference.js";
import * as url from "./util/url.js";
import FileResolver from "./resolvers/file.js";
import HTTPResolver from "./resolvers/http.js";
import {
  JSONParserError,
  InvalidPointerError,
  MissingPointerError,
  ResolverError,
  ParserError,
  UnmatchedParserError,
  UnmatchedResolverError,
  isHandledError,
  JSONParserErrorGroup,
} from "./util/errors.js";
import maybe from "./util/maybe.js";
import { getSchemaIdMode, registerSchemaResources, usesDynamicIdScope } from "./util/schema-resources.js";
import type { ExcludedPathMatcher, Options, ParserOptions } from "./options.js";
import { getJsonSchemaRefParserDefaultOptions } from "./options.js";
import type {
  $RefsCallback,
  JSONSchema,
  SchemaCallback,
  FileInfo,
  Plugin,
  ResolverOptions,
  HTTPResolverOptions,
} from "./types/index.js";
import { isUnsafeUrl } from "./util/url.js";

export type RefParserSchema = string | JSONSchema | boolean;

/**
 * The result of {@link $RefParser.bundleWithProvenance}: the bundled schema plus the
 * provenance that maps every moved-in node and every rewritten reference edge back to
 * its original document URI and JSON Pointer.
 */
export interface BundleWithProvenanceResult<S extends object = JSONSchema> {
  /** The bundled schema. Only internal `$ref` pointers remain. */
  schema: S;
  /** The source/target mapping of every moved-in node and rewritten reference edge. */
  provenance: BundleProvenance;
}

/**
 * This class parses a JSON schema, builds a map of its JSON references and their resolved values,
 * and provides methods for traversing, manipulating, and dereferencing those references.
 *
 * @class
 */
export class $RefParser<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>> {
  /**
   * The parsed (and possibly dereferenced) JSON schema object
   *
   * @type {object}
   * @readonly
   */
  public schema: S | boolean | null = null;

  /**
   * The resolved JSON references
   *
   * @type {$Refs}
   * @readonly
   */
  $refs = new $Refs<S, O>();

  /**
   * Parses the given JSON schema.
   * This method does not resolve any JSON references.
   * It just reads a single file in JSON or YAML format, and parse it as a JavaScript object.
   *
   * @param [path] - The file path or URL of the JSON schema
   * @param [schema] - A JSON schema object. This object will be used instead of reading from `path`.
   * @param [options] - Options that determine how the schema is parsed
   * @param [callback] - An error-first callback. The second parameter is the parsed JSON schema object.
   * @returns - The returned promise resolves with the parsed JSON schema object.
   */
  public parse(schema: boolean, options?: O): Promise<boolean>;
  public parse(path: string, schema: boolean, options: O): Promise<boolean>;
  public parse(schema: S | string | unknown): Promise<S>;
  public parse(schema: S | string | unknown, callback: SchemaCallback<S>): Promise<void>;
  public parse(schema: S | string | unknown, options: O): Promise<S>;
  public parse(schema: S | string | unknown, options: O, callback: SchemaCallback<S>): Promise<void>;
  public parse(path: string, schema: S | string | unknown, options: O): Promise<S>;
  public parse(path: string, schema: S | string | unknown, options: O, callback: SchemaCallback<S>): Promise<void>;
  async parse() {
    let args: NormalizedArguments<S, O>;
    try {
      args = normalizeArgs<S, O>(arguments);
    } catch (err) {
      return rejectNormalizationError<S | boolean>(arguments, err);
    }
    let promise;

    const hasSchema = args.schema !== undefined && args.schema !== null;
    if (!args.path && !hasSchema) {
      const err = new Error(`Expected a file path, URL, or object. Got ${args.path || args.schema}`);
      return maybe(args.callback, Promise.reject(err));
    }

    // Reset everything
    this.schema = null;
    this.$refs = new $Refs();

    // If the path is a filesystem path, then convert it to a URL.
    // NOTE: According to the JSON Reference spec, these should already be URLs,
    // but, in practice, many people use local filesystem paths instead.
    // So we're being generous here and doing the conversion automatically.
    // This is not intended to be a 100% bulletproof solution.
    // If it doesn't work for your use-case, then use a URL instead.
    let pathType = "http";
    if (url.isFileSystemPath(args.path)) {
      args.path = url.fromFileSystemPath(args.path);
      pathType = "file";
    }

    // Resolve the absolute path of the schema
    args.path = url.resolve(url.cwd(), args.path);

    if (hasSchema && (typeof args.schema === "object" || typeof args.schema === "boolean")) {
      // A schema object was passed-in.
      // So immediately add a new $Ref with the schema object as its value
      const $ref = this.$refs._add(args.path);
      $ref.value = args.schema;
      $ref.pathType = pathType;
      $ref.dynamicIdScope = usesDynamicIdScope($ref.value);
      $ref.legacyIdScope = getSchemaIdMode($ref.value);
      registerSchemaResources(this.$refs, $ref.path!, $ref.value, $ref.pathType, $ref.dynamicIdScope);
      promise = Promise.resolve(args.schema);
    } else {
      // Parse the schema file/url
      promise = _parse<S, typeof args.options>(args.path, this.$refs, args.options);
    }

    try {
      const result = await promise;

      if (typeof result === "boolean" || (result !== null && typeof result === "object" && !Buffer.isBuffer(result))) {
        this.schema = result;
        return maybe(args.callback, Promise.resolve(this.schema!));
      } else if (args.options.continueOnError) {
        this.schema = null; // it's already set to null at line 79, but let's set it again for the sake of readability
        return maybe(args.callback, Promise.resolve(this.schema!));
      } else {
        throw new SyntaxError(`"${this.$refs._root$Ref.path || result}" is not a valid JSON Schema`);
      }
    } catch (err) {
      if (!args.options.continueOnError || !isHandledError(err)) {
        return maybe(args.callback, Promise.reject(err));
      }

      if (this.$refs._$refs[url.stripHash(args.path)]) {
        this.$refs._$refs[url.stripHash(args.path)].addError(err);
      }

      return maybe(args.callback, Promise.resolve(null));
    }
  }

  public static parse<O extends ParserOptions<JSONSchema> = ParserOptions<JSONSchema>>(
    schema: boolean,
    options?: O,
  ): Promise<boolean>;
  public static parse<O extends ParserOptions<JSONSchema> = ParserOptions<JSONSchema>>(
    path: string,
    schema: boolean,
    options: O,
  ): Promise<boolean>;
  public static parse<S extends object = JSONSchema>(schema: S | string | unknown): Promise<S>;
  public static parse<S extends object = JSONSchema>(
    schema: S | string | unknown,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  public static parse<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    options: O,
  ): Promise<S>;
  public static parse<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    options: O,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  public static parse<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    path: string,
    schema: S | string | unknown,
    options: O,
  ): Promise<S>;
  public static parse<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    path: string,
    schema: S | string | unknown,
    options: O,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  public static parse<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>():
    | Promise<S>
    | Promise<void> {
    const parser = new $RefParser<S, O>();
    return parser.parse.apply(parser, arguments as any);
  }

  /**
   * *This method is used internally by other methods, such as `bundle` and `dereference`. You probably won't need to call this method yourself.*
   *
   * Resolves all JSON references (`$ref` pointers) in the given JSON Schema file. If it references any other files/URLs, then they will be downloaded and resolved as well. This method **does not** dereference anything. It simply gives you a `$Refs` object, which is a map of all the resolved references and their values.
   *
   * See https://apidevtools.com/json-schema-ref-parser/docs/ref-parser.html#resolveschema-options-callback
   *
   * @param schema A JSON Schema object, or the file path or URL of a JSON Schema file. See the `parse` method for more info.
   * @param options (optional)
   * @param callback (optional) A callback that will receive a `$Refs` object
   */
  public resolve(schema: S | string | unknown): Promise<$Refs<S, O>>;
  public resolve(schema: S | string | unknown, callback: $RefsCallback<S, O>): Promise<void>;
  public resolve(schema: S | string | unknown, options: O): Promise<$Refs<S, O>>;
  public resolve(schema: S | string | unknown, options: O, callback: $RefsCallback<S, O>): Promise<void>;
  public resolve(path: string, schema: S | string | unknown, options: O): Promise<$Refs<S, O>>;
  public resolve(path: string, schema: S | string | unknown, options: O, callback: $RefsCallback<S, O>): Promise<void>;
  async resolve() {
    let args: NormalizedArguments<S, O>;
    try {
      args = normalizeArgs<S, O>(arguments, false);
    } catch (err) {
      return rejectNormalizationError<$Refs<S, O>>(arguments, err);
    }

    try {
      await this.parse(args.path, args.schema, args.options);
      await resolveExternal(this, args.options);
      finalize(this);
      return maybe(args.callback, Promise.resolve(this.$refs));
    } catch (err) {
      return maybe(args.callback, Promise.reject(err));
    }
  }

  /**
   * *This method is used internally by other methods, such as `bundle` and `dereference`. You probably won't need to call this method yourself.*
   *
   * Resolves all JSON references (`$ref` pointers) in the given JSON Schema file. If it references any other files/URLs, then they will be downloaded and resolved as well. This method **does not** dereference anything. It simply gives you a `$Refs` object, which is a map of all the resolved references and their values.
   *
   * See https://apidevtools.com/json-schema-ref-parser/docs/ref-parser.html#resolveschema-options-callback
   *
   * @param schema A JSON Schema object, or the file path or URL of a JSON Schema file. See the `parse` method for more info.
   * @param options (optional)
   * @param callback (optional) A callback that will receive a `$Refs` object
   */
  public static resolve<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
  ): Promise<$Refs<S, O>>;
  public static resolve<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    callback: $RefsCallback<S, O>,
  ): Promise<void>;
  public static resolve<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    options: O,
  ): Promise<$Refs<S, O>>;
  public static resolve<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    options: O,
    callback: $RefsCallback<S, O>,
  ): Promise<void>;
  public static resolve<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    path: string,
    schema: S | string | unknown,
    options: O,
  ): Promise<$Refs<S, O>>;
  public static resolve<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    path: string,
    schema: S | string | unknown,
    options: O,
    callback: $RefsCallback<S, O>,
  ): Promise<void>;
  static resolve<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>():
    | Promise<S>
    | Promise<void> {
    const instance = new $RefParser<S, O>();
    return instance.resolve.apply(instance, arguments as any);
  }

  /**
   * Bundles all referenced files/URLs into a single schema that only has internal `$ref` pointers. This lets you split-up your schema however you want while you're building it, but easily combine all those files together when it's time to package or distribute the schema to other people. The resulting schema size will be small, since it will still contain internal JSON references rather than being fully-dereferenced.
   *
   * This also eliminates the risk of circular references, so the schema can be safely serialized using `JSON.stringify()`.
   *
   * See https://apidevtools.com/json-schema-ref-parser/docs/ref-parser.html#bundleschema-options-callback
   *
   * @param schema A JSON Schema object, or the file path or URL of a JSON Schema file. See the `parse` method for more info.
   * @param options (optional)
   * @param callback (optional) A callback that will receive the bundled schema object
   */
  public static bundle<O extends ParserOptions<JSONSchema> = ParserOptions<JSONSchema>>(
    schema: boolean,
    options?: O,
  ): Promise<boolean>;
  public static bundle<O extends ParserOptions<JSONSchema> = ParserOptions<JSONSchema>>(
    path: string,
    schema: boolean,
    options: O,
  ): Promise<boolean>;
  public static bundle<S extends object = JSONSchema>(schema: S | string | unknown): Promise<S>;
  public static bundle<S extends object = JSONSchema>(
    schema: S | string | unknown,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  public static bundle<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    options: O,
  ): Promise<S>;
  public static bundle<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    options: O,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  public static bundle<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    path: string,
    schema: S | string | unknown,
    options: O,
  ): Promise<S>;
  public static bundle<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    path: string,
    schema: S | string | unknown,
    options: O,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  static bundle<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>():
    | Promise<S>
    | Promise<boolean>
    | Promise<void> {
    const instance = new $RefParser<S, O>();
    return instance.bundle.apply(instance, arguments as any);
  }

  /**
   * Bundles all referenced files/URLs into a single schema that only has internal `$ref` pointers. This lets you split-up your schema however you want while you're building it, but easily combine all those files together when it's time to package or distribute the schema to other people. The resulting schema size will be small, since it will still contain internal JSON references rather than being fully-dereferenced.
   *
   * This also eliminates the risk of circular references, so the schema can be safely serialized using `JSON.stringify()`.
   *
   * See https://apidevtools.com/json-schema-ref-parser/docs/ref-parser.html#bundleschema-options-callback
   *
   * @param schema A JSON Schema object, or the file path or URL of a JSON Schema file. See the `parse` method for more info.
   * @param options (optional)
   * @param callback (optional) A callback that will receive the bundled schema object
   */
  public bundle(schema: boolean, options?: O): Promise<boolean>;
  public bundle(path: string, schema: boolean, options: O): Promise<boolean>;
  public bundle(schema: S | string | unknown): Promise<S>;
  public bundle(schema: S | string | unknown, callback: SchemaCallback<S>): Promise<void>;
  public bundle(schema: S | string | unknown, options: O): Promise<S>;
  public bundle(schema: S | string | unknown, options: O, callback: SchemaCallback<S>): Promise<void>;
  public bundle(path: string, schema: S | string | unknown, options: O): Promise<S>;
  public bundle(path: string, schema: S | string | unknown, options: O, callback: SchemaCallback<S>): Promise<void>;
  async bundle(): Promise<S | boolean | void> {
    let args: NormalizedArguments<S, O>;
    try {
      args = normalizeArgs<S, O>(arguments, false);
    } catch (err) {
      return rejectNormalizationError<S | boolean>(arguments, err);
    }
    try {
      await this.resolve(args.path, args.schema, args.options);
      _bundle<S, O>(this, args.options);
      finalize(this);
      return maybe(args.callback, Promise.resolve(this.schema!)) as Promise<S | boolean | void>;
    } catch (err) {
      return maybe(args.callback, Promise.reject(err)) as Promise<S | boolean | void>;
    }
  }

  /**
   * Bundles all referenced files/URLs into a single schema (like {@link $RefParser#bundle}),
   * and additionally returns the provenance of the bundle: for every node that was moved into
   * the bundled document, its original document URI, its original JSON Pointer, and its final
   * JSON Pointer; and for every reference edge (`$ref` occurrence), its original location and
   * its rewritten target. When the same external node is referenced from several places, it is
   * moved into the bundle exactly once, but each reference edge keeps its own source mapping.
   *
   * Differences from {@link $RefParser#bundle}:
   *
   * - The input schema is never modified (`mutateInputSchema` defaults to `false`).
   * - Only caller-provided resolvers are used. The built-in `file` and `http` resolvers are
   *   disabled unless explicitly re-enabled via `options.resolve.file` / `options.resolve.http`,
   *   so a relative URI can never silently trigger a filesystem or network read.
   * - Resolution errors are annotated with the URI and JSON Pointer of the original `$ref`
   *   that caused them.
   *
   * @param schema A JSON Schema object, or the file path or URL of a JSON Schema file. See the `parse` method for more info.
   * @param options (optional)
   */
  public bundleWithProvenance(schema: S | string | unknown): Promise<BundleWithProvenanceResult<S>>;
  public bundleWithProvenance(schema: S | string | unknown, options: O): Promise<BundleWithProvenanceResult<S>>;
  public bundleWithProvenance(
    path: string,
    schema: S | string | unknown,
    options: O,
  ): Promise<BundleWithProvenanceResult<S>>;
  async bundleWithProvenance(): Promise<BundleWithProvenanceResult<S>> {
    const explicitOptions = findExplicitOptionsArgument(arguments);
    let args: NormalizedArguments<S, O>;
    try {
      args = normalizeArgs<S, O>(arguments, false);
    } catch (err) {
      return Promise.reject(err);
    }
    try {
      applyBundleWithProvenanceDefaults(args.options, explicitOptions);
      await this.resolve(args.path, args.schema, args.options);
      const provenance = createBundleProvenance();
      _bundle<S, O>(this, args.options, provenance);
      finalize(this);
      return { schema: this.schema as S, provenance };
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Bundles all referenced files/URLs into a single schema (like {@link $RefParser.bundle}),
   * and additionally returns the provenance of the bundle. See the instance method
   * {@link $RefParser#bundleWithProvenance} for details.
   *
   * @param schema A JSON Schema object, or the file path or URL of a JSON Schema file. See the `parse` method for more info.
   * @param options (optional)
   */
  public static bundleWithProvenance<S extends object = JSONSchema>(
    schema: S | string | unknown,
  ): Promise<BundleWithProvenanceResult<S>>;
  public static bundleWithProvenance<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    options: O,
  ): Promise<BundleWithProvenanceResult<S>>;
  public static bundleWithProvenance<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    path: string,
    schema: S | string | unknown,
    options: O,
  ): Promise<BundleWithProvenanceResult<S>>;
  static bundleWithProvenance<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>():
    | Promise<BundleWithProvenanceResult<S>>
    | Promise<void> {
    const instance = new $RefParser<S, O>();
    return instance.bundleWithProvenance.apply(instance, arguments as any);
  }

  /**
   * Dereferences all `$ref` pointers in the JSON Schema, replacing each reference with its resolved value. This results in a schema object that does not contain any `$ref` pointers. Instead, it's a normal JavaScript object tree that can easily be crawled and used just like any other JavaScript object. This is great for programmatic usage, especially when using tools that don't understand JSON references.
   *
   * The dereference method maintains object reference equality, meaning that all `$ref` pointers that point to the same object will be replaced with references to the same object. Again, this is great for programmatic usage, but it does introduce the risk of circular references, so be careful if you intend to serialize the schema using `JSON.stringify()`. Consider using the bundle method instead, which does not create circular references.
   *
   * See https://apidevtools.com/json-schema-ref-parser/docs/ref-parser.html#dereferenceschema-options-callback
   *
   * @param schema A JSON Schema object, or the file path or URL of a JSON Schema file. See the `parse` method for more info.
   * @param options (optional)
   * @param callback (optional) A callback that will receive the dereferenced schema object
   */
  public static dereference<O extends ParserOptions<JSONSchema> = ParserOptions<JSONSchema>>(
    schema: boolean,
    options?: O,
  ): Promise<boolean>;
  public static dereference<O extends ParserOptions<JSONSchema> = ParserOptions<JSONSchema>>(
    path: string,
    schema: boolean,
    options: O,
  ): Promise<boolean>;
  public static dereference<S extends object = JSONSchema>(schema: S | string | unknown): Promise<S>;
  public static dereference<S extends object = JSONSchema>(
    schema: S | string | unknown,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  public static dereference<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    options: O,
  ): Promise<S>;
  public static dereference<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    schema: S | string | unknown,
    options: O,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  public static dereference<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    path: string,
    schema: S | string | unknown,
    options: O,
  ): Promise<S>;
  public static dereference<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
    path: string,
    schema: S | string | unknown,
    options: O,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  static dereference<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>():
    | Promise<S>
    | Promise<boolean>
    | Promise<void> {
    const instance = new $RefParser<S, O>();
    return instance.dereference.apply(instance, arguments as any);
  }

  /**
   * Dereferences all `$ref` pointers in the JSON Schema, replacing each reference with its resolved value. This results in a schema object that does not contain any `$ref` pointers. Instead, it's a normal JavaScript object tree that can easily be crawled and used just like any other JavaScript object. This is great for programmatic usage, especially when using tools that don't understand JSON references.
   *
   * The dereference method maintains object reference equality, meaning that all `$ref` pointers that point to the same object will be replaced with references to the same object. Again, this is great for programmatic usage, but it does introduce the risk of circular references, so be careful if you intend to serialize the schema using `JSON.stringify()`. Consider using the bundle method instead, which does not create circular references.
   *
   * See https://apidevtools.com/json-schema-ref-parser/docs/ref-parser.html#dereferenceschema-options-callback
   *
   * @param path
   * @param schema A JSON Schema object, or the file path or URL of a JSON Schema file. See the `parse` method for more info.
   * @param options (optional)
   * @param callback (optional) A callback that will receive the dereferenced schema object
   */
  public dereference(schema: boolean, options?: O): Promise<boolean>;
  public dereference(path: string, schema: boolean, options: O): Promise<boolean>;
  public dereference(
    path: string,
    schema: S | string | unknown,
    options: O,
    callback: SchemaCallback<S>,
  ): Promise<void>;
  public dereference(schema: S | string | unknown, options: O, callback: SchemaCallback<S>): Promise<void>;
  public dereference(schema: S | string | unknown, callback: SchemaCallback<S>): Promise<void>;
  public dereference(path: string, schema: S | string | unknown, options: O): Promise<S>;
  public dereference(schema: S | string | unknown, options: O): Promise<S>;
  public dereference(schema: S | string | unknown): Promise<S>;
  async dereference(): Promise<S | boolean | void> {
    let args: NormalizedArguments<S, O>;
    try {
      args = normalizeArgs<S, O>(arguments, false);
    } catch (err) {
      return rejectNormalizationError<S | boolean>(arguments, err);
    }

    try {
      await this.resolve(args.path, args.schema, args.options);
      _dereference(this, args.options);
      finalize(this);
      return maybe(args.callback, Promise.resolve(this.schema!)) as Promise<S | boolean | void>;
    } catch (err) {
      return maybe(args.callback, Promise.reject(err)) as Promise<S | boolean | void>;
    }
  }
}
export default $RefParser;

function rejectNormalizationError<T>(args: IArguments, err: unknown): Promise<T> | void {
  const callback = args[args.length - 1];
  return maybe<T>(typeof callback === "function" ? callback : undefined, Promise.reject(err));
}

/**
 * Returns the options object exactly as passed by the caller, before defaults are merged in.
 * This lets `bundleWithProvenance` tell apart "caller did not configure this" from
 * "caller explicitly enabled this".
 */
function findExplicitOptionsArgument(args: IArguments | Partial<IArguments>): any {
  const argv = Array.prototype.slice.call(args) as any[];
  if (typeof argv[argv.length - 1] === "function") {
    argv.pop();
  }
  if (typeof argv[0] === "string") {
    return typeof argv[2] === "object" ? argv[2] : argv[1];
  }
  return argv[1];
}

/**
 * Applies the `bundleWithProvenance` defaults: never mutate the caller's input, and never
 * silently fall back to the built-in filesystem or HTTP resolvers. Anything the caller
 * configured explicitly is left untouched.
 */
function applyBundleWithProvenanceDefaults<S extends object>(options: Options<S>, explicitOptions: any) {
  const explicit = explicitOptions && typeof explicitOptions === "object" ? explicitOptions : {};
  if (explicit.mutateInputSchema === undefined) {
    options.mutateInputSchema = false;
  }
  const explicitResolve = explicit.resolve && typeof explicit.resolve === "object" ? explicit.resolve : {};
  if (!("file" in explicitResolve)) {
    options.resolve.file = false;
  }
  if (!("http" in explicitResolve)) {
    options.resolve.http = false;
  }
}

function finalize<S extends object = JSONSchema, O extends ParserOptions<S> = ParserOptions<S>>(
  parser: $RefParser<S, O>,
) {
  const errors = JSONParserErrorGroup.getParserErrors(parser);
  if (errors.length > 0) {
    throw new JSONParserErrorGroup(parser);
  }
}

export const parse = $RefParser.parse;
export const resolve = $RefParser.resolve;
export const bundle = $RefParser.bundle;
export const bundleWithProvenance = $RefParser.bundleWithProvenance;
export const dereference = $RefParser.dereference;

export {
  UnmatchedResolverError,
  JSONParserError,
  JSONSchema,
  InvalidPointerError,
  MissingPointerError,
  ResolverError,
  ParserError,
  UnmatchedParserError,
  ParserOptions,
  ExcludedPathMatcher,
  BundleProvenance,
  BundleProvenanceEdge,
  BundleProvenanceNode,
  $RefsCallback,
  isHandledError,
  JSONParserErrorGroup,
  SchemaCallback,
  FileInfo,
  Plugin,
  ResolverOptions,
  HTTPResolverOptions,
  _dereference as dereferenceInternal,
  normalizeArgs as jsonSchemaParserNormalizeArgs,
  getJsonSchemaRefParserDefaultOptions,
  $Refs,
  isUnsafeUrl,
  FileResolver,
  HTTPResolver,
};
