import { z } from 'zod';

/**
 * Validation schemas for Better Auth's own endpoints (sign in / sign up / create
 * organization). These are NOT in `@rms/contract` — that package covers the domain
 * API, not Better Auth's endpoints — so they live here, next to the forms that use
 * them, same as every other react-hook-form + zodResolver pair in this app.
 */

export const signInSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  // Deliberately no min-length here: a user's existing password may predate a policy
  // change. Length is enforced at sign-up, where the password is actually chosen.
  password: z.string().min(1, 'Password is required'),
});
export type SignInValues = z.infer<typeof signInSchema>;

export const signUpSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});
export type SignUpValues = z.infer<typeof signUpSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
});
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Confirm your password'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const onboardingSchema = z.object({
  name: z.string().min(1, 'Organization name is required'),
  slug: z
    .string()
    .min(1, 'URL is required')
    .regex(slugPattern, 'Use lowercase letters, numbers and hyphens only'),
});
export type OnboardingValues = z.infer<typeof onboardingSchema>;
