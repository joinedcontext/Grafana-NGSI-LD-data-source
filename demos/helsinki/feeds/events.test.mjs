// node --test
import assert from 'node:assert/strict';
import test from 'node:test';

import { CITY, text, toEntities } from './events.mjs';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const venue = (id, name, coordinates = [24.9381, 60.174]) => ({
  id,
  name: { fi: name },
  street_address: { fi: 'Töölönlahdenkatu 4' },
  position: { type: 'Point', coordinates },
});
// the members Linked Events sends that the mapping reads
const EVENT = {
  id: 'helsinki:abc',
  name: { fi: 'Satutunti', en: 'Story time' },
  start_time: '2026-10-28T13:00:00Z',
  end_time: '2026-10-28T14:00:00Z',
  location: venue('tprek:51342', 'Keskustakirjasto Oodi'),
  keywords: [{ name: { fi: 'lapset', en: 'children' } }],
  info_url: { fi: 'https://example.org/fi' },
};

test('maps an event and its venue', () => {
  const [event, poi, city] = toEntities([EVENT], NOW);
  assert.deepEqual(city, CITY);
  assert.deepEqual(event, {
    id: 'urn:ngsi-ld:Event:helsinki:abc',
    type: 'Event',
    expiresAt: '2026-10-28T14:00:00.000Z',
    name: { type: 'Property', value: 'Story time' },
    startDate: { type: 'Property', value: '2026-10-28T13:00:00.000Z' },
    endDate: { type: 'Property', value: '2026-10-28T14:00:00.000Z' },
    venue: { type: 'Property', value: 'Keskustakirjasto Oodi' },
    category: { type: 'Property', value: 'children' },
    url: { type: 'Property', value: 'https://example.org/fi' },
    location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [24.9381, 60.174] } },
    refPointOfInterest: { type: 'Relationship', object: 'urn:ngsi-ld:PointOfInterest:tprek:51342' },
  });
  assert.deepEqual(poi, {
    id: 'urn:ngsi-ld:PointOfInterest:tprek:51342',
    type: 'PointOfInterest',
    expiresAt: '2026-10-28T14:00:00.000Z',
    name: { type: 'Property', value: 'Keskustakirjasto Oodi' },
    address: { type: 'Property', value: { streetAddress: 'Töölönlahdenkatu 4', addressLocality: 'Helsinki' } },
    location: { type: 'GeoProperty', value: { type: 'Point', coordinates: [24.9381, 60.174] } },
    refCity: { type: 'Relationship', object: 'urn:ngsi-ld:City:Helsinki' },
  });
});

test('a venue expires with its last event and appears once', () => {
  const later = { ...EVENT, id: 'helsinki:def', end_time: '2026-10-28T20:00:00Z' };
  const entities = toEntities([EVENT, later], NOW);
  const venues = entities.filter((e) => e.type === 'PointOfInterest');
  assert.equal(venues.length, 1);
  assert.equal(venues[0].expiresAt, '2026-10-28T20:00:00.000Z');
});

test('an event without an end lasts three hours', () => {
  const [event] = toEntities([{ ...EVENT, end_time: null }], NOW);
  assert.equal(event.expiresAt, '2026-10-28T16:00:00.000Z');
  assert.equal(event.endDate.value, '2026-10-28T16:00:00.000Z');
});

for (const [what, change] of [
  ['without a name', { name: { fi: ' ' } }],
  ['without a venue position', { location: { ...venue('tprek:1', 'X'), position: null } }],
  ['without a venue', { location: null }],
  ['with an invalid start', { start_time: 'soon' }],
  ['that has ended', { start_time: '2026-10-28T09:00:00Z', end_time: '2026-10-28T11:00:00Z' }],
]) {
  test(`skips an event ${what}`, () => {
    assert.deepEqual(toEntities([{ ...EVENT, ...change }], NOW), []);
  });
}

test('leaves out a missing category and url', () => {
  const [event] = toEntities([{ ...EVENT, keywords: [], info_url: null }], NOW);
  assert.equal(event.category, undefined);
  assert.equal(event.url, undefined);
});

test('prefers English, then Finnish, then Swedish text', () => {
  assert.equal(text({ fi: 'Kirjasto', sv: 'Bibliotek' }), 'Kirjasto');
  assert.equal(text({ sv: ' Bibliotek ' }), 'Bibliotek');
  assert.equal(text({ en: '', fi: '' }), undefined);
  assert.equal(text(null), undefined);
});
