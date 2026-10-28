# Helsinki demo

The NGSI-LD data source on one dashboard: places and air quality in central Helsinki, and trams that move
live on the map. Needs Docker with Compose and internet access for the tram feed.

```bash
docker compose up -d
```

Grafana installs the plugin from the newest
[GitHub release](https://github.com/joinedcontext/Grafana-NGSI-LD-data-source/releases/latest) before it starts. Then open
http://localhost:3000. `docker compose down` stops the demo.

| Service | Purpose |
|---|---|
| `antares` | `ghcr.io/joinedcontext/antares-broker`, NGSI-LD API on http://localhost:9090/ngsi-ld/v1 |
| `seed` | Runs `../../datasource/seed/seed.mjs` on every `up`: three air quality stations with 48 h of hourly history ending now, City Hall, Helsinki Cathedral, Mannerheimintie, Senate Square, Esplanadi and Kaisaniemi park |
| `stations` | Keeps the three stations live: a new value of every air quality attribute each minute, on the same curves as the history |
| `hsl` | Reads HSL's public vehicle positions (`mqtts://mqtt.hsl.fi:8883`, trams) and writes up to 8 trams as `Vehicle` entities, each with `expiresAt` 8 minutes ahead |
| `grafana` | `grafana/grafana` with the plugin from the release, the data source and the dashboard `grafana/dashboards/helsinki-live.json` |

## Dashboard

- **Map**: parks and Senate Square, buildings, Mannerheimintie (Geo, *Location: Shape*), the stations
  and the trams, each tram turned to its heading and labelled with its line.
- **Air quality**: PM10 history, the 6-hour NO2 average (temporal aggregation) and the current values.
  The air quality data is generated, not measured: hourly for two days, then every minute.
- **Trams**: speed and delay history (temporal) and a table of the trams on the broker now.

The dashboard refreshes every 10 seconds and shows the last 15 minutes; the air quality panels show the
last two days.

## Trams and expiresAt

`hsl/hsl.mjs` follows the first 8 trams it sees. At most every 15 seconds per tram it upserts the position,
speed, heading, delay and line, and moves `expiresAt` 8 minutes ahead. A tram that stops reporting is
removed by the broker 8 minutes after its last update, so the map and the table only show trams in
service; its history stays and the temporal panels keep it. A tram silent for a minute gives its slot to
the next one.

| Variable (`.env` next to `docker-compose.yml`) | Default | Meaning |
|---|---|---|
| `HSL_VEHICLES` | 8 | trams followed at once |
| `HSL_EXPIRES_MINUTES` | 8 | `expiresAt` distance from the last update |
| `GRAFANA_PORT`, `BROKER_PORT` | 3000, 9090 | host ports |
| `BIND_ADDRESS` | 127.0.0.1 | `0.0.0.0` publishes the ports on every interface |
| `GRAFANA_VERSION` | 12.3.0 | Grafana release (also tested: 13.2.4) |
| `NGSILD_PLUGIN_URL` | newest release zip | plugin zip, e.g. `https://github.com/joinedcontext/Grafana-NGSI-LD-data-source/releases/download/v8.0.0/ngsild-grafana-datasource.zip` |

Grafana logs everyone in as admin and Antares authenticates nobody, so publish the ports only on a trusted
network.

## Refreshing the data

The seed writes 48 hourly values ending at the hour it runs; `stations` adds a value per minute from then
on, so a new panel with any time range, *Last 5 minutes* included, shows the stations.
`docker compose run --rm seed` writes fresh history. `docker compose logs hsl`
shows the tram feed: once a minute, the trams followed and the updates written.

Tests of the tram feed: `cd hsl && npm ci --ignore-scripts && npm test`.

To try unreleased plugin code, use the development stack in `../../datasource`, which builds the plugin
from source.

## Data

- Tram positions: Helsinki Regional Transport Authority (HSL) high-frequency positioning, CC BY 4.0.
- Shapes: © OpenStreetMap contributors, ODbL, simplified.
