import assert from 'node:assert/strict';
import test from 'node:test';
import { prioritizeUnlinkedGatcRows } from './yesgatc-stamped-serial-allot.js';

function row(serialNumber) {
  return { id: `pool:${serialNumber}`, serialNumber, max: '30Kg', certificateNumber: '', sku: '', productName: '' };
}

test('product YJ serials stay ahead of the shared Y and X tank', () => {
  const shared = [];
  for (let n = 10315; n <= 11000; n += 1) shared.push(row(`Y${n}`));
  for (let n = 1; n <= 1500; n += 1) shared.push(row(`X${String(n).padStart(5, '0')}`));
  const owned = [];
  for (let n = 1; n <= 2000; n += 1) owned.push(row(`YJ${String(n).padStart(5, '0')}`));
  const sorted = [...shared, ...owned].sort((a, b) => (
    a.serialNumber.localeCompare(b.serialNumber, 'en', { numeric: true })
  ));
  const page = prioritizeUnlinkedGatcRows(sorted, { cap: 2000 });
  const serials = page.map(item => item.serialNumber);
  assert.equal(serials.includes('YJ01359'), true);
  assert.equal(serials.includes('YJ01361'), true);
  assert.equal(serials.includes('Y10315'), false);
  assert.equal(serials[0].startsWith('YJ'), true);
});

test('search finds a YJ serial past the first page', () => {
  const owned = [];
  for (let n = 1; n <= 4000; n += 1) owned.push(row(`YJ${String(n).padStart(5, '0')}`));
  const page = prioritizeUnlinkedGatcRows(owned, { cap: 2000 });
  assert.equal(page.some(item => item.serialNumber === 'YJ03000'), false);
  const hit = prioritizeUnlinkedGatcRows(owned, { cap: 2000, query: 'Yj03000' });
  assert.deepEqual(hit.map(item => item.serialNumber), ['YJ03000']);
});
