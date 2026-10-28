// node --test
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCoverage, toEntities } from './fmi.mjs';

// the shape of FMI's multipointcoverage answer, cut to two stations and two hours
const XML = `
<target:Location gml:id="obsloc-fmisid-100662-pos">
  <gml:identifier codeSpace="http://xml.fmi.fi/namespace/stationcode/fmisid">100662</gml:identifier>
  <gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/name">Helsinki Kallio 2</gml:name>
  <target:region codeSpace="http://xml.fmi.fi/namespace/location/region">Helsinki</target:region>
</target:Location>
<target:Location gml:id="obsloc-fmisid-100742-pos">
  <gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/name">Espoo Tapiola 4</gml:name>
  <target:region codeSpace="http://xml.fmi.fi/namespace/location/region">Espoo</target:region>
</target:Location>
<gml:Point gml:id="point-100662" srsDimension="2">
  <gml:name>Helsinki Kallio 2</gml:name>
  <gml:pos>60.18739 24.95060 </gml:pos>
</gml:Point>
<gml:Point gml:id="point-100742" srsDimension="2">
  <gml:pos>60.17513 24.80034 </gml:pos>
</gml:Point>
<gmlcov:positions>
  60.18739 24.95060  1793026800
  60.18739 24.95060  1793030400
  60.17513 24.80034  1793026800
  60.17513 24.80034  1793030400
</gmlcov:positions>
<gml:doubleOrNilReasonTupleList>
  1.0 7.7 4.5 12.9 44.9
  2.0 8.4 NaN 7.5 51.3
  1.0 5.0 3.0 9.0 NaN
  NaN NaN NaN NaN NaN
</gml:doubleOrNilReasonTupleList>
<swe:field name="AQINDEX_PT1H_avg" />
<swe:field name="PM10_PT1H_avg" />
<swe:field name="PM25_PT1H_avg" />
<swe:field name="NO2_PT1H_avg" />
<swe:field name="O3_PT1H_avg" />`;

const H0 = '2026-10-26T15:00:00.000Z';
const H1 = '2026-10-26T16:00:00.000Z';

test('reads stations and observations, leaving out NaN and empty hours', () => {
  const { stations, observations } = parseCoverage(XML);
  assert.deepEqual(stations, [
    { fmisid: '100662', name: 'Helsinki Kallio 2', region: 'Helsinki', lat: 60.18739, lon: 24.9506 },
    { fmisid: '100742', name: 'Espoo Tapiola 4', region: 'Espoo', lat: 60.17513, lon: 24.80034 },
  ]);
  assert.deepEqual(observations, [
    { fmisid: '100662', time: Date.parse(H0), values: { airQualityIndex: 1, pm10: 7.7, pm25: 4.5, no2: 12.9, o3: 44.9 } },
    { fmisid: '100662', time: Date.parse(H1), values: { airQualityIndex: 2, pm10: 8.4, no2: 7.5, o3: 51.3 } },
    { fmisid: '100742', time: Date.parse(H0), values: { airQualityIndex: 1, pm10: 5, pm25: 3, no2: 9 } },
  ]);
});

test('an answer without stations gives nothing', () => {
  assert.deepEqual(parseCoverage('<wfs:FeatureCollection numberMatched="0"/>'), { stations: [], observations: [] });
});

test('the newest value of each attribute is current, the older ones are history', () => {
  const { stations, observations } = parseCoverage(XML);
  const { entities, history } = toEntities(stations, observations);
  const [kallio, tapiola] = entities;
  assert.equal(kallio.id, 'urn:ngsi-ld:AirQualityObserved:FMI-100662');
  assert.equal(kallio.name.value, 'Kallio 2');
  assert.deepEqual(kallio.location.value, { type: 'Point', coordinates: [24.9506, 60.18739] });
  assert.deepEqual(kallio.pm10, { type: 'Property', value: 8.4, unitCode: 'GQ', observedAt: H1 });
  // pm25 is missing in the newest hour: its newest value stays current
  assert.deepEqual(kallio.pm25, { type: 'Property', value: 4.5, unitCode: 'GQ', observedAt: H0 });
  assert.deepEqual(history.get(kallio.id).pm10, [{ type: 'Property', value: 7.7, unitCode: 'GQ', observedAt: H0 }]);
  assert.equal(history.get(kallio.id).pm25, undefined);
  assert.equal(kallio.airQualityIndex.unitCode, 'C62');
  assert.equal(tapiola.o3, undefined);
  assert.deepEqual(history.get(tapiola.id), {});
});

test('a station without observations is left out', () => {
  const { stations } = parseCoverage(XML);
  assert.deepEqual(toEntities(stations, []).entities, []);
});
