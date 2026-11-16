> Filed under: [Engineering and Technology](#/p/cat-gong) › [Information technology](#/p/cat-info-tech)

## Overview

**Web development** is the work of building websites and online applications on browsers and servers, with the front end responsible for presentation and interaction and the back end for data processing and business logic. Its foundation rests on three standards — HTML for structure, CSS for presentation and JavaScript for behaviour — exchanging data mainly over HTTP.

## From the public web to modern frameworks

The decisive milestones in web technology cluster between the mid-1990s and the early 2020s, and they shaped the division of labour between front end and back end seen today. Each new capability lowered implementation cost while raising expectations for performance and security. The table below summarises these milestones and their effects.

| Year | Milestone | Significance |
| --- | --- | --- |
| 1991 | First public website goes live | The Internet moves from research network to public service |
| 1993 | Mosaic browser and HTML 1.0 | Pages reach non-specialist users |
| 1995 | JavaScript released | The browser gains scripting for the first time |
| 1997 | HTTP/1.1 and CSS 1 | Transfer and styling become standardised |
| 2004 | Web 2.0 and widespread Ajax | Partial page updates, rise of social sites |
| 2015 | HTTP/2 standardised | Multiplexing over one connection, fewer handshakes |
| 2022 | HTTP/3 (QUIC) | UDP-based, with 0-RTT and 1-RTT handshakes |

## The front-end rendering pipeline and performance metrics

After receiving HTML, the browser parses it, builds a CSSOM, assembles a render tree, performs layout and finally paints the pixels; blocking resources and long tasks dominate the delay. Google's core web vitals set quantitative thresholds: Largest Contentful Paint (LCP) no more than 2.5 seconds, Interaction to Next Paint (INP) no more than 200 milliseconds, and Cumulative Layout Shift (CLS) no more than 0.1.

## Back-end interfaces and status codes

Back ends commonly expose resources in a REST style, with meaning carried by the HTTP method (GET, POST, PUT, DELETE) together with the status code — 201 for created, 404 for missing, 429 for too many requests. In practice a Cache-Control header governs caching, and responses are compressed with gzip or Brotli, which typically shrinks text to 20 % to 30 % of the original size and directly cuts both latency and transfer cost.

## Related articles

- [Software engineering](#/p/software-engineering)
- [Computer network](#/p/computer-network)
- [Markdown syntax](#/p/markdown)
- [Mermaid diagrams](#/p/mermaid)
- [Cloudflare Workers](#/p/cloudflare-workers)
- [Machine](#/p/machine)
