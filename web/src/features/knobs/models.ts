/**
 * Which models to offer, taken from the config's own answer.
 *
 * There is no endpoint that lists an account's models: neither CLI has a list
 * command, and the credentials we hold are the CLIs' OAuth tokens rather than API
 * keys we could ask `/v1/models` with. A hardcoded table would be a fourth place
 * that goes stale — `difficultyModel`, `indexModel` and `contextWindow` already
 * name models between them.
 */
/**
 * So the picker offers what this config already knows and refuses nothing: a model
 * id that appears nowhere yet is exactly how the first one gets added, and a list
 * that could not accept it would be a list you edit the yaml to get around.
 */

/** `claude-opus-5` → `claude`, `gpt-5.6-luna` → `gpt`. */
const family = (model: string): string => model.split("-")[0] ?? "";

export interface ModelSources {
  difficultyModel?: Record<string, Record<string, string>>;
  contextWindow?: Record<string, number>;
  indexModel?: { runtime?: string; model?: string };
}

/**
 * Every model this config names, bucketed by the runtime that runs it.
 *
 * `difficultyModel` is the authority — it is the one place that states the
 * pairing — and it also teaches the family prefixes, which is what lets a
 * `contextWindow` key be attributed at all. A key whose family nothing claims
 * (`default`, or a model added to the window table before it was ever assigned)
 * is offered under every runtime rather than dropped: the picker's job is to
 * spare typing, not to have an opinion about what exists.
 */
export function modelsByRuntime(src: ModelSources): Record<string, string[]> {
  const byRuntime: Record<string, Set<string>> = {};
  const owner: Record<string, string> = {};

  const bucket = (runtime: string): Set<string> => (byRuntime[runtime] ??= new Set());

  for (const [runtime, tiers] of Object.entries(src.difficultyModel ?? {})) {
    const set = bucket(runtime);
    for (const model of Object.values(tiers ?? {}).filter(Boolean)) {
      set.add(model);
      owner[family(model)] = runtime;
    }
  }

  const index = src.indexModel;
  if (index?.runtime && index.model) {
    bucket(index.runtime).add(index.model);
    owner[family(index.model)] ??= index.runtime;
  }

  for (const model of Object.keys(src.contextWindow ?? {})) {
    // `default` is the fallback window, not a model anyone can pick.
    if (model === "default") continue;
    const runtime = owner[family(model)];
    for (const target of runtime ? [runtime] : Object.keys(byRuntime)) bucket(target).add(model);
  }

  return Object.fromEntries(Object.entries(byRuntime).map(([r, s]) => [r, [...s].sort()]));
}

/** Every model, whoever runs it. What the window table's key column offers. */
export function allModels(src: ModelSources): string[] {
  return [...new Set(Object.values(modelsByRuntime(src)).flat())].sort();
}

/**
 * The cheapest model on a runtime, which is the one `difficultyModel` files
 * under `trivial`.
 *
 * That is what the tier means — `trivial` is the work not worth a large model —
 * so the config already holds this answer and a second price table would be a
 * second thing to keep current. Used when the index model's runtime changes:
 * carrying `gpt-5.6-luna` over to claude leaves a model that runtime cannot run,
 * and the indexer is by its own docstring the most frequent call in the system.
 */
export function cheapest(src: ModelSources, runtime: string): string | undefined {
  const tiers = src.difficultyModel?.[runtime];
  return tiers?.trivial || tiers?.normal || Object.values(tiers ?? {})[0];
}
