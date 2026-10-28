# Changelog

## 8.1.0

* Geo query *Location: Trail*: the GeoProperty's history in the time range as one line per entity, with
  the last position and time, in one frame that Geomap draws
* Temporal query of a GeoProperty gives latitude and longitude series instead of no data
* Current value table: `expiresAt` column when any entity has one
* Query editor labels fit *Time property* and *System attributes*
* Helsinki demo on live open data: FMI air quality (8 stations, 48 h history), Linked Events with venues
  and expiry, HSL trams linked to their lines and the operator; tram trails, events table and pie chart,
  air quality state timeline and two node graphs; feeds in `demos/helsinki/feeds`

## 8.0.0

Rewrite on the current Grafana plugin tooling (`@grafana/create-plugin`, React 19, Grafana 12.3+).

* Temporal paging: continues `206 Partial Content` answers per entity from the earliest cut point, so no
  instances of sparser entities are skipped; bounded by the new *Max temporal pages* setting
* Entity paging by `offset` up to the query limit, *Page size* setting
* Queries by entity id or id pattern alone are sent with `local=true` (CIM 009 5.7.2.4); the type stays in
  every request, including temporal continuations
* Health check probes the temporal API with a valid `timerel`
* Geo query with *Location: Shape*: polygons are drawn as ring outlines and multi geometries as their
  members, the shapes Grafana's Geomap markers layer can draw
* Demo: `docker compose up -d` builds Grafana with the plugin (`plugin/Dockerfile`); `build.sh` builds
  `dist` with the same Dockerfile; the seed adds a corridor line and a zone polygon
* Lookups (variable queries `entities(T, name)` and `values(T, attr)`, the editor's id list) send `pick`
  without `attrs`, which CIM 009 4.21 forbids together
* Authentication: basic auth, fixed header (API key, bearer token) and *Forward OAuth identity* next to
  OAuth2 client credentials; tested against Keycloak and a token-checking gateway
* Error bodies are read as text, so a gateway's reason (`RBAC: access denied`, `Jwt is missing`) reaches the
  query error; Save & test names refused credentials as such
* Temporal series named by an attribute take the name from the current entity when it has no history in
  the range; table columns follow the query's attribute order
* Query editor: request preview, attributes of the selected type, a distance input for `near`, `lang`,
  multi-instance attributes (`datasetId`), aggregation period `auto`
* Variable queries `types()`, `attributes()`, `entities()`, `values()`
* Tests: unit tests for every module, integration tests against Antares, Playwright end-to-end tests
* Development stack: Antares broker, seed data and a sample dashboard in `docker compose`
* Antares only: always sends `format` and reads `temporalValues`; the *Tenant path* (`NGSILD-Path`) and
  *Broker compatibility* settings are gone
* Geo queries: *Location: Shape* gives GeoJSON points, lines and polygons as a geo field the Geomap panel
  draws
* Temporal history of LanguageProperty, VocabProperty and JsonProperty attributes (`languageMaps`,
  `vocabs`, `jsons`), and series names from a LanguageProperty
* A failed later request keeps the series already received, with a warning; a refresh cancels a running
  query; empty results carry a notice that says why; more than 50 ids go out in several requests
* A broker URL that answers with a web page fails Save & test; HTML error pages are reduced to their title
* Query editor: entity type and id take several values, lookup errors are shown, a new aggregation starts
  with period `auto`, coordinates are checked, labels reach screen readers
* Limits: 500 series per query, 1000 nodes per graph; types and attributes are cached for a minute
* The OAuth2 route is limited to `GET`; the demo gateway is read-only on every listener; demo ports bind
  to 127.0.0.1
* Geo queries with selected attributes keep the location; a temporal query selected only by `q`,
  `georel` or id is sent with `local=true` (CIM 009 6.18.3.2 needs `type` or `attrs` otherwise)
* Deletion instances (`urn:ngsi-ld:null`) are gaps; with time property `deletedAt` each deletion charts as 1
* keyValues multi-instance values (`{"dataset": {…}}`) give one value per `datasetId`; `expiresAt` is an
  entity member, not an attribute
* Entity queries send `count=true`: the limit notice appears only when more entities match than the limit;
  Save & test checks that the broker accepts the *Page size*
* An unknown entity type is named in the notice and under the Entity type field, with the known types
* Node graph stats are named after their attribute; numbers keep their own formatting
* Variables: `entities($type, name)` with a multi-value variable; `values()` sorts numbers numerically
* Query editor: rarely used settings in a collapsible *Options* section, *Representation* (Normalized,
  Concise, keyValues) and *System attributes* for current values only, no naming fields for tables, a hint
  instead of a preview while no selector is set, named radio groups and colour pickers, lookup errors
  announced, adding a type keeps the selected ids, clearing the distance no longer sends 0 m
* CI: unit, integration and end-to-end tests (Grafana 12.3.0 and 13.2.4) on every push; a version bump
  on `main` publishes a GitHub release with the plugin zip
* Helsinki demo in `demos/helsinki`: OpenStreetMap shapes, air quality and live HSL trams with `expiresAt`;
  its Grafana installs the plugin from the newest GitHub release

## 1.0.0

Initial release.

## 1.1.0

* Supports other brokers than Orion-LD, by means of setting flavor=generic (default: ~~`orion`~~ `generic`)
* More flexible entity names: [#1](https://github.com/bfi-de/ngsild-grafana-datasource/issues/1)
* Some version updates and related fixes: [#4](https://github.com/bfi-de/ngsild-grafana-datasource/issues/4)

## 1.1.1

* Fix `attrMethods` parameter: [#6](https://github.com/bfi-de/ngsild-grafana-datasource/issues/6)

# 1.1.2

* Multi-tenant support (datasource setting) and scope query: [#7](https://github.com/bfi-de/ngsild-grafana-datasource/issues/7)
* Toggle between *options* (legacy, widely supported) and *format* (new, yet unsupported) parameters
* Hide unsupported authentication settings in direct mode: [#3](https://github.com/bfi-de/ngsild-grafana-datasource/issues/3)

# 1.2.0

* Support other time properties than `observedAt` (i.e. `createdAt`, `modifiedAt`, `deletedAt`)
* Support non-simplified temporal representation (configuration at datasource level): [#2](https://github.com/bfi-de/ngsild-grafana-datasource/issues/2)

# 1.2.1

* Fix temporal query with entity id errors [#9](https://github.com/bfi-de/ngsild-grafana-datasource/issues/9)
* Skip type parameter in query when entity id is specified
