# API overview

Interactive OpenAPI documentation: `http://localhost:8000/docs`. Machine-readable: `/openapi.json`.

Authentication: `POST /api/auth/login` sets an HttpOnly session cookie. A role without a permission receives 403.

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Trucks | `GET,POST /api/trucks`, `GET /api/trucks/options`, `GET /api/trucks/{plate}` |
| Clearance | `POST /api/clearance/port`, `/origin`, `/road`, `/lane`; `GET /api/clearance/events[/{id}]` |
| Tokens | `GET /api/tokens`, `GET /api/tokens/keys`, `GET /api/tokens/{id}`, `GET /api/tokens/{id}/signature`, `POST /api/tokens/{id}/status`, `POST /api/tokens/verify` |
| Decisions | `POST /api/decisions/evaluate` (dry run), `GET,PUT /api/decisions/policy` |
| Live | `GET /api/live/kpi`, `/series`, `/events`, `/frame`; `POST /api/live/control`; `GET,PUT /api/live/config` |
| Twin | `GET /api/twin/network`, `/trucks/{id}`, `/stations[/{id}]`, `/scenarios`; `POST /api/twin/scenarios/{id}/start`, `/stop` |
| Faults | `POST /api/faults/{site}/sensor/{sensor}`, `POST /api/faults/{site}/network`, `POST /api/faults/global` |
| Lane | `GET /api/lane/{station}`, `POST /api/lane/{station}/inject` |
| Sensors | `GET /api/sensors[/{site}]`, `POST /api/sensors/pipeline/run` |
| Simulation | `POST /api/sim/l1/run`, `/l1/curves`, `/l1/derive`, `/l1/apply`, `/l2/run`, `/l3/run`, `/l4/run`, `/linked/run`, `/monte-carlo`, `/tornado` |
| Experiments | `GET /api/sim/experiments[/{id}]`, `DELETE ...`, `GET .../export.csv`, `GET .../export.pdf` |
| Portals | `GET /api/portals/kenha`, `/kpa`, `/kra`, `/ntsa`, `/transporter`, `/loader`; `POST /api/portals/loader/{site}/flags` |
| Officer | `POST /api/cases/{id}/decide`, `POST /api/calibration`, `GET,POST /api/disputes`, `POST /api/disputes/{id}/resolve` |
| Alerts and audit | `GET /api/alerts`, `POST /api/alerts/{id}/ack`, `GET /api/audit` |
| Admin | `GET /api/admin/users`, `POST /api/admin/users/{id}/active`, `GET,PUT /api/admin/retention`, `POST /api/admin/retention/run`, `GET /api/admin/health` |
| Search | `GET /api/search?q=` |

Long jobs return `{job_id}`. Poll `GET /api/sim/experiments/{job_id}` for `status`, `progress`, `message` and `result`.

## WebSocket

`ws://localhost:8000/api/ws/live`, authenticated by the session cookie. JSON messages:

| `t` | Rate | Content |
|---|---|---|
| `frame` | 5 Hz | `now`, `trucks` rows `[id, x, z, heading, state, hero, mode, axles]`, gantry states. State: 0 pending, 1 green, 2 amber, 3 red |
| `kpi` | 1 Hz | All dashboard values, stations, system layer, conservation, active scenario |
| `events` | On decision | Clearance events |
| `alerts` | On alert | Alerts |

## MQTT topics

`rcs/v1/{site}/clearance`, `rcs/v1/{site}/token`, `rcs/v1/{site|system}/alert`. In process by default. Set `RCS_MQTT_URL` to mirror them to a broker.

## Verifying a token independently

```python
import json, base64, requests
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

def dec(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

# token = payload, signature and kid from GET /api/tokens/{id}; public_key from GET /api/tokens/keys
message = json.dumps(token["payload"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
Ed25519PublicKey.from_public_bytes(dec(public_key)).verify(dec(token["signature"]), message)  # raises if altered
```
