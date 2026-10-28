// UN/CEFACT common codes (NGSI-LD unitCode) → [symbol, Grafana unit id].
// A code without a Grafana unit is shown with its symbol as a suffix; an unknown code
// is shown as itself, so a value never loses its unit.
const UNITS: Record<string, [string, string?]> = {
  // temperature
  CEL: ['°C', 'celsius'],
  FAH: ['°F', 'fahrenheit'],
  KEL: ['K', 'kelvin'],
  // ratio
  P1: ['%', 'percent'],
  C62: [''],
  '59': ['ppm', 'ppm'],
  '61': ['ppb', 'conppb'],
  // concentration
  GQ: ['µg/m³', 'conμgm3'],
  GP: ['mg/m³', 'conmgm3'],
  // length
  MMT: ['mm', 'lengthmm'],
  CMT: ['cm'],
  DMT: ['dm'],
  MTR: ['m', 'lengthm'],
  KMT: ['km', 'lengthkm'],
  KTM: ['km', 'lengthkm'],
  // angle
  DD: ['°', 'degree'],
  C81: ['rad', 'radian'],
  D61: ["'"],
  D62: ['"'],
  // time
  C47: ['ns', 'ns'],
  B98: ['µs', 'µs'],
  C26: ['ms', 'ms'],
  SEC: ['s', 's'],
  MIN: ['min', 'm'],
  HUR: ['h', 'h'],
  DAY: ['d', 'd'],
  ANN: ['y'],
  // velocity, acceleration, rotation
  MTS: ['m/s', 'velocityms'],
  KMH: ['km/h', 'velocitykmh'],
  KNT: ['kn', 'velocityknot'],
  '2X': ['m/min'],
  M62: ['km/s'],
  MSK: ['m/s²', 'accMS2'],
  '2A': ['rad/s'],
  M46: ['r/min', 'rotrpm'],
  // mass
  MGM: ['mg', 'massmg'],
  GRM: ['g', 'massg'],
  KGM: ['kg', 'masskg'],
  TNE: ['t', 'masst'],
  KTN: ['kt'],
  // pressure
  '74': ['mPa'],
  PAL: ['Pa', 'pressurepa'],
  A97: ['hPa', 'pressurehpa'],
  KPA: ['kPa', 'pressurekpa'],
  HBA: ['hbar'],
  MBR: ['mbar', 'pressurembar'],
  BAR: ['bar', 'pressurebar'],
  KBA: ['kbar'],
  ATM: ['atm'],
  // energy
  JOU: ['J', 'joule'],
  KJO: ['kJ'],
  '3B': ['MJ'],
  GV: ['GJ'],
  WHR: ['Wh', 'watth'],
  KWH: ['kWh', 'kwatth'],
  MWH: ['MWh'],
  GWH: ['GWh'],
  A53: ['eV', 'ev'],
  B29: ['keV'],
  B71: ['MeV'],
  A85: ['GeV'],
  // power
  C31: ['mW', 'mwatt'],
  WTT: ['W', 'watt'],
  KWT: ['kW', 'kwatt'],
  MAW: ['MW', 'megwatt'],
  A90: ['GW', 'gwatt'],
  D46: ['VA', 'voltamp'],
  KVA: ['kVA', 'kvoltamp'],
  MVA: ['MVA'],
  // electricity
  AMP: ['A', 'amp'],
  B22: ['kA', 'kamp'],
  '4K': ['mA', 'mamp'],
  COU: ['C'],
  AMH: ['Ah'],
  TAH: ['kAh'],
  VLT: ['V', 'volt'],
  KVT: ['kV', 'kvolt'],
  '2Z': ['mV', 'mvolt'],
  D50: ['V/m'],
  D33: ['T'],
  C29: ['mT'],
  OHM: ['Ω', 'ohm'],
  E45: ['mΩ'],
  B49: ['kΩ', 'kohm'],
  B75: ['MΩ', 'Mohm'],
  // volume, area, flow
  MTK: ['m²', 'areaM2'],
  MTQ: ['m³', 'm3'],
  LTR: ['l', 'litre'],
  MLT: ['ml', 'mlitre'],
  KGS: ['kg/s'],
  MQS: ['m³/s', 'flowcms'],
  MQH: ['m³/h'],
  // other
  HTZ: ['Hz', 'hertz'],
  NEW: ['N'],
  B11: ['J/(kg K)'],
  B43: ['kJ/(kg K)'],
  '2N': ['dB', 'dB'],
  BQL: ['Bq', 'radbq'],
  LUX: ['lx', 'lux'],
  E50: ['vehicles/h'],
  H87: ['pcs'],
};

/** Display symbol of a unit code, e.g. CEL → °C; unknown codes are returned as they are. */
export const unitSymbol = (code: string): string => UNITS[code]?.[0] ?? code;

/** Grafana field unit for a unit code: a built-in unit id, else a suffix with the symbol. */
export function grafanaUnit(code?: string): string | undefined {
  if (!code) {
    return undefined;
  }
  const [symbol, id] = UNITS[code] ?? [code];
  if (id) {
    return id;
  }
  return symbol ? `suffix: ${symbol}` : 'none';
}

export const knownUnitCodes = (): string[] => Object.keys(UNITS);
export const grafanaUnitIds = (): string[] => Object.values(UNITS).flatMap(([, id]) => (id ? [id] : []));
