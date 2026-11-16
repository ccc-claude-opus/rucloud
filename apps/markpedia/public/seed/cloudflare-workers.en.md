> Filed under: [Engineering and Technology](#/p/cat-gong) › [Information technology](#/p/cat-info-tech)

## Overview

**Cloudflare Workers** is a serverless platform that runs JavaScript directly on Cloudflare edge nodes to handle incoming HTTP requests, removing the need to manage origin servers. Code is pushed to hundreds of cities worldwide and executed nearby, so routing decisions, content rewrites and caching complete within tens of milliseconds.

## The execution model and its evolution

Workers entered beta in 2018 and reached general availability in 2019. The runtime is a V8 isolate rather than a virtual machine or a container: each isolate has its own memory and stack, so start-up cost is tiny and there is no cold start of the kind common in traditional cloud platforms. After 2020 the platform gained KV, Durable Objects, R2 object storage and the D1 database, expanding from edge scripting into a full application platform.

## Pricing and technical limits

Workers are offered on free and paid plans, and the request allowance and CPU ceiling are the main factors in choosing between them. Billing counts requests, with additional charges for CPU time and for external services consumed, which keeps budgets relatively easy to estimate.

| Item | Specification |
| --- | --- |
| Runtime | V8 isolate, isolated execution rather than a container |
| Cold start | None; isolates are kept warm in advance |
| Free allowance | 100,000 requests per day |
| Paid allowance | Workers Paid includes 10 million requests per month |
| Free CPU limit | 10 ms of CPU time per request |
| Domains | Requires a custom domain or a workers.dev subdomain |

## Where it fits and where it does not

Workers is at its best with light logic applied before a request proceeds: routing by geography or device, A/B testing, OAuth token validation, CORS header handling, bot filtering and path rewriting onto a new API. The limits are the absence of a traditional file system and some native networking capabilities, together with a hard CPU ceiling per request, which rules out long-running batch jobs; those are better left to long-lived compute or cloud queues.

## Related articles

- [Software engineering](#/p/software-engineering)
- [Computer network](#/p/computer-network)
- [Web development](#/p/web-development)
- [Markdown syntax](#/p/markdown)
- [Mermaid diagrams](#/p/mermaid)
- [Machine](#/p/machine)
