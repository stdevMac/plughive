// examples/hello-pack/index.js
//
// A user pack. It is plain JavaScript so the daemon can import it as it is.
// A pack outside the plughive package cannot import "plughive/pack", so the
// default export is a factory: the daemon calls it with the pack API.

/**
 * An optional key. has() is false when the key is granted but not saved, and
 * throws when the user did not grant it when enabling the pack.
 * @param {import("plughive/pack").PackContext} ctx
 * @param {string} name
 * @returns {Promise<string | null>}
 */
async function optionalSecret(ctx, name) {
  try {
    return (await ctx.secrets.has(name)) ? await ctx.secrets.get(name) : null;
  } catch {
    return null;
  }
}

/** @param {import("plughive/pack").PackApi} api */
export default (api) => {
  const { z, definePack, defineTool } = api;

  const greet = defineTool({
    name: "hello_greet",
    description: "Return a greeting for a name. Needs no key and saves nothing.",
    annotations: { readOnlyHint: true },
    input: z.object({
      name: z.string().trim().min(1).max(80).describe("Who to greet."),
    }),
    run({ name }) {
      return { greeting: `Hello, ${name}!` };
    },
  });

  const saveNote = defineTool({
    name: "hello_save_note",
    description: "Save a short markdown note to the artifact library and return its link.",
    input: z.object({
      title: z.string().trim().min(1).max(120),
      body: z.string().max(10_000),
    }),
    async run({ title, body }, ctx) {
      // The signature is meant to be shown; never write a real credential into a result or artifact.
      const signature = await optionalSecret(ctx, "HELLO_SIGNATURE");
      const text = `# ${title}\n\n${body}${signature ? `\n\n-- ${signature}` : ""}\n`;
      const ref = await ctx.library.save({
        kind: "document",
        mime: "text/markdown",
        bytes: new TextEncoder().encode(text),
        prompt: title,
      });
      ctx.logger.info("saved note", { id: ref.id });
      return { id: ref.id, url: ref.url };
    },
  });

  return definePack({ tools: [greet, saveNote] });
};
