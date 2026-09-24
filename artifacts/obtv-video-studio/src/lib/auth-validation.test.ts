import assert from "node:assert/strict";
import test from "node:test";
import { LoginBody, RegisterBody } from "../../../../lib/api-zod/src/generated/api";
import { loginSchema, registrationSchema } from "./auth-validation";

const email = "test@example.com";

test("sign-in accepts shorter existing passwords in the form and API", () => {
  for (const password of ["a", "old-pass", "elevenchars", " spaced "]) {
    for (const schema of [loginSchema, LoginBody]) {
      assert.equal(schema.parse({ email, password }).password, password);
    }
  }
});

test("sign-in still rejects empty and oversized passwords", () => {
  for (const password of ["", "a".repeat(129)]) {
    for (const schema of [loginSchema, LoginBody]) {
      assert.equal(schema.safeParse({ email, password }).success, false);
    }
  }
});

test("new accounts still require at least twelve characters", () => {
  for (const password of ["old-pass", "twelve-chars!"]) {
    const data = { email, password, confirmPassword: password, displayName: "Test" };
    for (const schema of [registrationSchema, RegisterBody]) {
      assert.equal(schema.safeParse(data).success, password.length >= 12);
    }
  }
});