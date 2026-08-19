/**
 * ADR 031's reopen condition, as a command: `bun run embedding:check`.
 *
 * That decision refused embeddings on a measurement — across languages an
 * *irrelevant same-language* passage outranks the *relevant other-language* one,
 * which is exactly and only the case the feature existed for — and said reopening
 * was "a runnable check rather than a judgement". It was not runnable.
 */
/**
 * It also closes the half the ADR left open on purpose: whether a *hosted*
 * embedding does better was "not measured and deliberately not guessed", because
 * the test needs the endpoint the boss would choose. Configure one under
 * `embedding` and this runs against it.
 *
 * Five sentences and three questions — the whole corpus, small enough that the
 * verdict is readable rather than a number to trust.
 */
import type { EmbeddingRef } from "../src/contracts/config.ts";
import { loadConfig } from "../src/platform/config/load.ts";
import { open } from "../src/platform/persistence/database.ts";
import { loadAuth } from "../src/mech/sandbox/auth.ts";

/**
 * The corpus, in the shape the failure has: the same two topics in both languages,
 * so a question in one can be scored against the right passage in the other and the
 * wrong passage in its own.
 *
 * `query:` and `passage:` are the e5 family's required prefixes and are not
 * decoration — ADR 031 records that omitting them puts every pair between 0.75 and
 * 0.87 and separates nothing, producing a verdict about the model that was really
 * about how it had been called.
 */
const PASSAGES = [
  {
    id: "中-沙盒",
    lang: "zh",
    topic: "sandbox",
    text: "沙盒容器由 opensandbox 创建，先拉镜像再装凭据，最后挂载技能目录。",
  },
  {
    id: "中-迁移",
    lang: "zh",
    topic: "migration",
    text: "迁移编号在 database.ts 的 MIGRATIONS 数组里，按索引推进，编号写在注释上。",
  },
  {
    id: "英-沙盒",
    lang: "en",
    topic: "sandbox",
    text: "A group's container is created through opensandbox: pull the image, install credentials, mount the skills directory.",
  },
  {
    id: "英-迁移",
    lang: "en",
    topic: "migration",
    text: "Migrations live in the MIGRATIONS array in database.ts, advanced by index, with the number written in the comment above each.",
  },
] as const;

const QUESTIONS = [
  { text: "沙盒是怎么启动的", lang: "zh", topic: "sandbox" },
  { text: "迁移编号在哪检查", lang: "zh", topic: "migration" },
  { text: "how is a group's container started", lang: "en", topic: "sandbox" },
] as const;

type Embed = (texts: string[], kind: "query" | "passage") => Promise<number[][]>;

export const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

/**
 * Loaded on demand, and its absence is a message rather than a stack.
 *
 * `@huggingface/transformers` is not a dependency — ADR 031 refused it, and the
 * 13.5 MB of ONNX runtime it actually ships is still 13.5 MB nobody is using. So
 * the local half of this check asks for it and says how to get it.
 */
async function localEmbed(model: string): Promise<Embed> {
  let pipe: (input: string[], opts: object) => Promise<{ tolist(): number[][] }>;
  try {
    // A computed specifier, because the package is deliberately not a dependency
    // (ADR 031) and a literal one would be a type error in a repository that has
    // decided not to install it. The failure path below is the documented one.
    const mod = "@huggingface/transformers";
    const { pipeline } = (await import(mod)) as {
      pipeline: (task: string, model: string, opts: object) => Promise<typeof pipe>;
    };
    pipe = await pipeline("feature-extraction", model, { dtype: "q8" });
  } catch {
    throw new Error(
      `local embedding needs @huggingface/transformers, which this repository does not depend on (ADR 031).\n` +
        `  bun add -d @huggingface/transformers   # ~384 MB installed; 13.5 MB of it would ship`,
    );
  }
  return async (texts, kind) =>
    (
      await pipe(
        texts.map((t) => `${kind}: ${t}`),
        { pooling: "mean", normalize: true },
      )
    ).tolist();
}

/** An OpenAI-shaped `/v1/embeddings` POST. The key comes from the vault, by name. */
function remoteEmbed(endpoint: string, model: string, key: string): Embed {
  return async (texts, kind) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts.map((t) => `${kind}: ${t}`) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${endpoint} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: { embedding: number[] }[] };
    const vectors = body.data?.map((d) => d.embedding);
    if (!vectors?.length) throw new Error(`${endpoint} returned no embeddings`);
    return vectors;
  };
}

/**
 * One question's verdict, which is the whole of ADR 031's condition.
 *
 * Separated from the run so it can be tested without a model: the condition is
 * easy to state and easy to get backwards, and getting it backwards would report
 * the refusal as met.
 */
export function crossesLanguages(
  scored: readonly { lang: string; topic: string; score: number }[],
  question: { lang: string; topic: string },
): boolean | null {
  const relevantOther = scored.find((p) => p.topic === question.topic && p.lang !== question.lang);
  const irrelevantSame = scored.find((p) => p.topic !== question.topic && p.lang === question.lang);
  if (!relevantOther || !irrelevantSame) return null;
  return relevantOther.score > irrelevantSame.score;
}

/** The embedder the config asks for, announced so the output says what it ran. */
async function configured(embedding: EmbeddingRef): Promise<Embed> {
  if (embedding.mode === "local") {
    console.log(`local: ${embedding.model}\n`);
    return localEmbed(embedding.model);
  }
  const auth = await loadAuth(await open(), embedding.credential);
  if (!auth)
    throw new Error(`no credential named "${embedding.credential}" in runtime_auth — add it in settings first.`);
  console.log(`remote: ${embedding.model} at ${embedding.endpoint}\n`);
  return remoteEmbed(embedding.endpoint, embedding.model, auth.secret);
}

/** One question, scored against every passage and printed in rank order. */
async function ask(embed: Embed, question: (typeof QUESTIONS)[number], passageVectors: number[][]) {
  const [q] = await embed([question.text], "query");
  const scored = PASSAGES.map((p, i) => ({ ...p, score: cosine(q!, passageVectors[i]!) })).sort(
    (a, b) => b.score - a.score,
  );
  console.log(`Q: ${question.text}`);
  for (const p of scored) {
    const right = p.topic === question.topic;
    const same = p.lang === question.lang;
    console.log(
      `   ${p.id}  ${p.score.toFixed(3)}  (${right ? "right" : "wrong"}, ${same ? "same" : "other"} language)`,
    );
  }
  const won = crossesLanguages(scored, question);
  console.log(won === null ? "" : `   → ${won ? "PASS" : "FAIL"}\n`);
  return won;
}

async function main(): Promise<number> {
  const embed = await configured(loadConfig().embedding);
  const passageVectors = await embed(
    PASSAGES.map((p) => p.text),
    "passage",
  );

  const verdicts = [];
  for (const question of QUESTIONS) verdicts.push(await ask(embed, question, passageVectors));
  const answered = verdicts.filter((v) => v !== null);
  const wins = answered.filter(Boolean).length;

  const passed = answered.length > 0 && wins === answered.length;
  console.log(`${wins}/${answered.length} questions rank the relevant other-language passage first.`);
  console.log(
    passed
      ? "ADR 031's reopen condition is met. Hybrid retrieval is worth building; the seam is a vector field and a mode."
      : "ADR 031 stands. Retrieval stays lexical, and the cross-language gap stays a stated gap.",
  );
  return passed ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    // The message, not the stack: every failure here is a missing package, an
    // unset credential or an endpoint answering something — all of which are
    // told to somebody who has to act, not debugged.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
