// node --test
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTracker, toEntity } from './hsl.mjs';

// a real HFP message (mqtt.hsl.fi, tram 7)
const VP = {
  desi: '7', dir: '1', oper: 40, veh: 422, tst: '2026-10-28T14:18:15.496Z', tsi: 1793197095,
  spd: 4.97, hdg: 324, lat: 60.190195, long: 24.96335, acc: 0.48, dl: -60, odo: 6182, drst: 0,
  oday: '2026-10-28', jrn: 1108, line: 992, start: '15:44', loc: 'GPS', stop: 1220422, route: '1007', occu: 0,
};
const EXP = '2026-10-28T14:26:15.496Z';

test('maps a vehicle position to an NGSI-LD Vehicle', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(toEntity(VP, 'tram', EXP))), {
    id: 'urn:ngsi-ld:Vehicle:HSL-40-422',
    type: 'Vehicle',
    expiresAt: EXP,
    name: { type: 'Property', value: 'Tram 7 (422)' },
    vehicleType: { type: 'Property', value: 'tram' },
    line: { type: 'Property', value: '7' },
    location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [24.96335, 60.190195] }, observedAt: VP.tst },
    speed: { type: 'Property', value: 4.97, unitCode: 'MTS', observedAt: VP.tst },
    heading: { type: 'Property', value: 324, unitCode: 'DD', observedAt: VP.tst },
    // dl -60 = a minute behind schedule
    delay: { type: 'Property', value: 60, unitCode: 'SEC', observedAt: VP.tst },
  });
});

test('leaves out measurements HFP sends as null', () => {
  const e = JSON.parse(JSON.stringify(toEntity({ ...VP, spd: null, hdg: null, dl: null, desi: null }, 'bus', EXP)));
  assert.equal(e.speed, undefined);
  assert.equal(e.heading, undefined);
  assert.equal(e.delay, undefined);
  assert.equal(e.line, undefined);
  assert.equal(e.name.value, 'Bus 422');
});

test('rejects a message without id, position or a valid time', () => {
  for (const bad of [
    undefined,
    {},
    { ...VP, veh: undefined },
    { ...VP, oper: null },
    { ...VP, lat: null },
    { ...VP, long: 'x' },
    { ...VP, tst: 'not a time' },
    { ...VP, tst: undefined },
  ]) {
    assert.equal(toEntity(bad, 'tram', EXP), undefined, JSON.stringify(bad));
  }
});

test('names a vehicle without a mode in the topic', () => {
  assert.equal(toEntity(VP, undefined, EXP).name.value, 'Vehicle 7 (422)');
  assert.equal(toEntity(VP, undefined, EXP).vehicleType.value, 'unknown');
});

test('tracks at most the configured number of vehicles, each once per interval', () => {
  const t = createTracker(2, 10_000, 60_000);
  assert.equal(t.accept('a', 0), true);
  assert.equal(t.accept('b', 0), true);
  assert.equal(t.accept('c', 0), false, 'third vehicle over the limit');
  assert.equal(t.accept('a', 9_999), false, 'within the interval');
  assert.equal(t.accept('a', 10_000), true);
  assert.equal(t.size, 2);
});

test('gives the slot of a silent vehicle to the next one', () => {
  const t = createTracker(1, 10_000, 60_000);
  assert.equal(t.accept('a', 0), true);
  assert.equal(t.accept('b', 60_000), false, 'a is not silent long enough yet');
  assert.equal(t.accept('b', 60_001), true);
  assert.equal(t.accept('a', 60_002), false, 'a lost its slot');
});
