# Helsinki demo

The NGSI-LD data source on one dashboard, fed with live open data of Helsinki: measured air quality,
trams on the move, the next day's events and places in the city centre. Needs Docker with Compose and
internet access for the feeds.

```bash
docker compose up -d
```

Grafana installs the plugin from the
[GitHub release](https://github.com/joinedcontext/Grafana-NGSI-LD-data-source/releases/tag/v8.2.0) the dashboard is made for before it starts. Then open
http://localhost:3000. `docker compose down` stops the demo and keeps its history; `docker compose down -v`
also deletes it.

| Service | Purpose |
|---|---|
| `postgres` | PostGIS 17 (`ghcr.io/baosystems/postgis:17-3.5`): the broker's store, current state and history, in the `postgres` volume. Not published; `POSTGRES_PASSWORD` sets its password |
| `antares` | `ghcr.io/joinedcontext/antares-broker:0.2.0` (`ANTARES_VERSION` picks another) with `ANTARES_STORE=postgres`, NGSI-LD API on http://localhost:9090/ngsi-ld/v1 |
| `seed` | Runs `../../datasource/seed/seed.mjs --places-only` on every `up`: City Hall, Helsinki Cathedral, Mannerheimintie, Senate Square, Esplanadi and Kaisaniemi park |
| `air` | `feeds/fmi.mjs`: the air quality stations of the Finnish Meteorological Institute in Helsinki, Espoo and Vantaa as `AirQualityObserved` entities, with 48 h of hourly history on start and each new hour after |
| `hsl` | `feeds/hsl.mjs`: HSL's public vehicle positions (`mqtts://mqtt.hsl.fi:8883`, trams), up to 8 trams as `Vehicle` entities linked to their line (`PublicTransportRoute`) and the operator, each with `expiresAt` 8 minutes ahead |
| `events` | `feeds/events.mjs`: the next 24 h of events in central Helsinki from Linked Events as `Event` entities, linked to their venue (`PointOfInterest`) and the venues to the `City`; each expires when it ends |
| `grafana` | `grafana/grafana` with the plugin from the release, the data source and the dashboard `grafana/dashboards/helsinki-live.json` |

## Dashboard

- **Map**: parks, squares, buildings and Mannerheimintie (Geo, *Location: Shape*), the air quality
  stations, the venues of the next events, and the trams turned to their heading and labelled with their
  line. Each tram draws its trail of the time range (Geo, *Location: Trail*: the positions from the
  temporal API as one line per tram).
- **Next events**: table of the events with start, end (`expiresAt`), venue and category, and a pie chart
  by category.
- **Air quality**: the current index per station, PM2.5 history, the 6-hour NO2 average (temporal
  aggregation) and the index of each station over two days as a state timeline, in FMI's colours.
- **Trams**: speed and delay history (temporal) and a table of the trams on the broker now.
- **Node graphs**: trams, their lines and the operator; events, their venues and the city.

The dashboard refreshes every 10 seconds and shows the last 15 minutes; the air quality panels show the
last two days.

## Feeds and expiresAt

`expiresAt` keeps the broker to what is current: the broker removes an entity once the time passes, and
its history stays, so the map and the tables only show trams in service and events still to come while
the temporal panels keep everything.

- `hsl` follows the first 8 trams it sees. At most every 15 seconds per tram it upserts the position,
  speed, heading, delay and line, and moves `expiresAt` 8 minutes ahead. A tram silent for a minute gives
  its slot to the next one.
- `events` reads Linked Events every 15 minutes. An event expires at its end (or 3 hours after its start
  when it has none); a venue at the end of its last event.
- `air` replaces the stations and their history on start, then asks FMI every 10 minutes for new hours.
  FMI publishes each hour within about an hour, so the newest values lag behind the clock.

| Variable (`.env` next to `docker-compose.yml`) | Default | Meaning |
|---|---|---|
| `HSL_VEHICLES` | 8 | trams followed at once |
| `HSL_EXPIRES_MINUTES` | 8 | `expiresAt` distance from the last update |
| `GRAFANA_PORT`, `BROKER_PORT` | 3000, 9090 | host ports |
| `BIND_ADDRESS` | 127.0.0.1 | `0.0.0.0` publishes the ports on every interface |
| `GRAFANA_VERSION` | 12.3.0 | Grafana release (also tested: 13.2.4) |
| `NGSILD_PLUGIN_URL` | the v8.2.0 release zip | plugin zip, e.g. `https://github.com/joinedcontext/Grafana-NGSI-LD-data-source/releases/latest/download/ngsild-grafana-datasource.zip` |

The feeds also read `FMI_PLACE`, `HISTORY_HOURS`, `POLL_MINUTES`, `EVENTS_HOURS`, `EVENTS_MAX` and
`EVENTS_BBOX` (see the head of each script); set them under `environment` in `docker-compose.yml`.

Grafana logs everyone in as admin and Antares authenticates nobody, so publish the ports only on a trusted
network.

## Troubleshooting

`docker compose logs air hsl events` shows what each feed wrote. `docker compose restart air` writes fresh
air quality history, `docker compose run --rm seed` rewrites the places.

Tests of the feeds: `cd feeds && npm ci --ignore-scripts && npm test`.

## Developing the plugin

`docker-compose.dev.yml` swaps the release for the plugin source in `../../datasource/plugin`: the `plugin`
service runs the watch build in a container (no Node needed on your machine) and Grafana loads its `dist/`.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f plugin   # rebuilds
```

The first start installs the dependencies and builds, a few minutes. Then edit `src/`, wait for
`compiled successfully` in the log and reload the browser; a change to `plugin.json` needs
`docker compose restart grafana`. `docker compose up -d --remove-orphans` without the dev file returns to the release.
The development stack in `../../datasource` has the sample data and the integration tests.

## Data

- Air quality: Finnish Meteorological Institute open data, CC BY 4.0.
- Tram positions: Helsinki Regional Transport Authority (HSL) high-frequency positioning, CC BY 4.0.
- Events: City of Helsinki Linked Events, CC BY 4.0.
- Shapes: © OpenStreetMap contributors, ODbL, simplified.
