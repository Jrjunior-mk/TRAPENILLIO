# Model validation

All results are **modelled**. Only the 8,000 trucks/day figure and the reported 98.5% compliance come from public reporting;
the rest are assumptions from the RCS documents. This page records what the model reproduces and what still needs measuring.

## Verification against the source documents

The test suite enforces these, on a clean configuration (violation, fraud, misdeclaration and outage rates set to zero, because
the document's table excludes them). `tests/test_l2.py`.

| RCS v2 Section 9 | Document | This model (25 days, one replication) | Test tolerance |
|---|---|---|---|
| Lane share at 30% coverage | 17.3% | 17.7% | 0.8 points |
| Static share at 30% coverage | 10.0% | 9.8% | 0.8 points |
| Lane share at 50% | 13.3% | 13.6% | 0.8 points |
| Static share at 50% | 7.1% | 7.0% | 0.8 points |
| Lane share at 70% | 9.3% | 9.5% | 0.8 points |
| Static share at 70% | 4.3% | 4.2% | 0.8 points |
| Lane share at 90% | 5.2% | 5.4% | 0.8 points |
| Static share at 90% | 1.5% | 1.4% | 0.8 points |
| Road-only static baseline | 20.9% | 21.5% | 1 point |
| Road-only with audits | 23.3% | 23.9% | 1 point |
| Port re-weigh at 85% loading | 14.9% | 14.6% | 1 point |
| Port re-weigh with 5% allowance | about 1.3% | 1.2% | 0.5 points |
| Later-station lane share | about 3.3% | 3.3% | 0.4 points |
| Later-station static share | almost none | 0.0% | under 0.2% |
| Lane capacity | about 370 trucks/h | 371 trucks/h | 5 trucks/h |

The reproduction used the same assumptions the document states, so it shows the model is built the way the document describes.
It says nothing about whether those assumptions are true.

## Monte Carlo at the default demonstration settings (MODELLED)

The full design from RCS v2 s10.4: 30 replications, 30 simulated days each, 2-day warm-up, common random numbers across
scenarios, six scenarios, 46 million simulated trucks. Run through the application (experiment "Full design"), about 80 seconds
here. Values are means with 95% confidence half-widths. Every truck that entered also left, in every replication.

| Scenario | Static stops per 1,000 trucks | Lane passes per 1,000 | Port re-weigh % | Mean delay (min) | Truck-hours saved per day | False-clear % |
|---|---|---|---|---|---|---|
| Existing road-only process | 374.3 ± 0.6 | 0 | 0 | 2.41 | baseline | 0.00 |
| Original RCS proposal | 286.2 ± 0.3 | 0 | 0 | 1.87 | 71.7 ± 0.3 | 0.01 |
| Port-anchored RCS v2 | 140.4 ± 0.3 | 0 | 15.3 | 1.59 | 109.0 ± 0.4 | 0.01 |
| RCS v2, all three streams | 19.5 ± 0.1 | 83.6 ± 0.3 | 15.3 | 0.96 | 193.6 ± 0.4 | 0.01 |
| RCS v2, increased coverage | 8.3 ± 0.1 | 67.4 ± 0.2 | 15.3 | 0.85 | 207.2 ± 0.5 | 0.01 |
| RCS v2, lane approved + 5% allowance | 6.3 ± 0.1 | 70.3 ± 0.2 | 2.0 | 0.29 | 282.4 ± 0.6 | 0.01 |

Static stops count every station visited, across all stations on a route. These intervals only reflect simulation noise. They
do not reflect uncertainty in the assumptions, which is far larger; the sensitivity chart gives a better sense of that.

Reading it honestly, as RCS v2 s9 does: near-limit checks move from the road to the port rather than vanish (15% of port trucks
re-weigh there). The largest gain depends on two policy decisions that nobody has made: approving the lane scales and applying the allowance.

Sensitivity (10 days, 6 replications, RCS v2 s10.4 ranges). Static stops per 1,000, base 19.7: token coverage moves it most
(74.7 at 50% coverage, 5.7 at 100%), then average loading (9.3 at 75%, 29.7 at 90%). Delay hours per day, base 127: average loading
moves it most (61 at 75%, 212 at 90%), then token coverage and port scale error. Fleet enrolment and the real loading distribution
are the assumptions that matter most, so measure those first.

## Verification of the method (RCS v2 s10.5)

| Check | How |
|---|---|
| Conservation | Every truck exits exactly once, in each scenario (SimPy) and over time in the live engine |
| Erlang C | The queue kernel matches the formula for c = 1, 2 and 8 within 8% |
| Two engines | The SimPy model and the heap kernel return the same delays within 1% |
| Reproducibility | Same seed gives identical results in L2 and in the live engine |
| Common random numbers | Paired differences have lower variance than unpaired ones |
| Hand-traced trucks | The eight scenarios and the single-truck tests assert the exact decision sequence |
| Differential | The vectorised thresholds agree with the decision engine on random trucks |

## Differences between the L2 model and the live engine

* The live engine adds ANPR and RFID misreads (0.3% and 0.2%), which divert trucks. L2 omits them, so the live lane share runs slightly higher.
* The live engine compresses highway travel time. L2 uses 25 to 35 minutes per section.
* L3 is macroscopic, smooths L2's five-minute counts over 30 minutes, and does not feed back into L2.

## Inputs that still need real measurement (RCS v2 s10.6)

| Input | Current value | How to measure | Owner |
|---|---|---|---|
| Stream mix: port, origin, untokened | 65 / 25 / 10 (placeholder) | Classification counts | KeNHA, KTA |
| Load distribution | Mean 85%, spread 12% | Weighbridge logs | KeNHA |
| Static service time, lanes, stop overhead | 4 min, 8 lanes, 2 min | Observation at Mariakani, logs | KeNHA |
| Lane pass cost | 1.5 min | Prototype lane | RCS |
| Scale errors | Port 1%, road 2.5%, lane 1% | OIML R134 and COST 323 tests | RCS, calibrator |
| Peak factor and time-of-day shape | 1.5, assumed shape | Gate and weighbridge logs | KPA, KeNHA |
| Dimension and lifted-axle violations | 0.3%, 0.2% (placeholder) | Static-bridge study | KeNHA |
| Token fraud | 0.1% (placeholder) | Audit results | RCS |
| Misdeclaration | 0.5% (placeholder) | Declared-weight sample | KRA |
| Port re-weigh capacity and time | 6 lanes, 4 min (placeholder) | Time-and-motion at the i-Gate | KPA |
| Outage frequency and duration | 0.5/day, 30 min (placeholder) | Site logs | Operators |
| Dimension limits | 4.3 x 2.65 x 22 m (not in the documents) | Confirm with KeNHA | KeNHA |
| 5-axle gross limit | 42 t (not in the documents) | Legal schedules | KeNHA |
| Route shares | Schematic | Trip data | KTA |
| L1 coefficients | Tuned to the document's error targets | Reference truck campaign | RCS |

## Validation not yet done

RCS v2 s10.5 accepts the model if simulated as-is delay is within about 15% of measured baselines and peak queues align. **No
baseline exists yet, so this has not been done.** The go/no-go figure on the Analytics page is therefore a modelled indication,
not the gate itself.
