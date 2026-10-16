import assert from 'node:assert/strict';
import test from 'node:test';
import { expandGatcPickerPool, expandSerialAllotmentPool } from './non-gatc-serial-allot.js';

test('YJ filed under 50 kg GATC is offered on an SL line', () => {
  const pool = expandGatcPickerPool([
    { series: 'gatc_50kg', from: 'YJ00001', to: 'YJ00003' },
    { series: 'gatc_50kg', from: 'Y20001', to: 'Y20002' },
    { series: 'gatc_sl', from: 'YJ00601', to: 'YJ00602', sku: 'OTHER', productId: 'other' },
    { series: 'non_gatc', from: 'YJ01001', to: 'YJ01002', sku: 'ATMPCSSK', productId: 'p1' },
  ], { sku: 'ATMPCSSK', productId: 'p1' }, 'gatc_sl');
  assert.equal(pool.includes('YJ00001'), true);
  assert.equal(pool.includes('YJ01001'), true);
  assert.equal(pool.includes('YJ00601'), false);
  assert.equal(pool.includes('Y20001'), false);
});

test('50 kg lines do not receive an unbound YJ bank', () => {
  const pool = expandGatcPickerPool([
    { series: 'gatc_sl', from: 'YJ00001', to: 'YJ00002' },
    { series: 'gatc_50kg', from: 'Y20001', to: 'Y20002' },
  ], { sku: 'SCALE50' }, 'gatc_50kg');
  assert.equal(pool.includes('YJ00001'), false);
  assert.equal(pool.includes('Y20001'), true);
});

test('non-GATC pool keeps a product YJ lot ahead of the shared X tank', () => {
  const pool = expandSerialAllotmentPool([
    { series: 'gatc_sl', from: 'YJ00001', to: 'YJ00002', sku: 'KS10BAY', productId: 'scale10' },
    { series: 'non_gatc', from: 'X00001', to: 'X00002' },
    { series: 'gatc_50kg', from: 'YJ02001', to: 'YJ02001', sku: 'OTHER', productId: 'other' },
  ], { sku: 'KS10BAY', productId: 'scale10' }, 'non_gatc');
  assert.deepEqual(pool.slice(0, 2), ['YJ00001', 'YJ00002']);
  assert.equal(pool.includes('X00001'), true);
  assert.equal(pool.includes('YJ02001'), false);
});
