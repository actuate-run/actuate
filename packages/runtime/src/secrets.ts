/**
 * Secret config fields. A field is secret when its JSON Schema has `"writeOnly": true` (zod 4:
 * `secret(z.string())` from `@actuate/sdk`, or `.meta({ writeOnly: true })`). Their values are kept out of
 * everything a person, API or agent reads back: logs, errors, run records and step outputs.
 *
 * Everything here works on plain JSON Schema and JSON values, with no zod, so a host that only has an
 * actuator's metadata (the platform) can use it too.
 */

/** What a secret becomes wherever it would be shown. */
export const SECRET_PLACEHOLDER = "[secret]";

/** Shorter values are not redacted: replacing every "abc" in every log line would mangle them and hide nothing worth hiding. */
export const MIN_SECRET_LENGTH = 6;

type Schema = Record<string, unknown>;
type Path = ReadonlyArray<string | number>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!isObject(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** A local `$ref` (`#/$defs/token`), resolved against the root schema; anything else is ignored. */
function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * The schemas that apply to one value: the given ones plus everything they reach through `$ref` and the
 * `anyOf` / `oneOf` / `allOf` wrappers zod emits for nullable, unions and intersections.
 */
function expand(root: unknown, nodes: readonly unknown[]): Schema[] {
  const out: Schema[] = [];
  const visit = (node: unknown, depth: number) => {
    if (!isObject(node) || depth > 32 || out.includes(node)) return;
    out.push(node);
    if (typeof node.$ref === "string") visit(resolveRef(root, node.$ref), depth + 1);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const list = node[key];
      if (Array.isArray(list)) for (const sub of list) visit(sub, depth + 1);
    }
  };
  for (const node of nodes) visit(node, 0);
  return out;
}

function propertySchemas(node: Schema, key: string): unknown[] {
  if (isObject(node.properties) && Object.hasOwn(node.properties, key)) return [node.properties[key]];
  const out: unknown[] = [];
  if (isObject(node.patternProperties)) {
    for (const [pattern, sub] of Object.entries(node.patternProperties)) {
      try {
        if (new RegExp(pattern, "u").test(key)) out.push(sub);
      } catch {
        // A pattern this engine can't compile: not ours to judge.
      }
    }
  }
  if (!out.length && isObject(node.additionalProperties)) out.push(node.additionalProperties);
  return out;
}

function itemSchemas(node: Schema, index: number): unknown[] {
  if (Array.isArray(node.prefixItems) && index < node.prefixItems.length) return [node.prefixItems[index]];
  if (Array.isArray(node.items)) return index < node.items.length ? [node.items[index]] : isObject(node.additionalItems) ? [node.additionalItems] : [];
  return isObject(node.items) ? [node.items] : [];
}

/** Call `onSecret` for every value in `value` that sits at a `writeOnly` schema (and don't look inside it). */
function walkSecrets(root: unknown, value: unknown, onSecret: (path: Path, value: unknown) => void): void {
  const walk = (nodes: readonly unknown[], v: unknown, path: Path, depth: number): void => {
    const schemas = expand(root, nodes);
    if (!schemas.length || depth > 64) return;
    if (schemas.some((s) => s.writeOnly === true)) return onSecret(path, v);
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const subs = schemas.flatMap((s) => itemSchemas(s, i));
        if (subs.length) walk(subs, item, [...path, i], depth + 1);
      });
    } else if (isObject(v)) {
      for (const [key, item] of Object.entries(v)) {
        const subs = schemas.flatMap((s) => propertySchemas(s, key));
        if (subs.length) walk(subs, item, [...path, key], depth + 1);
      }
    }
  };
  walk([root], value, [], 0);
}

function stringsIn(value: unknown, out: string[], depth = 0): void {
  if (typeof value === "string") out.push(value);
  else if (depth < 64 && Array.isArray(value)) for (const v of value) stringsIn(v, out, depth + 1);
  else if (depth < 64 && isObject(value)) for (const v of Object.values(value)) stringsIn(v, out, depth + 1);
}

/**
 * The values of a config's secret fields: every string under a field whose JSON Schema has
 * `"writeOnly": true`, found through nested objects, arrays (`items`, `prefixItems`), records
 * (`additionalProperties`), local `$ref`s and `anyOf` / `oneOf` / `allOf`. Values shorter than
 * {@link MIN_SECRET_LENGTH} are left out. Deduplicated, longest first, ready for {@link redactSecrets}.
 *
 * `configSchema` is the config's JSON Schema as zod 4 writes it: `z.toJSONSchema(schema, { io: "input" })`.
 */
