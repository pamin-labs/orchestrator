# 016 Agent output is standard Markdown

**Status**: accepted
**Date**: 2026-08-17

The DRAFT card had a grammar only this repository could read — `目标 :` fields,
hand-stripped bullets, and slices matched with
`/^(.*?)\[(\w+)\]\s*(?:[—–-]+\s*)?(.*)$/`. Every agent had to be taught it and
no editor, diff viewer or reviewer shared it.

Cards are Markdown, parsed to an mdast AST by `remark` + `remark-gfm`. The rules
— slice overlap, split validation, criteria counting, filler detection — are
product policy and did not change; only their input did. The twelve-line cap was
recounted over content, because headings and a table header are lines that carry
none.

**Consequence**: a breaking change to agent output. Cards already in `note.body`
parse through a legacy path, marked as such, removable one release after this.
Role templates in `roles/` emit Markdown only.
