import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendMachineQcDescription,
  applySourceMachineQc,
  machineQcFieldsFromLine,
  parseMachineQcNote,
  preserveMachineQcLines,
} from './machine-qc.js';

const SPEC = 'DISPLAY: 9/10 INCH\nSupplied in Dismantled Condition';

test('parses the QC note Zoho stores on the line', () => {
  const parsed = parseMachineQcNote(`${SPEC}\nQC: ₹150 per machine`);
  assert.deepEqual(parsed, { qcEnabled: true, qcFeePerUnit: 150 });
  assert.equal(parseMachineQcNote(`${SPEC}\n(back bill it)`), null);
  assert.equal(parseMachineQcNote('QC required on request'), null);
});

test('a missing tick is recovered from the note', () => {
  const qc = machineQcFieldsFromLine({
    description: `${SPEC}\nQC: ₹1,500 per machine`,
    qcEnabled: null,
    qcFeePerUnit: null,
  });
  assert.deepEqual(qc, { qcEnabled: true, qcFeePerUnit: 1500 });
});

test('append keeps the note when the fee was only in the description', () => {
  const next = appendMachineQcDescription(`${SPEC}\nQC: ₹150 per machine`, {
    qcEnabled: true,
    qcFeePerUnit: 0,
  });
  assert.match(next, /QC: ₹150 per machine/);
  assert.equal(next.split('QC:').length, 2);
});

test('sync keeps QC when Zoho drops the sentence but the body matches', () => {
  const previous = [{
    itemId: 'scale',
    description: `${SPEC}\nQC: ₹150 per machine`,
    qcEnabled: true,
    qcFeePerUnit: 150,
  }];
  const incoming = [{ itemId: 'scale', description: SPEC }];
  const [line] = preserveMachineQcLines(incoming, previous);
  assert.equal(line.qcEnabled, true);
  assert.equal(line.qcFeePerUnit, 150);
  assert.match(line.description, /QC: ₹150 per machine/);
});

test('a changed description does not resurrect QC', () => {
  const previous = [{
    itemId: 'scale',
    description: `${SPEC}\nQC: ₹150 per machine`,
    qcEnabled: true,
    qcFeePerUnit: 150,
  }];
  const incoming = [{ itemId: 'scale', description: 'Custom packing note' }];
  const [line] = preserveMachineQcLines(incoming, previous);
  assert.equal(line.qcEnabled, undefined);
  assert.equal(line.description, 'Custom packing note');
});

test('create stamp writes the tick onto a mirrored line and an untick clears it', () => {
  const mirrored = [{ itemId: 'scale', description: SPEC }, { itemId: 'freight', description: '' }];
  const stamped = applySourceMachineQc(mirrored, [
    { itemId: 'scale', qcEnabled: true, qcFeePerUnit: 150, description: SPEC },
    { itemId: 'freight', qcEnabled: false },
  ]);
  assert.equal(stamped[0].qcEnabled, true);
  assert.equal(stamped[0].qcFeePerUnit, 150);
  assert.match(stamped[0].description, /QC: ₹150 per machine/);
  assert.equal(stamped[1].qcEnabled, false);

  const cleared = applySourceMachineQc(stamped, [
    { itemId: 'scale', qcEnabled: false, description: SPEC },
  ]);
  assert.equal(cleared[0].qcEnabled, false);
  assert.doesNotMatch(cleared[0].description, /QC:/);
});