export function collectSecrets(configSchema: unknown, config: unknown): string[] {
  const found: string[] = [];
  walkSecrets(configSchema, config, (_path, value) => stringsIn(value, found));
  return sortSecrets(found);
}

/** Deduplicated, at least {@link MIN_SECRET_LENGTH} long, longest first (ties in a fixed order). */
function sortSecrets(values: Iterable<string>): string[] {
  return [...new Set(values)]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

const hasValue = (v: unknown): boolean =>
  typeof v === "string" ? v !== "" : Array.isArray(v) ? v.some(hasValue) : isObject(v) ? Object.values(v).some(hasValue) : v !== null && v !== undefined;

/**
 * Where a config sets a secret field: one path per `writeOnly` field holding a value (not `null`, not `""`),
 * in document order. Object keys are joined with dots and array positions written `[i]`: `apiKey`,
 * `slack.botToken`, `webhooks[1].secret`. Values of any length count.
 */
export function secretFields(configSchema: unknown, config: unknown): string[] {
  const found: string[] = [];
  walkSecrets(configSchema, config, (path, value) => {
    if (!hasValue(value)) return;
    const name = path.reduce<string>((acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part), "");
    if (!found.includes(name)) found.push(name);
  });
  return found;
}

/**
 * A copy of `config` without its secret fields: secret object properties are removed, secret array
 * elements are dropped, and so are objects left empty by that. For comparing two configs while ignoring secrets (a stored config shows them masked).
 */
export function omitSecrets<T>(configSchema: unknown, config: T): T {
  const omit = (nodes: readonly unknown[], v: unknown, depth: number): { keep: boolean; value: unknown } => {
    const schemas = expand(configSchema, nodes);
    if (!schemas.length || depth > 64) return { keep: true, value: v };
    if (schemas.some((s) => s.writeOnly === true)) return { keep: false, value: undefined };
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      v.forEach((item, i) => {
        const subs = schemas.flatMap((s) => itemSchemas(s, i));
        const r = subs.length ? omit(subs, item, depth + 1) : { keep: true, value: item };
        if (r.keep) out.push(r.value);
      });
      return { keep: true, value: out };
    }
    if (isObject(v)) {
      const out: Record<string, unknown> = {};
      let removed = false;
      for (const [key, item] of Object.entries(v)) {
        const subs = schemas.flatMap((s) => propertySchemas(s, key));
        const r = subs.length ? omit(subs, item, depth + 1) : { keep: true, value: item };
        if (r.keep) out[key] = r.value;
        else removed = true;
      }
      // An object that held only secrets goes too: `{ token: null }` from a masked config and a file without it match.
      return { keep: !removed || Object.keys(out).length > 0, value: out };
    }
    return { keep: true, value: v };
  };
  // The top level stays even when emptied; it is undefined only when the whole value is secret.
  return omit([configSchema], config, 0).value as T;
}

/**
 * A deep copy of `value` in which every occurrence of a secret, inside any string (object keys too),
 * becomes {@link SECRET_PLACEHOLDER}. Also catches a secret as it appears JSON-escaped or URL-encoded inside
 * a longer string (an error quoting a request body or a URL). Never changes `value`; with no secrets it is
 * returned as is. Arrays and plain objects are copied; other objects (class instances) are returned as they are.
 */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  if (!secrets.length) return value;
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret === "") continue;
    forms.add(secret);
    forms.add(JSON.stringify(secret).slice(1, -1));
    forms.add(encodeURIComponent(secret));
  }
  // Longest first, so a secret that contains another is replaced whole.
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  if (!ordered.length) return value;
  const text = (s: string): string => {
    let out = s;
    for (const form of ordered) if (out.includes(form)) out = out.split(form).join(SECRET_PLACEHOLDER);
    return out;
  };
  const copy = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return text(v);
    // Far deeper than any JSON a run produces (or a cycle): fail closed rather than show it unredacted.
    if (depth > 256 && typeof v === "object" && v !== null) return SECRET_PLACEHOLDER;
    if (Array.isArray(v)) return v.map((item) => copy(item, depth + 1));
    if (isPlain(v)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) out[text(key)] = copy(item, depth + 1);
      return out;
    }
    return v;
  };
  return copy(value, 0) as T;
}

/** Merge secret lists (say, from the raw and the parsed config) into one, as {@link collectSecrets} orders it. */
export function mergeSecrets(...lists: ReadonlyArray<readonly string[]>): string[] {
  return sortSecrets(lists.flat());
}
