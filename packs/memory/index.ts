// packs/memory/index.ts
//
// Long-term semantic memory for agents: remember text, recall it by meaning,
// forget it. Embeddings come from the `text.embed` capability (whatever
// provider the user set up); vectors live in SQLite in the pack's data
// directory, searched with the sqlite-vec extension when it loads and with
// brute-force cosine similarity in JS when it does not (see store.ts).
//
// Each collection is pinned to the provider, model and dimension count of
// its first embedding. Later calls embed with that same provider and model
// (no fallback to another provider), and a result from anything else is
// refused: vectors from different models are not comparable.
import { randomUUID } from "node:crypto";
import { CapabilityError, type PackContext, definePack, defineTool, z } from "plughive/pack";
import {
  EmbeddingMismatchError,
  type EmbeddingPin,
  MemoryStore,
  type SearchMode,
  type VectorExtensionLoader,
} from "./store.js";

const MAX_METADATA_BYTES = 16 * 1024;
const MAX_ITEMS = 256;
const DEFAULT_COLLECTION = "default";

const collectionField = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "collection names are 1-64 letters, digits, . _ or -, starting with a letter or digit",
  );

const tagsField = z
  .array(z.string().trim().min(1).max(64))
  .max(32)
  .transform((tags) => [...new Set(tags)]);

const metadataField = z.record(z.string().min(1).max(100), z.unknown()).refine((m) => {
  try {
    return Buffer.byteLength(JSON.stringify(m), "utf8") <= MAX_METADATA_BYTES;
  } catch {
    return false;
  }
}, `metadata must be JSON and at most ${MAX_METADATA_BYTES} bytes`);

const idField = z.string().min(1).max(200);

const textField = z.string().trim().min(1).max(32_000);

const itemSchema = z.object({
  text: textField,
  id: idField.optional().describe("Stable id; remembering the same id again replaces it."),
  tags: tagsField.optional(),
  metadata: metadataField.optional(),
});

type Item = z.output<typeof itemSchema>;

/** Options for tests and for hosts that want to force the JS search. */
export interface MemoryPackOptions {
  /**
   * How to load sqlite-vec. Default: the `sqlite-vec` npm package's loader.
   * `false` skips the extension and uses the JS search.
   */
  loadVectorExtension?: VectorExtensionLoader | false;
}

const defaultLoader: VectorExtensionLoader = async (db) => {
  const mod = (await import("sqlite-vec")) as { load(db: unknown): void };
  mod.load(db);
};

function capabilityHint(err: unknown): never {
  if (
    err instanceof CapabilityError &&
    (err.code === "NO_PROVIDER" || err.code === "UNKNOWN_PROVIDER")
  ) {
    throw new CapabilityError(
      `${err.message}. Memory needs a text.embed provider; list_media_providers shows which are set up.`,
      { code: err.code },
    );
  }
  throw err;
}

interface Embedded {
  pin: EmbeddingPin;
  embeddings: number[][];
}

