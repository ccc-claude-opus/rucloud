> Filed under: [Engineering and Technology](#/p/cat-gong) › [Information technology](#/p/cat-info-tech)

## Overview

**Computer network** is a communication system in which many devices exchange data under a shared set of protocols, classifiable by topology, scale or layering model. Modern networks run on layered stacks, of which the Internet protocol suite (TCP/IP) is the most widely deployed, splitting problems such as segmentation, addressing and reliable delivery into separate layers.

## Layered models and data units

Network protocols are layered so that complicated communication problems split into parts that can be implemented and swapped independently. The OSI reference model (ISO 7498, 1983) defines seven layers, while the Internet TCP/IP model simplifies this to four. The mapping and the data unit handled at each layer appear below. The practical value of layering is that changing the physical medium, for example from copper to fibre, does not force rewrites of the applications above.

| OSI layer | TCP/IP layer | Data unit | Typical protocols and devices |
| --- | --- | --- | --- |
| Application, presentation, session | Application | Data | HTTP, DNS, SMTP |
| Transport | Transport | Segment | TCP, UDP, ports |
| Network | Internet | Packet | IP, ICMP, routers |
| Data link | Network access | Frame | Ethernet, Wi-Fi, switches |
| Physical | Network access | Bit | Cables, fibre, radios |

## Addressing and address translation

Addressing underpins interoperability. IPv4 uses 32-bit addresses, a space of $ 2^{32} \approx 4.3 \times 10^9 $ that has long been fully allocated, so network address translation (NAT) is used in practice to let many hosts share a single public address. IPv6 offers 128 bits, roughly $ 3.4 \times 10^{38} $ addresses, reserving the upper $ 64 $ bits as the network prefix and the lower $ 64 $ bits as the interface identifier.

## Capacity estimates and technical progress

Link capacity is estimated with the Shannon formula $ C = B \log_2(1 + S/N) $, where $ B $ is bandwidth and $ S/N $ the signal-to-noise ratio, showing that at fixed bandwidth only a better signal-to-noise ratio adds throughput. Ethernet has advanced from the 10 Mb/s standard of 1983 to 400 Gb/s, while Wi-Fi 6E added the 6 GHz band in 2021 and Wi-Fi 7 (802.11be) was ratified in 2024.

## Related articles

- [Software engineering](#/p/software-engineering)
- [Web development](#/p/web-development)
- [Markdown syntax](#/p/markdown)
- [Mermaid diagrams](#/p/mermaid)
- [Cloudflare Workers](#/p/cloudflare-workers)
- [Machine](#/p/machine)
