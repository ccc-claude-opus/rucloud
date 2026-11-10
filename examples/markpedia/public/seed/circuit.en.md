> Filed under: [Engineering and Technology](#/p/cat-gong) › [Electrical and electronic engineering](#/p/cat-electrical)

## Overview

**Circuit** is a network of resistors, capacitors, inductors, diodes and semiconductor devices that guides current along defined paths to generate, amplify, rectify, filter or store signals. The basic language of analysis is Ohm's law together with Kirchhoff's laws, while real design must simultaneously respect bandwidth, noise, power dissipation and component cost.

## Components and analysis laws

Series resistances add directly as $ R_t = \sum R_i $, while parallel combinations satisfy $ \frac{1}{R_t} = \sum \frac{1}{R_i} $. For larger networks, Kirchhoff's current law states that current entering a node equals current leaving it, and Kirchhoff's voltage law states that the algebraic sum of voltages around any loop is zero. The table below lists the relation and typical magnitude of common elements.

| Element | Relation | Unit and typical value |
| --- | --- | --- |
| Resistor | $ V = IR $ | Ω; 1 kΩ and 10 kΩ are most common |
| Capacitor | $ i = C \frac{dv}{dt} $ | F; time constant $ \tau = RC $ |
| Inductor | $ v = L \frac{di}{dt} $ | H; stored energy $ E = \frac{1}{2} L I^2 $ |
| Diode | about 0.7 V forward drop (silicon) | Silicon, germanium, Schottky |
| MOSFET | $ I = \frac{1}{2} \mu C_{ox} \frac{W}{L} (V_{gs} - V_{th})^2 $ | Core of switching and amplification |

## AC, resonance and three-phase power

Under alternating current the inductive reactance is $ X_L = 2 \pi f L $ and the capacitive reactance is $ X_C = \frac{1}{2 \pi f C} $, and the two in series resonate at $ f_0 = \frac{1}{2 \pi \sqrt{LC}} $. Taking $ L = 10 \ \mu \mathrm{H} $ and a target of 1 MHz, the required capacitance is about 2.5 nF. The real power of a balanced three-phase load is $ P = \sqrt{3} V_L I_L \cos \phi $, with the power factor angle typically 0.8 to 0.9 for lagging loads.

## Voltage criteria for digital logic

Digital circuits encode bits as voltage ranges rather than exact levels. Conventional TTL at a 5 V supply requires an input high of at least 2.0 V and an input low no greater than 0.8 V, with typical outputs near 2.4 V high and below 0.4 V low. CMOS families run at 1.8 V, 3.3 V or 5 V, draw almost no static power, and consume dynamic power roughly proportional to $ C V^2 f $.

## Related articles

- [Semiconductor](#/p/semiconductor)
- [Telecommunications](#/p/telecommunications)
- [Software engineering](#/p/software-engineering)
- [Computer network](#/p/computer-network)
- [Web development](#/p/web-development)
- [Markdown syntax](#/p/markdown)