/** Embed through ctx.capabilities, pinned to `pin` when the collection exists. */
async function embed(
  ctx: PackContext,
  texts: string[],
  inputType: "query" | "document",
  pin: EmbeddingPin | undefined,
  choice: {
    provider?: string | undefined;
    model?: string | undefined;
    dimensions?: number | undefined;
  },
): Promise<Embedded> {
  const input: {
    texts: string[];
    input_type: "query" | "document";
    model?: string;
    dimensions?: number;
  } = {
    texts,
    input_type: inputType,
  };
  const opts: { provider?: string } = {};
  let requestedDimensions: number | null;
  if (pin) {
    input.model = pin.model;
    if (pin.requestedDimensions !== null) input.dimensions = pin.requestedDimensions;
    opts.provider = pin.provider;
    requestedDimensions = pin.requestedDimensions;
  } else {
    if (choice.model) input.model = choice.model;
    if (choice.dimensions) input.dimensions = choice.dimensions;
    if (choice.provider) opts.provider = choice.provider;
    requestedDimensions = choice.dimensions ?? null;
  }
  let out: { embeddings: number[][]; model: string; dimensions: number; provider: string };
  try {
    out = await ctx.capabilities.run("text.embed", input, opts);
  } catch (err) {
    capabilityHint(err);
  }
  if (!Array.isArray(out.embeddings) || out.embeddings.length !== texts.length) {
    throw new Error(
      `the text.embed provider returned ${out.embeddings?.length ?? 0} embeddings for ${texts.length} texts`,
    );
  }
  for (const v of out.embeddings) {
    if (v.length !== out.dimensions) {
      throw new EmbeddingMismatchError(
        `the text.embed provider said ${out.dimensions} dimensions but returned a vector of ${v.length}`,
      );
    }
    let norm = 0;
    for (const x of v) {
      if (!Number.isFinite(x))
        throw new Error("the text.embed provider returned a non-finite value");
      norm += x * x;
    }
    if (norm === 0) throw new Error("the text.embed provider returned an all-zero vector");
  }
  const got: EmbeddingPin = {
    provider: out.provider,
    model: out.model,
    dimensions: out.dimensions,
    requestedDimensions,
  };
  if (
    pin &&
    (got.provider !== pin.provider || got.model !== pin.model || got.dimensions !== pin.dimensions)
  ) {
    throw new EmbeddingMismatchError(
      `this collection is pinned to ${pin.provider}/${pin.model} (${pin.dimensions} dimensions), but the embedding came back from ${got.provider}/${got.model} (${got.dimensions} dimensions). Vectors from different models are not comparable: check that provider's setup, use another collection, or forget this one and start over.`,
    );
  }
  return { pin: got, embeddings: out.embeddings };
}

function checkChoice(
  collection: string,
  pin: EmbeddingPin,
  choice: {
    provider?: string | undefined;
    model?: string | undefined;
    dimensions?: number | undefined;
  },
): void {
  const clash: string[] = [];
  if (choice.provider && choice.provider !== pin.provider) clash.push(`provider ${pin.provider}`);
  if (choice.model && choice.model !== pin.model) clash.push(`model ${pin.model}`);
  if (choice.dimensions && choice.dimensions !== pin.dimensions)
    clash.push(`${pin.dimensions} dimensions`);
  if (clash.length > 0) {
    throw new EmbeddingMismatchError(
      `collection "${collection}" already uses ${clash.join(", ")}; provider, model and dimensions only apply when a collection is created`,
    );
  }
}

