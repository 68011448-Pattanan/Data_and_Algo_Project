# Master prompt coverage

The two pasted master prompts supplied in this chat are identical. The PDF is a conceptual DS & Algorithms proposal. This implementation follows the requested mall workflows and the later instruction to use **1,100 bays on 11 floors**, with no changes to Version 1. Suggested technologies and example bay IDs are adapted to the existing Python project and dynamic assignment.

| Prompt area | Implemented behavior |
| --- | --- |
| Visitors, admin, security | Distinct navigation and workflow views using the role selector |
| Vehicle entry | Plate normalization, destination selection, persisted entry, assigned bay or waiting visit |
| Camera | Clearly labeled simulated plate input; no claim of OCR |
| Configurable destinations | 11 mall labels, editable in Settings, one per floor |
| Proximity / graph / A* | Explicit weighted graph, bay-to-destination ranking, separate entrance route, exact candidate pruning |
| Routing visualization | SVG floor map, floor ramp segments, start/destination markers, computed route and expanded-node animation |
| A* transparency | g/h/f, open heap nodes, expansion counts, candidate count, driving/walking distance, measured recommendation time |
| Hash table | Python plate dictionary with actual entry, search, confirmation update, exit/cancellation removal |
| Find my car | Location, floor, destination, entry, duration, estimate and walking path |
| FIFO | Explicit queue operations, visible positions/wait duration, cancellations, atomic exit/reopen promotion and local notifications |
| Exit / fee | Persisted exit timestamp, released bay, fee receipt, policy snapshot, queue handoff |
| Merge Sort | Explicit history sorting, both directions, full-timestamp comparison, divide/merge animation from actual records |
| Interactive map | 100 clickable/keyboard-operable bays per floor, available/assigned/parked/closed states, legend and detail dialogs |
| Bay detail | Status, vehicle, timestamps, duration, floor, destination proximity, nearest destination, total/today use, close/reopen actions |
| Multi-floor | 11 floor tabs and cumulative per-floor occupied / total overview |
| Dashboard | Capacity, available, occupied/assigned, occupancy, waiting, today's entries/revenue, completed duration and turnover |
| Charts | Historical hourly occupancy, entries vs exits, duration distribution and floor occupancy |
| Turnover / popularity | Bay assignments, uses per day, completed duration, Today/7/30/custom range and usage heatmap |
| Peak hours | Peak and average sampled occupancy, clock hour and arrival rate derived from stored visits |
| Analytics insights | Dynamic top-bay and peak-hour summaries; explicitly avoids causal claims without evidence |
| Data lifecycle | Actual state transitions persisted in SQLite; architecture and project pages explain the lifecycle |
| Algorithm lab | Real hash/queue operations, A* recommendation/animation, Merge Sort animation and complexity explanations |
| A* vs Dijkstra | Same start/bay and graph; both shortest-route distances and actual expanded-node counts |
| Architecture | Clickable component diagram with role explanations; animated flow arrows |
| Simulation | Entry, exit, generate 10/100, fill all bays, create queue, clear and reset demo data |
| Presentation | 12 steps, Previous/Next, links to working demonstrations and Fullscreen |
| Project context | Course 01416206, group Understaffed, problem, objectives, workflow, algorithms, stakeholders, limitations and future work |
| Consistency | Lock/transaction, active-plate and active-slot unique indexes, rollback reload, no closed/occupied recommendations |
| Accessibility | Semantic forms, accessible bay buttons, keyboard activation, visible focus, dialog trap/Escape, labels alongside colors, skip link |
| Responsive | Desktop sidebar, mobile menu, contained horizontal map scrolling, responsive cards/forms |
| Documentation | README installation, architecture, algorithms, data definitions, simulation, limitations and tests |

## Prototype adaptations

* The user's 1,100 bays / 11 floors replaces the prompt's sample 20-bay layout. `ABC-1234` and `XYZ-5678` can demonstrate the same workflow. The algorithm chooses a bay from actual availability; it does not guarantee the illustrative A-17 example.
* The website is a runnable local FastAPI/SQLite application. Next.js, Tailwind, shadcn, Recharts and Framer Motion are suggested technologies in the prompt, not required algorithms; equivalent responsive UI, SVG charts and animations are implemented in the existing stack.
* The conceptual PDF is adapted to bidirectional aisle edges, weighted ramp links and 11 mall destinations. Mall layouts and prices are illustrative. Walking and driving share the demonstration graph.
* Stakeholder views provide UI separation, not authenticated authorization. The README describes production requirements clearly.
* In-app notifications and five-second polling demonstrate queue assignment while the page is open. No real camera, hardware, SMS, payment or external mall integration is claimed.
* Peak occupancy uses reconstructed hourly samples; multi-day plots average each clock hour. Heatmap popularity is measured as assignments. These definitions appear in the UI/README.

## Validation record

* 26 automated tests pass covering core algorithms, state transitions, concurrency, restart persistence, fees, analytics and API validation.
* `node --check static/app.js` passes; Python modules compile successfully.
* `docker compose -f docker.yaml config --quiet` passes. Container image build/run has not been exercised.
* Desktop browser registration and confirmation passed for `ABC-1234` at the Cinema destination.
* Full-capacity browser scenario passed: 1,100 occupied bays, `XYZ-5678` FIFO #1, exit of `ABC-1234`, fee receipt and promotion of `XYZ-5678` to the released E-27 bay.
* A* and Merge Sort browser animations completed. A* vs Dijkstra used the same bay: 45 vs 997 expanded nodes, both 820 m.
* At 390 × 844, the visitor page had a 390 px document width; the large map scrolls inside its panel. The mobile menu opens/closes and hidden navigation is not focusable.
* Browser car lookup found a seeded Thai plate and rendered its walking path. Settings save, 30-day/custom-date analytics, presentation Previous/Next, bay close/reopen, and incident creation/resolution passed.
* Final desktop preview is 1440 × 1080. Browser connection failures during a deliberate backend restart were identified as network interruptions, not script exceptions; the final fresh session reported zero console errors or warnings.
* Screenshots: `output/playwright/desktop.png` and `output/playwright/mobile-visitor.png`.
