import { execFile } from "node:child_process";

// opencode silently ignores an unknown --variant, so check it against the model's own list first.

const cache = new Map<string, Promise<Map<string, string[]>>>();

function providerModels(provider: string): Promise<Map<string, string[]>> {
  let pending = cache.get(provider);
  if (!pending) {
    pending = new Promise((resolve) => {
      const bin = process.env.OPENCODE_BIN ?? "opencode";
      execFile(bin, ["models", provider, "--verbose"], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
        resolve(err ? new Map() : parseModels(stdout));
      });
    });
    cache.set(provider, pending);
  }
  return pending;
}

/** `opencode models --verbose` prints `provider/model` followed by that model's JSON, one after another. */
export function parseModels(output: string): Map<string, string[]> {
  const models = new Map<string, string[]>();
  const header = /^([\w.~-]+\/\S+)\n\{/gm;
  let match: RegExpExecArray | null;
  while ((match = header.exec(output))) {
    const start = match.index + match[1].length + 1;
    let depth = 0;
    let end = start;
    let inString = false;
    for (; end < output.length; end++) {
      const ch = output[end];
      if (inString) {
        if (ch === "\\") end++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    try {
      const info = JSON.parse(output.slice(start, end + 1)) as { variants?: Record<string, unknown> };
      models.set(match[1], Object.keys(info.variants ?? {}));
    } catch {
      // Skip a block that does not parse.
    }
    header.lastIndex = end;
  }
  return models;
}

/** The variants a model supports, or undefined when that cannot be determined. */
export async function modelVariants(model: string): Promise<string[] | undefined> {
  const provider = model.split("/")[0];
  return (await providerModels(provider)).get(model);
}

/** An error message when `variant` is not valid for `model`, otherwise undefined. */
export async function checkVariant(model: string | undefined, variant: string | undefined): Promise<string | undefined> {
  if (!variant || !model) return undefined;
  const variants = await modelVariants(model);
  if (!variants) return undefined;
  if (!variants.length) return `${model} has no reasoning variants; drop the variant`;
  if (!variants.includes(variant)) return `Unknown variant "${variant}" for ${model}. Available: ${variants.join(", ")}`;
  return undefined;
}
