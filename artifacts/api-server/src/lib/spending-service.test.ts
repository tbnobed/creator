import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_SPENDING_USD,
  SpendingServiceError,
  microsToUsd,
  usdToMicros,
  utcMonthStart,
} from "./spending-service";
import { canManageMemberLimit } from "../routes/spending";

test("micro-USD conversion is exact through the one-million USD policy cap", () => {
  assert.equal(usdToMicros(0), 0);
  assert.equal(usdToMicros(0.000001), 1);
  assert.equal(usdToMicros(999_999.999999), 999_999_999_999);
  assert.equal(usdToMicros(MAX_SPENDING_USD), 1_000_000_000_000);
  assert.equal(microsToUsd(12_345_678), 12.345678);
});

test("invalid, unsafe, over-precision, and over-cap USD values are rejected", () => {
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_SPENDING_USD + 0.000001, 1.0000001]) {
    assert.throws(() => usdToMicros(value), SpendingServiceError);
  }
  assert.throws(() => microsToUsd(Number.MAX_SAFE_INTEGER + 1), /Unsafe micro-USD/);
});

test("calendar month attribution rolls over at midnight UTC", () => {
  assert.equal(utcMonthStart(new Date("2026-01-31T23:59:59.999Z")), "2026-01-01");
  assert.equal(utcMonthStart(new Date("2026-02-01T00:00:00.000Z")), "2026-02-01");
  assert.equal(utcMonthStart(new Date("2027-01-01T00:00:00.000+14:00")), "2026-12-01");
});

test("member-limit permissions prevent self edits and admin privilege escalation", () => {
  assert.equal(canManageMemberLimit(false, "owner-a", "OWNER", "member-b", "OWNER"), true);
  assert.equal(canManageMemberLimit(false, "owner-a", "OWNER", "owner-a", "OWNER"), false);
  assert.equal(canManageMemberLimit(false, "admin-a", "ADMIN", "member-b", "MEMBER"), true);
  assert.equal(canManageMemberLimit(false, "admin-a", "ADMIN", "admin-b", "ADMIN"), false);
  assert.equal(canManageMemberLimit(false, "admin-a", "ADMIN", "owner-b", "OWNER"), false);
  assert.equal(canManageMemberLimit(false, "member-a", "MEMBER", "member-b", "MEMBER"), false);
  assert.equal(canManageMemberLimit(true, "site-admin", undefined, "owner-b", "OWNER"), true);
});