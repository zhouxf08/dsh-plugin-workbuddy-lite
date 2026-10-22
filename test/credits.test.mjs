import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCredits } from '../lib/credits.js'

test('parseCredits sums precise cycle and gift remainders', () => {
  const result = parseCredits({
    data: {
      Response: {
        Data: {
          Accounts: [
            { CapacityType: 4, CycleCapacityRemain: 10, CycleCapacityRemainPrecise: '12.5' },
            { CapacityType: 1, CapacityRemain: 3, CapacityRemainPrecise: '3.25' },
            { CapacityType: 1, CapacityRemain: 0, CapacityRemainPrecise: '0' },
          ],
        },
      },
    },
  })
  assert.deepEqual(result, { total: 15.75, packages: 2 })
})

test('parseCredits tolerates missing or malformed responses', () => {
  assert.deepEqual(parseCredits(undefined), { total: 0, packages: 0 })
  assert.deepEqual(parseCredits({ data: {} }), { total: 0, packages: 0 })
  assert.deepEqual(parseCredits({ data: { Response: { Data: { Accounts: 'nope' } } } }), { total: 0, packages: 0 })
})

test('parseCredits ignores negative remainders', () => {
  assert.deepEqual(parseCredits({
    data: { Response: { Data: { Accounts: [
      { CycleCapacityRemainPrecise: '-1' },
      { CycleCapacityRemainPrecise: '2.5' },
    ] } } },
  }), { total: 2.5, packages: 1 })
})