/** Build the memory pack. The default export uses sqlite-vec when it loads. */
export function createMemoryPack(options: MemoryPackOptions = {}) {
  const loader =
    options.loadVectorExtension === false ? null : (options.loadVectorExtension ?? defaultLoader);
  const stores = new Map<string, Promise<MemoryStore>>();

  const storeFor = (ctx: PackContext): Promise<MemoryStore> => {
    const dir = ctx.pack.dataDir;
    let s = stores.get(dir);
    if (!s) {
      s = MemoryStore.open(dir, loader);
      stores.set(dir, s);
      s.then(
        (store) => {
          if (store.mode === "js") {
            ctx.logger.warn("memory: sqlite-vec unavailable, using brute-force JS search", {
              reason: store.fallbackReason,
            });
          }
        },
        () => stores.delete(dir),
      );
    }
    return s;
  };

  const remember = defineTool({
    name: "remember",
    description:
      'Store text in long-term semantic memory so it can be found later by meaning with recall. Give `text` (one memory) or `items` (up to 256). Optional collection (default "default"), id (same id replaces), tags and metadata. A new collection is pinned to the embedding provider and model of its first call.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: z
      .object({
        text: textField.optional(),
        id: idField
          .optional()
          .describe("Stable id for `text`; remembering the same id again replaces it."),
        tags: tagsField.optional().describe("Tags for `text`, usable as a recall filter."),
        metadata: metadataField.optional().describe("JSON metadata for `text`, returned with it."),
        items: z.array(itemSchema).min(1).max(MAX_ITEMS).optional(),
        collection: collectionField.default(DEFAULT_COLLECTION),
        provider: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,39}$/)
          .optional()
          .describe("text.embed provider for a NEW collection. Omit to route automatically."),
        model: z
          .string()
          .regex(/^[A-Za-z0-9._:/@-]{1,120}$/)
          .optional()
          .describe("Embedding model for a NEW collection."),
        dimensions: z
          .number()
          .int()
          .min(16)
          .max(8192)
          .optional()
          .describe("Embedding size for a NEW collection, on models that support it."),
      })
      .refine((v) => (v.text === undefined) !== (v.items === undefined), {
        message: "give exactly one of text or items",
      })
      .refine(
        (v) =>
          v.items === undefined ||
          (v.id === undefined && v.tags === undefined && v.metadata === undefined),
        {
          message: "id, tags and metadata go inside each item when you pass items",
        },
      ),
    async run(input, ctx) {
      const items: Item[] = input.items ?? [
        {
          text: input.text as string,
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        },
      ];
      const ids = items.map((i) => i.id ?? randomUUID());
      if (new Set(ids).size !== ids.length) throw new Error("items repeat an id");
      const store = await storeFor(ctx);
      const existing = store.getCollection(input.collection);
      const choice = { provider: input.provider, model: input.model, dimensions: input.dimensions };
      if (existing) checkChoice(input.collection, existing, choice);
      const { pin, embeddings } = await embed(
        ctx,
        items.map((i) => i.text),
        "document",
        existing,
        choice,
      );
      if (!existing && input.dimensions && pin.dimensions !== input.dimensions) {
        throw new EmbeddingMismatchError(
          `asked for ${input.dimensions} dimensions but ${pin.provider}/${pin.model} returned ${pin.dimensions}`,
        );
      }
      const res = store.upsert(
        input.collection,
        pin,
        items.map((item, i) => ({
          id: ids[i] as string,
          text: item.text,
          tags: item.tags ?? [],
          metadata: item.metadata ?? null,
          embedding: embeddings[i] as number[],
        })),
      );
      return {
        collection: input.collection,
        created_collection: res.createdCollection,
        remembered: res.results.map((r) => ({ id: r.id, replaced: !r.created })),
        provider: pin.provider,
        model: pin.model,
        dimensions: pin.dimensions,
      };
    },
  });

  const recall = defineTool({
    name: "recall",
    description:
      "Search long-term memory by meaning: returns the stored texts closest to `query` in a collection, best first, with a cosine similarity score (1 is identical). Optional top k, min_score and tags (memories must carry every tag).",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: z.object({
      query: textField,
      collection: collectionField.default(DEFAULT_COLLECTION),
      k: z.number().int().min(1).max(100).default(5),
      min_score: z.number().min(-1).max(1).optional(),
      tags: tagsField.optional(),
    }),
    async run(input, ctx) {
      const store = await storeFor(ctx);
      const col = store.getCollection(input.collection);
      if (!col) {
        throw new Error(
          `no memory collection "${input.collection}". list_memory_collections shows the ones that exist.`,
        );
      }
      if (col.count === 0) {
        return { collection: input.collection, mode: store.mode, results: [] };
      }
      const { embeddings } = await embed(ctx, [input.query], "query", col, {});
      const hits = store.search(
        input.collection,
        embeddings[0] as number[],
        input.k,
        input.tags ?? [],
      );
      const min = input.min_score;
      return {
        collection: input.collection,
        mode: store.mode,
        results: hits
          .filter((h) => min === undefined || h.score >= min)
          .map((h) => ({
            id: h.id,
            text: h.text,
            score: Math.round(h.score * 1e6) / 1e6,
            tags: h.tags,
            metadata: h.metadata,
            created_at: h.createdAt,
            updated_at: h.updatedAt,
          })),
      };
    },
  });

  const forget = defineTool({
    name: "forget",
    description:
      "Delete memories. Give `ids` (or `id`) to delete those memories from a collection. To delete a whole collection, give only `collection` plus `confirm` set to that same collection name; without a matching confirm nothing is deleted and the call reports what would be. Deletion cannot be undone.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: z
      .object({
        collection: collectionField.default(DEFAULT_COLLECTION),
        id: idField.optional(),
        ids: z.array(idField).min(1).max(1000).optional(),
        confirm: z
          .string()
          .optional()
          .describe("Deleting a whole collection: repeat its name here to confirm."),
      })
      .refine((v) => !(v.id !== undefined && v.ids !== undefined), {
        message: "give id or ids, not both",
      })
      .refine((v) => !(v.confirm !== undefined && (v.id !== undefined || v.ids !== undefined)), {
        message: "confirm is only for deleting a whole collection; leave out id and ids",
      }),
    async run(input, ctx) {
      const store = await storeFor(ctx);
      const ids = input.ids ?? (input.id !== undefined ? [input.id] : undefined);
      if (ids) {
        const res = store.deleteIds(input.collection, [...new Set(ids)]);
        return { collection: input.collection, deleted: res.deleted, not_found: res.missing };
      }
      const col = store.getCollection(input.collection);
      if (!col) {
        return {
          collection: input.collection,
          deleted_collection: false,
          deleted_count: 0,
          not_found: true,
        };
      }
      if (input.confirm !== input.collection) {
        return {
          collection: input.collection,
          deleted_collection: false,
          deleted_count: 0,
          dry_run: true,
          would_delete: col.count,
          message: `Nothing deleted. To delete collection "${input.collection}" and its ${col.count} memories for good, call forget again with confirm: "${input.collection}".`,
        };
      }
      const n = store.dropCollection(input.collection);
      return {
        collection: input.collection,
        deleted_collection: n !== null,
        deleted_count: n ?? 0,
      };
    },
  });

  const collections = defineTool({
    name: "list_memory_collections",
    description:
      "List memory collections with their memory counts and the embedding provider, model and dimensions each is pinned to, plus the search mode in use (sqlite-vec index or brute-force JS fallback).",
    annotations: { readOnlyHint: true, openWorldHint: false },
    input: z.object({}),
    async run(_input, ctx) {
      const store = await storeFor(ctx);
      return {
        mode: store.mode as SearchMode,
        sqlite_vec_version: store.vecVersion,
        ...(store.mode === "js" ? { fallback_reason: store.fallbackReason } : {}),
        collections: store.listCollections().map((c) => ({
          name: c.name,
          count: c.count,
          provider: c.provider,
          model: c.model,
          dimensions: c.dimensions,
          created_at: c.createdAt,
          updated_at: c.updatedAt,
        })),
      };
    },
  });

  const listMemories = defineTool({
    name: "list_memories",
    description:
      "Page through the memories in a collection, newest first, optionally only those carrying every given tag. Pass next_cursor back as cursor for the next page.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    input: z.object({
      collection: collectionField.default(DEFAULT_COLLECTION),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z
        .string()
        .regex(/^[1-9][0-9]{0,15}$/, "use the next_cursor of the previous page")
        .optional(),
      tags: tagsField.optional(),
    }),
    async run(input, ctx) {
      const store = await storeFor(ctx);
      if (!store.getCollection(input.collection)) {
        throw new Error(
          `no memory collection "${input.collection}". list_memory_collections shows the ones that exist.`,
        );
      }
      const page = store.list(input.collection, {
        limit: input.limit,
        before: input.cursor === undefined ? undefined : Number(input.cursor),
        tags: input.tags,
      });
      return {
        collection: input.collection,
        memories: page.memories.map((m) => ({
          id: m.id,
          text: m.text,
          tags: m.tags,
          metadata: m.metadata,
          created_at: m.createdAt,
          updated_at: m.updatedAt,
        })),
        next_cursor: page.nextCursor === null ? null : String(page.nextCursor),
      };
    },
  });

  return definePack({
    tools: [remember, recall, forget, collections, listMemories],
    async dispose() {
      const open = [...stores.values()];
      stores.clear();
      for (const p of open) {
        try {
          (await p).close();
        } catch {
          // A store that failed to open has nothing to close.
        }
      }
    },
  });
}

export default createMemoryPack();
