import { expect, test } from "bun:test";
import { z } from "zod";
import { displayJson, readJsonResponse } from "../src/contracts/protocol.ts";
import { readJson } from "../web/src/lib/api.ts";

test("malformed response bytes cannot become valid JSON null", async () => {
  expect(await readJsonResponse(new Response("not json"))).toEqual({ ok: false });
  expect(await readJson(new Response("not json"), z.null())).toEqual({
    ok: false,
    data: null,
    text: "Server returned a non-JSON response",
  });
});

test("a real JSON null remains distinguishable from malformed bytes", async () => {
  expect(await readJsonResponse(new Response("null"))).toEqual({ ok: true, data: null });
});

test("protocol messages render consistently in every client", () => {
  expect(displayJson({ error: "no" })).toBe("no");
  expect(displayJson({ message: "done" })).toBe("done");
  expect(displayJson({ value: 1 })).toBe('{"value":1}');
});
