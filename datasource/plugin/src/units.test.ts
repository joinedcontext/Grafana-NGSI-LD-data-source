import { getValueFormatterIndex } from '@grafana/data';

import { grafanaUnit, grafanaUnitIds, knownUnitCodes, unitSymbol } from './units';

describe('units', () => {
  it('maps a code to its symbol, or returns an unknown code as it is', () => {
    expect(unitSymbol('CEL')).toBe('°C');
    expect(unitSymbol('C62')).toBe('');
    expect(unitSymbol('XYZ')).toBe('XYZ');
  });

  it('prefers a Grafana unit id, then a suffix, and keeps an unknown code visible', () => {
    expect(grafanaUnit('CEL')).toBe('celsius');
    expect(grafanaUnit('CMT')).toBe('suffix: cm');
    expect(grafanaUnit('C62')).toBe('none');
    expect(grafanaUnit('XYZ')).toBe('suffix: XYZ');
    expect(grafanaUnit(undefined)).toBeUndefined();
    expect(grafanaUnit('')).toBeUndefined();
  });

  it('only names unit ids Grafana knows', () => {
    const index = getValueFormatterIndex();
    const unknown = grafanaUnitIds().filter((id) => !index[id]);
    expect(unknown).toEqual([]);
  });

  it('lists the UN/CEFACT codes it knows', () => {
    expect(knownUnitCodes()).toEqual(expect.arrayContaining(['CEL', 'GQ', 'KWT', 'P1']));
  });
});
