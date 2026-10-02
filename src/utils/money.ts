import { Prisma } from '../../generated/prisma/client.js';

// Single currency for the whole system today - kept as a constant rather
// than a DB column so there's nothing for a client to override and nothing
// to keep in sync everywhere the same fixed value would otherwise live.
export const CURRENCY = 'INR';

export function toMoneyString(amount: Prisma.Decimal | number | string): string {
  return new Prisma.Decimal(amount).toFixed(2);
}

export function toMoney(amount: Prisma.Decimal | number | string) {
  return { amount: toMoneyString(amount), currency: CURRENCY };
}

export function sumDecimal(values: Array<Prisma.Decimal | number | string>): Prisma.Decimal {
  return values.reduce((sum: Prisma.Decimal, v) => sum.plus(v), new Prisma.Decimal(0));
}
