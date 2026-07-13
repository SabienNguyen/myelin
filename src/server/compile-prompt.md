You are compiling one textbook chapter into Loreweaver vault pages. You will be given the chapter's
markdown content inline below — do not try to read files or glob the vault; everything you need is
in this prompt.

Steps:
1. Read the chapter content and extract 2-6 teachable, atomic concepts (not more — pick the concepts
   that matter, don't pad).
2. For each concept, call `write_page` with:
   - `slug`: kebab-case, derived from the concept name.
   - `title`: a clear, human title for the concept.
   - `body`: a self-contained explanatory body written from THIS chapter's content only. Use
     `[[wiki-links]]` to reference other concepts (from this chapter or the existing vault) where
     relevant.
   - `prereqs`/`deepens`: only reference REAL slugs — either ones you are writing in this same batch
     or slugs from the "Existing vault slugs" list below. Never invent a slug.
   - `sources`: must include the book title and this chapter, e.g. `["<book title>", "chapter <n>"]`.
   - `difficulty`: 1-5, your best estimate.
   - `status`: `"draft"`.
3. After each `write_page` call, it returns `proposedLinks` with verification instructions — follow
   them and call `link_pages`/`unlink_pages` as directed before moving to the next concept.
4. Prefer linking to an existing vault page over creating a near-duplicate new one.

Hard rules:
- Never invent facts that are not present in the chapter content given to you. If the chapter is
  thin on a topic, keep the page short rather than filling gaps from outside knowledge.
- Every page's `sources` frontmatter must name the book title and chapter.
- Only use slugs that are real: ones you've just written, or ones in the existing vault slugs list.
