#  Global Earthquake–Tsunami Risk Visualizer

## Overview
Interactive D3 map to explore tsunami-relevant earthquake characteristics (2001–2022) for A4 of CSC316. Each event is plotted at its epicenter; circle size/color reflect selected metrics, and filters update in real time. Data was sourced from the [Global Earthquake-Tsunami Risk Assessment Kaggle Dataset](https://www.kaggle.com/datasets/ahmeduzaki/global-earthquake-tsunami-risk-assessment-dataset?resource=download) and mapped with [GeoJSON world map data](https://geojson-maps.kyd.au/). The visualizer is available [here](https://karenrni.github.io/Earthquake-Tsunami-Risk-Visualizer/).


## Dataset Information

* **Name:** Global Earthquake–Tsunami Risk Assessment Dataset
* **Records Total:** 782 earthquakes (Mw ≥ 6.5)
* **Period:** 2001–2022
* **Geography:** worldwide (–62° to 72° lat; –180° to 180° lon)
* **Target:** `tsunami` (0/1)
* **Completeness:** no missing values in provided CSV

### Dictionary

| Field       | Type  | Description                                              | Units/Range        |
| ----------- | ----- | -------------------------------------------------------- | ------------------ |
| `mag`       | float | Moment magnitude (Mw)                                    | 6.5–9.1            |
| `cdi`       | int   | “Did You Feel It?” felt intensity (crowd reports)        | 0–9                |
| `mmi`       | int   | Modified Mercalli Intensity (observational/instrumental) | 1–9                |
| `sig`       | int   | USGS event significance score (impact-style composite)   | ~650–2910          |
| `nst`       | int   | Reporting seismic stations                               | 0–934              |
| `dmin`      | float | Distance to nearest station                              | degrees (0.0–17.7) |
| `gap`       | float | Azimuthal gap (network coverage)                         | degrees (0–239)    |
| `depth`     | float | Hypocenter depth                                         | km (2.7–670.8)     |
| `latitude`  | float | Epicenter latitude (WGS84)                               | –61.85 to 71.63    |
| `longitude` | float | Epicenter longitude (WGS84)                              | –179.97 to 179.66  |
| `Year`      | int   | Year of occurrence                                       | 2001–2022          |
| `Month`     | int   | Month of occurrence                                      | 1–12               |
| `tsunami`   | int   | Tsunami indicator (target)                               | 0 = no, 1 = yes    |

Note: `sig` is context/impact-oriented (not a pure predictor). `cdi` depends on public reporting (population/Internet bias). `mmi` measures shaking intensity, not tsunami presence.

##Limitations
