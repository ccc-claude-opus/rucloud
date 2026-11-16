> Filed under: [Engineering and Technology](#/p/cat-gong) › [Information technology](#/p/cat-info-tech)

## Overview

**Markdown syntax** is a lightweight markup language proposed by John Gruber in 2004 that expresses document structure in plain text using simple symbols, with the stated goal of being easy to read and write even if the rendered output is merely adequate. It is widely used for source comments, documentation and blog posts, and the 2014 CommonMark specification settled long-standing ambiguities in its syntax.

## Design goals and the road to a specification

Markdown borrowed its syntax from existing plain-text conventions in email and newsgroup forums, such as asterisks for emphasis and hyphens for lists. The original release had no formal specification, and Gruber later conceded that parts of the syntax were ambiguous, which prompted the community to start the CommonMark effort in 2012. Version 0.9 followed in 2014, and GitHub extended it into GFM with tables, task lists, footnotes and autolinks. CommonMark is now the compatibility baseline for most tooling.

## A tour of the core syntax

Markdown concentrates almost everything into a handful of punctuation marks, giving a low learning curve while covering most document formatting needs. Because no dedicated editor is required, it can be written wherever plain text is accepted, with the rendering left to a separate converter.

| Written as | Result | Notes |
| --- | --- | --- |
| `# Heading` | Heading | One to six hashes give levels one to six |
| `**bold**`, `*italic*` | Emphasis | Nestable, asterisks or underscores |
| `` `inline code` `` | Monospaced text | More backticks than content lets you embed backticks |
| `> quote` | Block quote | Nestable, building a hierarchy of quotations |
| `- item`, `1. item` | List | CommonMark supports nested lists |
| `[text](url)` | Link | Reference-style links are also available |
| `![alt text](url)` | Image | Same syntax as a link, prefixed with an exclamation mark |
| `---` | Horizontal rule | Three or more consecutive hyphens |
| Pipe table | Aligned columns | A GFM extension, not part of core CommonMark |

## Limitations and where it fits

Markdown offers no page layout, headers or style control, and it has no standard syntax for comments, footnotes or cross references, so complex formatting still relies on embedded HTML or converters such as Pandoc. It therefore fits technical documentation, README files kept under version control, and issue or pull request discussions best, while formal publishing and slide design are handled by dedicated formats.

## Related articles

- [Software engineering](#/p/software-engineering)
- [Computer network](#/p/computer-network)
- [Web development](#/p/web-development)
- [Mermaid diagrams](#/p/mermaid)
- [Cloudflare Workers](#/p/cloudflare-workers)
- [Machine](#/p/machine)
