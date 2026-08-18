import { expect, test } from "bun:test";
import { z } from "zod";
import { PER_PAGE, pages } from "../../src/mech/git/github.ts";
import type { Github } from "../../src/mech/git/github.ts";

/**
 * Reading a list endpoint to its end.
 *
 * A lone `per_page=100` looks complete and is not, and both endpoints that were
 * doing it fail in the direction that hides things: `/reviews` returns
 * oldest-first with no `since`, and `/check-runs` truncates the failures a gate
 * exists to report.
 */

const scripted = (answers: unknown[][]): { gh: Github; asked: string[] } => {
  const asked: string[] = [];
  const gh: Github = {
    remaining: () => 4999,
    async request(_method, path, schema) {
      asked.push(path);
      const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? "1");
      return { ok: true, status: 200, data: schema.parse(answers[page - 1] ?? []) };
    },
  };
  return { gh, asked };
};

const Item = z.array(z.object({ id: z.number() }));
const full = (from: number) => Array.from({ length: PER_PAGE }, (_, i) => ({ id: from + i }));

test("a full page is followed by the next one", async () => {
  const { gh, asked } = scripted([full(0), [{ id: 999 }]]);
  const r = await pages(gh, "/repos/o/p/pulls/1/reviews", Item, (x) => x);
  expect(r.ok && r.data).toHaveLength(PER_PAGE + 1);
  expect(r.ok && r.data.at(-1)).toEqual({ id: 999 });
  expect(asked).toHaveLength(2);
  expect(asked[1]).toContain("page=2");
});

test("a short page ends it, so the ordinary case still costs one request", async () => {
  const { gh, asked } = scripted([[{ id: 1 }]]);
  const r = await pages(gh, "/repos/o/p/pulls/1/reviews", Item, (x) => x);
  expect(r.ok && r.data).toHaveLength(1);
  expect(asked).toHaveLength(1);
});

test("a wrapped list is unwrapped by the caller's pick", async () => {
  const Wrapped = z.object({ check_runs: z.array(z.object({ id: z.number() })).optional() });
  const asked: string[] = [];
  const gh: Github = {
    remaining: () => null,
    async request(_m, path, schema) {
      asked.push(path);
      const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? "1");
      return { ok: true, status: 200, data: schema.parse({ check_runs: page === 1 ? full(0) : [{ id: 42 }] }) };
    },
  };
  const r = await pages(gh, "/repos/o/p/commits/sha/check-runs", Wrapped, (x) => x.check_runs ?? []);
  expect(r.ok && r.data).toHaveLength(PER_PAGE + 1);
  expect(asked).toHaveLength(2);
});

test("an existing query string is kept", async () => {
  const { gh, asked } = scripted([[]]);
  await pages(gh, "/repos/o/p/issues/1/comments?since=2026-01-01", Item, (x) => x);
  expect(asked[0]).toContain("since=2026-01-01");
  expect(asked[0]).toContain("&per_page=");
});

test("a failure is returned rather than a short list that looks complete", async () => {
  const gh: Github = {
    remaining: () => null,
    async request() {
      return { ok: false, bucket: "transient", status: 502, message: "bad gateway" };
    },
  };
  const r = await pages(gh, "/repos/o/p/pulls/1/reviews", Item, (x) => x);
  expect(r.ok).toBe(false);
});
