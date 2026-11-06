# RCS COMMAND

Intelligent freight clearance and digital twin for the Rolling Clearance System on the Mombasa-Northern Corridor.

*Measure once. Verify everywhere. Keep freight moving.*

A truck is weighed at its first trusted point: the port gate-out, an approved loading-site scale, or the first road
station. It receives an Ed25519-signed Load Compliance Token, and later stations verify that token instead of stopping it.

**This is a demonstration.** Traffic, sensors and results are simulated from assumptions in the two RCS documents. Agency
integrations are labelled mocks. Nothing here has regulatory approval, and no modelled figure is a measured result.

## Run it

### Docker

```
cp .env.example .env
docker compose up --build
```

Open http://localhost:3000. API docs are at http://localhost:8000/docs.

### Local, no Docker

Needs Python 3.12 and Node 22 or later. This uses SQLite and needs no other services.

```
cd backend
python -m venv .venv
.venv\Scripts\activate          # Linux and macOS: source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn rcs.main:app --port 8000 --timeout-keep-alive 120
```

In a second terminal:

```
cd frontend
npm install --include=dev
npm run build
npm start
```

The long keep-alive matters: Next.js reuses connections to the API, and with uvicorn's 5-second default some proxied requests fail with a reset.

Open http://localhost:3000, using `localhost` for both, because the session cookie is shared by hostname.
The first boot migrates and seeds the database, then pre-runs a few simulated hours so the corridor opens with traffic.

### Sign in

The login page has one-click demo roles. The password for all is `rcs-demo-2026`.

| Username | Role | Can do |
|---|---|---|
| `admin` | RCS administrator | Everything |
| `kenha` | KeNHA officer | Road clearance, officer approvals, tokens, faults, calibration |
| `kpa` | KPA gate operator | Port clearance |
| `kra` | KRA customs officer | Weight reconciliation, read only |
| `ntsa` | NTSA records officer | Vehicle records, read only |
| `transporter` | Transporter | Own fleet only, disputes |
| `loader` | Loading-site operator | Origin tickets for own site |
| `viewer` | Observer | Read only, can run simulations |

### Tests

```
cd backend
pytest
```

## A ten-minute demonstration

1. **Command Centre**: KPIs from the running engine.
2. **Digital Twin**: orbit, zoom, click a truck for its identity, weight and token, click a station for its queues.
3. Under **Watch a scenario**, pick *Compliant port truck*. The twin slows down and logs each decision.
4. Pick *Network failure*. Mariakani goes offline, clears the truck from its cached token, and syncs when the link returns.
5. **Sensors and Edge**: disable the WIM at Mariakani. The next trucks there go amber, marked fail-safe.
6. **Truck Clearance**: process a port truck with the sample button. The token appears in the registry.
7. **Token Registry**: open that token, run the tamper test, then revoke it. Process the same truck at a road station: amber.
8. **Verification Lane**: inject an overloaded truck, then open **Agency Portals, KeNHA** and approve the release order.
9. **Simulation**: change token coverage and run the scenario comparison, or apply a worse L1 sensor condition to L2 and the twin.
10. **Analytics**: run Monte Carlo and the tornado chart, then export CSV or PDF.

## Implemented

| Module | State |
|---|---|
| A. Command Centre | KPIs, charts, station table, events, alerts, all from engine state |
| B. Digital Twin | Three.js scene. Trucks are positioned by the engine; selection, follow, scenarios, gantries, queues |
| C. Truck clearance | Three streams plus lane, registration, profiles, validation |
| D. Token registry | Ed25519 signing, full lifecycle, verification, tamper test, revocation, history, audit |
| E. Decision engine | Port, origin, road, lane, static; policy editor; dry-run console; risk score; fail-safe |
| F. Rolling lane | Live schematic, measurements, eight test cases |
| G. Sensors and edge | Simulated telemetry, fault injection, ten-stage pipeline on a synthetic signal, offline mode and sync |
| H. Four levels | L1 quarter-car, L2 DES, L3 cell-transmission, L4 SimPy system model; linked run |
| I. Control room | All parameters, start, pause, reset, experiments, comparison, export |
| J. Analytics | 30 x 30-day Monte Carlo with CRN and CIs, tornado, CSV and PDF, provenance labels |
| K. Portals | KeNHA, KPA, KRA, NTSA, transporter, loader, admin, with row scoping |
| L. Alerts, audit, security | Alerts, hash-chained audit, RBAC, sessions, field encryption, retention |

## Mocked

| Integration | Reality |
|---|---|
| KRA iCMS, ACD, e-seals | `MockAdapters`, deterministic per container |
| KPA i-Gate, KWATOS | Mock release status |
| NTSA records | Mock flags; vehicles are seeded |
| KeNHA WIM feed | Simulated from the live engine |
| Sensors, cameras, LiDAR | Simulated. No device is attached |
| Duty officer in simulation | A labelled demo officer closes unattended cases after 12 simulated minutes. A person can act first |
| All plates, names, fleets, loaders | Synthetic |

## Limitations

* **Docker was not run.** It is not installed on the build machine, so the compose file and Dockerfiles are untested.
* **The MQTT bridge has not met a real broker.** Topic rules and failure handling are tested with a stand-in client; Mosquitto was not available.
* **PostgreSQL coverage is partial.** The migration and the API integration tests pass on a real PostgreSQL server, while day-to-day runs here used SQLite.
* **SUMO is not integrated.** L3 is a built-in macroscopic cell-transmission model, labelled in the UI.
* **L4 is software in the loop, not hardware in the loop.** Its latencies are assumptions, except the crypto timing, which is measured.
* **Redis is not used.** One process holds the working set, so scaling out would need it.
* **The model is not validated** against field data. See [docs/VALIDATION.md](docs/VALIDATION.md).
* **The twin is schematic.** Highways are compressed and the geography is approximate.
* **Fee figures are illustrative**, a straight line through one documented point. Legal limits must be re-verified.
* **An offline site cannot see a revocation** made after its link dropped, until it syncs.
* **Security gaps before any real use:** TLS, device certificates, MFA, rate limiting, key rotation and a managed secret store.
  The demo passwords are public. The Data Protection Act, 2019 is a design goal, not a compliance claim.
* Audit retention is stored but not enforced, because deleting rows would break the hash chain. It needs chain checkpoints first.
* Rendering the twin needs WebGL; the UI is designed for desktop command-centre screens first.

## Documentation

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, level links, failure handling, decisions
* [docs/VALIDATION.md](docs/VALIDATION.md): reproduced source tables, verification, inputs to measure
* [docs/API.md](docs/API.md): REST and WebSocket overview. Full OpenAPI at `/docs`
* Schema and migrations: `backend/rcs/models.py`, `backend/alembic/versions`
