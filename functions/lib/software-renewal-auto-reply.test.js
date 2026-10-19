import assert from 'node:assert/strict';
import test from 'node:test';
import {
  softwareRenewalCardText,
  softwareRenewalPayableInr,
  softwareRenewalPaymentText,
} from './software-renewal-auto-reply.js';

test('INR renewal quote adds 18% GST on the plan and Smart Scale', () => {
  const shop = {
    shopId: 12,
    name: 'Cafe',
    subscription: 'Sanoft Lite',
    smartScale: '2026-01-01',
    sourceAccount: 'yesweigh',
    phone: '9800000000',
    subscriptionEnd: '2026-10-01',
  };
  const payable = softwareRenewalPayableInr(shop);
  assert.equal(payable.base, 4500);
  assert.equal(payable.extra, 1500);
  assert.equal(payable.subtotal, 6000);
  assert.equal(payable.baseIncl, 5310);
  assert.equal(payable.extraIncl, 1770);
  assert.equal(payable.gst, 1080);
  assert.equal(payable.total, 7080);

  const card = softwareRenewalCardText(shop, 12);
  assert.match(card, /Sanoft Lite: ₹5,310/);
  assert.match(card, /Smart Scale: ₹1,770/);
  assert.match(card, /Total \(incl\. 18% GST\): ₹7,080/);

  const payment = softwareRenewalPaymentText(shop, 12);
  assert.match(payment, /Please pay ₹7,080 to renew Cafe \(₹6,000 \+ 18% GST\)\./);
});

test('a plan with no Smart Scale still quotes the GST-inclusive total', () => {
  const payable = softwareRenewalPayableInr({ subscription: 'Premium', smartScale: '' });
  assert.equal(payable.base, 3500);
  assert.equal(payable.extra, 0);
  assert.equal(payable.total, 4130);
});
