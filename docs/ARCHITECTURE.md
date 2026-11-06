# RCS COMMAND architecture

## Principle

Weigh a truck at its first trusted weighing point, issue a signed Load Compliance Token, and let later stations verify
that token instead of repeating the process. Everything in the system serves that loop.

## Components

```
Browser (Next.js, React Three Fiber, Recharts)
   | REST /api (Next rewrite)              | WebSocket /api/ws/live
   v                                       v
FastAPI ---- routers: ops, twin, simulation, portals
   |
   +-- LiveEngine (rcs/sim/live.py): agents on tracks, 10 Hz, emits frames, KPIs, events, alerts
   |      +-- Decision engine (rcs/domain/decision.py): pure functions
   |      +-- Registry (rcs/services/registry.py): token lifecycle, per-site cache semantics
   |      +-- Sites: sensors, link state, outbox, sequence numbers
   |      +-- EventBus (rcs/services/bus.py): MQTT topic rules, optional broker bridge
   |
   +-- Simulation levels (rcs/sim/): L1 sensor, L2 process, L3 traffic, L4 system, Monte Carlo
   |      run in threads and a process pool, tracked as Experiment rows
   |
   +-- WriteBehind (rcs/db.py): batches inserts from the engine
   v
PostgreSQL (Docker) or SQLite (local). Alembic owns the schema.
```

## How the four levels link

| Link | Mechanism | Where |
|---|---|---|
| L1 to L2 | `scale_errors()` derives road, port, lane and origin errors from the sensor model. "Apply" writes them into the shared `SimConfig`, so margins move too (margin = k x error). | `rcs/sim/l1_sensor.py`, `POST /api/sim/l1/apply` |
| L1 to live twin | The same `SimConfig` feeds the live engine's readings and policy. | `LiveEngine.apply_config` |
| L2 to L3 | L2 produces five-minute arrivals into each station's mainline, lane and static queue. L3's cell-transmission model takes those as demand. | `station_demand()`, `run_l3()` |
| L2 to L4 | L2's trucks per site set L4's offered message load. | `rcs/api/simulation.py` |
| L4 to live twin | Fault injection and random outages act on the live site state: links, edge units, sensors, the token service and the mock customs API. Those failures change the decisions trucks receive. | `rcs/api/twin.py`, `LiveEngine.set_link` |

## Live engine

Trucks are agents on `Track` objects (polylines with a rate and a minimum gap). A truck can only enter a track with room,
so queues and spillback onto the mainline emerge from geometry and service times. No queue is scripted.

The twin compresses the highways so that flows are visible: 35 km of road takes about 4 simulated minutes. L2 keeps the
real travel times. The twin is labelled schematic on screen.

Each decision point builds a `Measurement` from the site's sensors. A disabled sensor means a missing value, and the decision
functions never return green on missing data. Failure handling:

| Failure | Behaviour |
|---|---|
| WIM, ADC or loops down | No weight: amber, divert to the lane |
| LiDAR down | No dimensions: amber |
| ANPR or RFID down | Identity confidence falls below 0.8: amber |
| Lane scale down | Inconclusive: static scale |
| Edge unit down | Gantry defaults to amber, existing static process |
| Cloud link down | Offline mode: cached tokens, local decisions, signed road tokens stay `ISSUED`, records queue in the outbox |
| Link restored | Outbox replays, offline tokens become `ACTIVE`, recovery time recorded |
| Token service down | Every site behaves as offline |
| Mock customs API down | Release unknown: port trucks go to re-weigh, never green |

An offline site cannot see a revocation made after its link dropped. This is an inherent cost of edge operation, is
asserted by a test, and should be weighed by reviewers; the validity window and later audit limit its exposure.

## Decision engine

`rcs/domain/decision.py` has one function per stage: port, origin, road, lane and static. They return an outcome, an action,
reasons, a check list, a risk score and a confidence value.

* Clear only if reading plus margin is at or below the limit.
* A tokened truck only proves it is unchanged, using consistency tolerances of 8% for first-point tokens and 11% for road tokens.
* Road nodes never issue red when a lane is available: anything doubtful diverts (RCS v2 s6.4). The lane issues red.
* Screening never proves overload. `decide_lane` returns `STATIC_SCALE`, and only `decide_static` returns
  `requires_officer`. Cases wait for an officer in the KeNHA portal; in simulation a labelled demo duty officer acts after 12
  simulated minutes unless a person acts first.

## Token

Fields are in `rcs/domain/tokens.py::build_payload`. Signature: Ed25519 over canonical JSON (sorted keys, no whitespace).
Each site holds its own key, wrapped with the master key in the database, so an edge node can sign while offline. Public keys
are at `GET /api/tokens/keys`, so anyone can verify a token independently.

Lifecycle: `PENDING -> ISSUED -> ACTIVE`, then `EXPIRED`, `SUSPENDED`, `FLAGGED` or `REVOKED`. `EXPIRED` and `REVOKED` are terminal.
`PENDING` lasts only for the moment between assembling and signing, and `ISSUED` means signed at the edge and not yet seen by the registry.

## Security

| Control | Implementation |
|---|---|
| Authentication | scrypt password hashes, server-side sessions, HttpOnly SameSite=Lax cookie |
| Authorization | Role-permission map in `rcs/security.py`, plus row scoping for transporters and loaders |
| Integrity | Ed25519 on tokens, clearance records and release orders; SHA-256 hash chain on the audit log |
| Encryption at rest | Fernet for driver names, fleet contacts and signing keys |
| Data protection | Retention settings with plate pseudonymization and deletion |
| WebSocket | Authenticated from the same session cookie |

Kenya's Data Protection Act, 2019 is a design requirement here. This is not a claim of compliance.

Not done: TLS termination, device certificates, MFA, rate limiting, key rotation. See the README limitations.

## Technology decisions

| Decision | Why |
|---|---|
| SQLite default, PostgreSQL through config | Runs with no setup; Docker uses PostgreSQL through the same SQLAlchemy models and migration |
| In-process bus with MQTT topic rules | Mosquitto is unavailable here; the same topics are bridged to a broker when `RCS_MQTT_URL` is set |
| No Redis | The engine holds the working set in one process, so Redis would add nothing today. Scaling beyond one process would need it |
| Built-in cell-transmission model | SUMO is not installed; labelled in the UI, with no individual lane changes |
| SimPy plus a heap kernel for L2 | SimPy for interactive runs; the kernel makes 30 x 30-day Monte Carlo practical. A test proves they agree |
| scrypt, not Argon2 | Standard library, no extra native dependency |
