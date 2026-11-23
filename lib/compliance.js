// Customs and dangerous goods (Phase 6.1): the facts a load needs at the border and for hazardous cargo.
// Pure rules, no database. Entered by people; no customs system (e.g. a single window) is connected, and
// these checks are format checks only — they are not legal or dangerous-goods advice.

class ComplianceError extends Error {}

const INCOTERMS = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'];
const CUSTOMS_STATUSES = ['Not started', 'Documents requested', 'Declared', 'Held', 'Cleared'];
// UN dangerous goods classes and divisions.
const DG_CLASSES = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '2.1', '2.2', '2.3', '3', '4.1', '4.2', '4.3', '5.1', '5.2', '6.1', '6.2', '7', '8', '9'];
const PACKING_GROUPS = ['I', 'II', 'III'];
// Classes that never carry a packing group.
const NO_PACKING_GROUP = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '2.1', '2.2', '2.3', '6.2', '7'];

const text = (value, label, max) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw new ComplianceError(`${label} must be text of at most ${max} characters.`);
  return value.trim();
};
const upper = (value) => String(value).replace(/[\s.-]/g, '').toUpperCase();

function readCountry(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const code = upper(value);
  if (!/^[A-Z]{2}$/.test(code)) throw new ComplianceError(`${label} must be a 2-letter country code (ISO 3166), e.g. UZ.`);
  return code;
}

// body: the whole record. parseMoney is the app's price rule (null when invalid).
function readCompliance(body, { parseMoney } = {}) {
  const record = {
    goodsDescription: text(body?.goodsDescription, 'goodsDescription', 300),
    hsCode: null,
    originCountry: readCountry(body?.originCountry, 'originCountry'),
    destinationCountry: readCountry(body?.destinationCountry, 'destinationCountry'),
    declaredValue: null,
    incoterm: null,
    customsStatus: 'Not started',
    declarationNo: text(body?.declarationNo, 'declarationNo', 60),
    dangerous: body?.dangerous === true,
    unNumber: null,
    dgClass: null,
    packingGroup: null,
    properShippingName: null
  };
  if (body?.hsCode !== undefined && body?.hsCode !== null && body?.hsCode !== '') {
    const code = String(body.hsCode).replace(/[\s.]/g, '');
    if (!/^\d{6,10}$/.test(code)) throw new ComplianceError('hsCode must be 6 to 10 digits (the HS / TN VED code), e.g. 0806.10.');
    record.hsCode = code;
  }
  if (body?.declaredValue !== undefined && body?.declaredValue !== null && body?.declaredValue !== '') {
    const value = parseMoney ? parseMoney(body.declaredValue) : Number(body.declaredValue);
    if (value === null || !Number.isFinite(value) || value < 0) throw new ComplianceError('declaredValue must be an amount of 0 or more.');
    record.declaredValue = value;
  }
  if (body?.incoterm) {
    const term = upper(body.incoterm);
    if (!INCOTERMS.includes(term)) throw new ComplianceError(`incoterm must be one of ${INCOTERMS.join(', ')} (Incoterms 2020).`);
    record.incoterm = term;
  }
  if (body?.customsStatus !== undefined && body?.customsStatus !== null && body?.customsStatus !== '') {
    if (!CUSTOMS_STATUSES.includes(body.customsStatus)) throw new ComplianceError(`customsStatus must be one of ${CUSTOMS_STATUSES.join(', ')}.`);
    record.customsStatus = body.customsStatus;
  }
  if (['Declared', 'Held', 'Cleared'].includes(record.customsStatus) && !record.declarationNo) {
    throw new ComplianceError('Add the declaration number once the goods are declared.');
  }
  if (record.dangerous) {
    const un = upper(body?.unNumber || '').replace(/^UN/, '');
    if (!/^\d{4}$/.test(un)) throw new ComplianceError('unNumber must be UN and 4 digits, e.g. UN1203.');
    record.unNumber = `UN${un}`;
    const dgClass = String(body?.dgClass ?? '').trim();
    if (!DG_CLASSES.includes(dgClass)) throw new ComplianceError(`dgClass must be one of ${DG_CLASSES.join(', ')}.`);
    record.dgClass = dgClass;
    const group = body?.packingGroup ? upper(body.packingGroup) : null;
    if (NO_PACKING_GROUP.includes(dgClass)) {
      if (group) throw new ComplianceError(`Class ${dgClass} has no packing group.`);
    } else if (!PACKING_GROUPS.includes(group)) {
      throw new ComplianceError('packingGroup must be I, II or III for this class.');
    }
    record.packingGroup = group;
    record.properShippingName = text(body?.properShippingName, 'properShippingName', 200);
    if (!record.properShippingName) throw new ComplianceError('properShippingName is required for dangerous goods.');
  }
  return record;
}

// Points a person should look at; never a decision. legModes: the modes of the load's legs.
function warnings(record, { legModes = [] } = {}) {
  if (!record) return [];
  const list = [];
  if (record.dangerous) {
    if (legModes.includes('AIR')) list.push({ kind: 'dg_air', text: 'Dangerous goods on an air leg: check the airline accepts them (IATA DGR) and that a shipper\'s declaration is ready.' });
    if (legModes.includes('OCEAN')) list.push({ kind: 'dg_ocean', text: 'Dangerous goods on an ocean leg: the IMDG declaration and container placards are needed.' });
    if (legModes.some((mode) => ['ROAD', 'LAST_MILE'].includes(mode))) list.push({ kind: 'dg_road', text: 'Dangerous goods by road: the driver needs ADR training and the truck orange plates.' });
    if (['1.1', '1.2', '1.3', '1.5', '7'].includes(record.dgClass)) list.push({ kind: 'dg_high', text: `Class ${record.dgClass} is high-consequence cargo: special permits and routing usually apply.` });
  }
  if (record.originCountry && record.destinationCountry && record.originCountry !== record.destinationCountry) {
    const missing = [!record.hsCode && 'HS code', record.declaredValue === null && 'declared value', !record.incoterm && 'Incoterm'].filter(Boolean);
    if (missing.length) list.push({ kind: 'customs_missing', text: `Crosses a border: add the ${missing.join(', ')}.` });
  }
  return list;
}

module.exports = { ComplianceError, CUSTOMS_STATUSES, DG_CLASSES, INCOTERMS, PACKING_GROUPS, readCompliance, warnings };
