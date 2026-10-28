# NGSI-LD data source for Grafana

Reads NGSI-LD context brokers (ETSI GS CIM 009): current values, temporal history with aggregation,
geo-queries for the Geomap panel and relationship graphs for the Node graph panel. Built and tested
for [Antares](https://antaresbroker.joinedcontext.com); other brokers are not tested.

## Requirements

- Grafana 12.3 or newer
- Antares; temporal queries use its `/temporal/entities` API under the same URL

## Configuration

| Setting | Meaning |
|---|---|
| Broker URL | Root URL of the broker, without `/ngsi-ld/v1` |
| @context URL | Sent as JSON-LD `Link` header; empty = NGSI-LD core context |
| Tenant | `NGSILD-Tenant` header |
| Authentication | See below |
| Page size | Entities per request (default 1000). Brokers refuse more than their maximum (Antares: 1000); Save & test checks it |
| Max temporal pages | Requests per temporal query when the broker answers `206 Partial Content` (default 100) |

Save & test lists the entity types and checks the temporal API. When the broker or its gateway refuses
the credentials, it says so and shows the reason the gateway gave. A URL that answers with a web page
instead of NGSI-LD JSON fails the test.

### Authentication

Grafana keeps every credential encrypted and adds it in its data source proxy; the browser never sees it.

| Method | What the broker receives |
|---|---|
| None | no credentials |
| Basic auth | `Authorization: Basic …` |
| OAuth2 client credentials | `Authorization: Bearer <token>`; Grafana fetches the token from the token URL with the client id and secret and renews it |
| API key / Bearer header | one header with a fixed value, e.g. `X-API-Key: …` or `Authorization: Bearer …` |
| Forward OAuth identity | the access token of the signed-in Grafana user; needs Grafana sign-in through the identity provider the broker trusts, and lets the broker decide per user |

Give Grafana read-only credentials. The plugin only reads, and its OAuth2 route is limited to `GET`, but
Grafana's data source proxy forwards any method with basic auth and header credentials: every user who
may query the data source can send `POST`, `PATCH` or `DELETE` through it. The broker or its gateway has
to refuse writes for these credentials.

## Query types

- **Temporal**: history of the selected attributes in the dashboard time range, one series per entity
  attribute (and per `datasetId`). Optional `lastN`, time property (`observedAt`, `createdAt`, `modifiedAt`,
  `deletedAt`) and aggregation (`aggrMethods` with a period, or `auto` for the panel interval). Deletion
  instances (`urn:ngsi-ld:null`) are gaps; with `deletedAt` each deletion charts as 1.
- **Current value**: current attribute values as one frame per attribute (stat, gauge) or one table.
  *Representation* (Normalized, Concise, keyValues) and *System attributes* (`createdAt`, `modifiedAt`)
  apply to this type only.
- **Geo**: entity locations for the Geomap panel. *Location: Point* gives latitude/longitude, with lines
  and polygons placed at the mean of their positions. *Location: Shape* gives the geometry as a geo field
  that the Geomap markers layer draws: points as markers, lines as lines, polygons as the outline of each
  ring, multi geometries and collections as their members (one row per part, each with the entity's
  columns). Grafana 12.3 and 13 drop a line's stroke in a markers layer that also shows text, so put the
  shapes in one markers layer without text and the names in a second layer without a symbol, as the
  sample dashboard does.
- **Node graph**: entities and their relationships, followed up to a configurable depth and 1000 nodes.
  The selected attributes do not limit the entities' members, so relationships and their edges stay.

All types filter by entity type, id, id pattern, attributes, NGSI-LD query (`q`), scope (`scopeQ`), language
(`lang`) and geo-query (`georel`, sent once coordinates are set). Entity type, id and attributes are always
shown; the other filters, naming and the representation sit under *Options*, which opens by itself when one
of them is set. Template variables work in every text field. The editor shows the exact request it sends,
and why a lookup of types, attributes or ids failed. `attrs` also drops entities that have none of the
selected attributes.

A query without a selector, or a temporal query without instances in the range, returns an empty frame
whose notice says why; an unknown entity type is named, with the types the broker knows. A query stops at 500 series with a warning.

### Paging

Entity queries are paged by `offset` up to the query limit. The first request asks for the total
(`count=true`), so the limit notice appears only when more entities match than the limit. Temporal answers that a broker cuts
(`206 Partial Content`, CIM 009 6.3.10) are continued per entity, from the earliest cut point of the page, so
entities with sparse data lose no instances. A query that needs more requests than *Max temporal pages* stops
there with a warning, and so does a query whose later request fails: the panel keeps what arrived. More
than 50 entity ids go out in several requests. A refresh or a new time range cancels a running query.

## Variables

| Query | Result |
|---|---|
| `types()` | entity types |
| `attributes()`, `attributes(Type)` | attribute names, of all types or one |
| `entities(Type)`, `entities(Type, nameAttr)` | entity ids; the text is the short id or the value of `nameAttr` |
| `values(Type, attr)` | distinct current values of `attr` |

Multi-value variables expand to comma-separated lists, which is what `id`, `type` and `attrs` take. In `q`
use `${var:doublequote}`.

## Limitations

- The plugin runs in the browser, so Grafana alerting and server-side expressions cannot use it.
