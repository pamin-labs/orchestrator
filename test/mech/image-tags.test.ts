import { expect, test } from "bun:test";
import { tagsFrom } from "../../src/mech/sandbox/images.ts";

/**
 * The published half of the image picker.
 *
 * The field used to be a text box, and a typo in it is not rejected here — it is
 * a container that will not create, on a group that has already been dispatched.
 * So the list has to be right, and when it is empty it has to say which kind of
 * empty: "never released" and "registry unreachable" send a reader to different
 * places, and collapsing them into one blank list is the failure mode this
 * project keeps paying for.
 */

test("latest leads, and the rest are newest-looking first", () => {
  // Not a semver sort: whatever a release tags is the release's business, and
  // inventing an order it did not ask for is how a "newest" ends up pointing at
  // the wrong image.
  const { tags, note } = tagsFrom(200, { tags: ["v1.2.0", "latest", "v1.10.0", "v1.9.0"] });

  expect(tags).toEqual(["latest", "v1.10.0", "v1.9.0", "v1.2.0"]);
  expect(note).toBeUndefined();
});

test("a package that has never been published says so, rather than reading as broken", () => {
  // GHCR answers 404 for both "never published" and "private", and neither is an
  // error — they mean there is nothing to choose yet.
  for (const status of [401, 403, 404]) {
    const r = tagsFrom(status, null);
    expect(r.tags).toEqual([]);
    expect(r.note).toContain("release");
  }
});

test("a registry that is having a bad day is reported as the registry, with its status", () => {
  const r = tagsFrom(503, null);

  expect(r.tags).toEqual([]);
  expect(r.note).toContain("503");
});

test("an answer that is not a tag list is an empty list with a reason, not a throw", () => {
  // The panel calls this before anything is connected, and an exception here
  // takes the settings page down over a registry that answered with HTML.
  expect(tagsFrom(200, "<html>").tags).toEqual([]);
  expect(tagsFrom(200, "<html>").note).toContain("200");
  // A well-formed answer with no tags is a legitimate empty and carries no note:
  // the package exists and has no versions.
  expect(tagsFrom(200, { name: "orch/agent" })).toEqual({ tags: [] });
});

/**
 * The release workflow's scaffolding, kept out of the boss's menu.
 *
 * `release.yml` stages each platform leg under `sha-<commit>-<arch>` because a
 * multi-arch index can only be assembled from references that are already in the
 * registry, then joins them under `sha-<commit>`. Nothing deletes those, so the
 * one real answer arrived in the picker alongside three build artifacts.
 */
/**
 * A deny-list of the three shapes that workflow writes, not an allow-list of
 * version formats: this file already refuses to predict what a release tags, and
 * a picker that hides `0.2.0-rc.1` because it did not match a pattern is the
 * same mistake pointing the other way.
 */
test("staging tags and attestations are not offered as images", () => {
  const { tags } = tagsFrom(200, {
    tags: [
      "0.1.4",
      "latest",
      "sha-9ca604b8a277fdfa17fa59193b8259f4693e3ac6",
      "sha-9ca604b8a277fdfa17fa59193b8259f4693e3ac6-amd64",
      "sha-9ca604b8a277fdfa17fa59193b8259f4693e3ac6-arm64",
      "sha256-9a0de1a2381fd9f500f5e7122e01f225fe0035ef56a6cb7bbd3bbe540ced8bef",
      "0.1.4-amd64",
      "0.1.4-arm64",
      "0.2.0-rc.1",
    ],
  });

  expect(tags).toEqual(["latest", "0.2.0-rc.1", "0.1.4"]);
});

/**
 * A single-architecture image is the same class of mistake as a typo.
 *
 * `0.1.4-amd64` pulls and runs on an amd64 machine and fails to create a
 * container on an arm64 one, which is a group already dispatched before anybody
 * finds out. The multi-arch index is the only correct answer, so it is the only
 * one offered.
 */
test("a per-platform release tag is not an image a sandbox can run everywhere", () => {
  expect(tagsFrom(200, { tags: ["1.0.0-amd64", "1.0.0-arm64"] })).toEqual({
    tags: [],
    note: "no image published yet — run a release, or use a locally built one",
  });
});
