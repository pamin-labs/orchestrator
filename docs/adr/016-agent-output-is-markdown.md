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
parsed through a legacy path, marked as such. That path is gone: a compatibility
alias before the first stable release is out of scope (`docs/project/plan.md`),
and a card in the old shape is now refused by a rejection naming the headings to
write, rather than parsed by a second grammar. Role templates in `roles/` emit
Markdown only.
