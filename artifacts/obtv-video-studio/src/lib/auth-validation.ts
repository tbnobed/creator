import { z } from "zod";

const emailSchema = z.string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required")
  .email("Enter a valid email address")
  .max(320, "Email must be 320 characters or fewer");

export const loginSchema = z.object({
  email: emailSchema,
  // Authenticate existing credentials without applying new-account policy.
  password: z.string().min(1, "Password is required").max(128, "Password must be 128 characters or fewer"),
});

export const registrationSchema = loginSchema.extend({
  password: z.string().min(12, "Password must be at least 12 characters").max(128, "Password must be 128 characters or fewer"),
  displayName: z.string().trim().min(1, "Display name is required").max(160, "Display name must be 160 characters or fewer"),
  confirmPassword: z.string(),
  bootstrapToken: z.string()
    .max(256, "Setup token must be 256 characters or fewer")
    .refine((value) => !value || value.length >= 32, "Setup token must be at least 32 characters")
    .optional(),
}).refine(({ password, confirmPassword }) => password === confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});