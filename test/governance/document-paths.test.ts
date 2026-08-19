import { expect, test } from "bun:test";

test("canonical documentation paths do not acquire legacy references", async () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(listed.exitCode).toBe(0);

  const forbidden = [
    ["PLAN", ".md"].join(""),
    ["PROGRESS", ".md"].join(""),
    ["DESIGN", ".md"].join(""),
    ["docs", "decisions", ""].join("/"),
  ];
  const violations: string[] = [];

  for (const path of listed.stdout.toString().split("\0").filter(Boolean)) {
    const file = Bun.file(path);
    if (!(await file.exists()) || file.type.startsWith("image/")) continue;
    const text = await file.text();
    for (const legacy of forbidden) {
      if (text.includes(legacy)) violations.push(`${path}: ${legacy}`);
    }
  }

  expect(violations).toEqual([]);
});
