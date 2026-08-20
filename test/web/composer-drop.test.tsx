import { expect, test } from "bun:test";
import { render, waitFor } from "../support/render.tsx";
import { http, HttpResponse } from "msw";
import { inFlight, mockHttp, server } from "../support/http.ts";
import { Composer } from "../../web/src/features/composer/view.tsx";
import { WithQueries } from "./queries.tsx";

mockHttp(inFlight());

/**
 * A directory entry the drop handler can walk, in the shape the platform gives.
 *
 * Typed as the two shapes the walk actually asks for rather than cast through
 * `FileSystemEntry`: that interface is a union of file and directory in the DOM
 * lib, and an assertion onto it says "trust me" about the very branch under test.
 */
interface FakeFile {
  isFile: true;
  isDirectory: false;
  name: string;
  file: (ok: (file: File) => void) => void;
}
interface FakeDir {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader: () => { readEntries: (ok: (list: (FakeFile | FakeDir)[]) => void) => void };
}

function dirEntry(name: string, files: { name: string; body: string }[]): FakeDir {
  const kids: FakeFile[] = files.map((f) => ({
    isFile: true,
    isDirectory: false,
    name: f.name,
    file: (ok) => ok(new File([f.body], f.name, { type: "text/plain" })),
  }));
  let handed = false;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      // The real reader hands back at most a hundred and signals the end with an
      // empty batch, which is what the walk is written against.
      readEntries: (ok) => {
        ok(handed ? [] : kids);
        handed = true;
      },
    }),
  };
}

test("a dropped folder is walked and every file inside it is attached", async () => {
  const sent: string[] = [];
  server.use(
    http.post("*/api/v1/attach", async ({ request }) => {
      const form = await request.formData();
      sent.push(...form.getAll("rel").map(String));
      return HttpResponse.json({ files: [] });
    }),
  );

  const view = render(
    <WithQueries>
      <Composer placeholder="说点什么" submit="发送" onSubmit={() => true} />
    </WithQueries>,
  );
  const box = view.getByPlaceholderText("说点什么").closest("div")!;

  const entry = dirEntry("notes", [
    { name: "a.txt", body: "one" },
    { name: "b.txt", body: "two" },
  ]);
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  // `dataTransfer` is read-only on the event, so the fixture is defined onto it —
  // the same thing the platform does, and the only way to hand a synthetic drop a
  // directory.
  Object.defineProperty(drop, "dataTransfer", {
    value: { items: [{ webkitGetAsEntry: () => entry }], files: [] },
  });
  box.dispatchEvent(drop);

  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  expect(sent.sort()).toEqual(["notes/a.txt", "notes/b.txt"]);
});
