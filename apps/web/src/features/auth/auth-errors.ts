/**
 * Better Auth responds with its own `{ message, code }` shape — a different contract
 * from this app's domain API (`{ error: { code, message } }`, see `ApiClientError`).
 * We never show Better Auth's raw `message` to a user: it's an implementation detail
 * ("User already exists. Use another email.") rather than copy we control, and some
 * codes must be deliberately flattened for security (sign-in never reveals whether an
 * email is registered). Map every code we handle explicitly; fall back to one generic
 * message for everything else.
 */

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Sign-in errors. A wrong password and an unknown account must read identically, so
 * neither INVALID_EMAIL_OR_PASSWORD nor a not-found case leaks which one occurred.
 */
export function mapSignInError(code: string | undefined): string {
  switch (code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
    case 'USER_NOT_FOUND':
      return 'Incorrect email or password.';
    case 'EMAIL_NOT_VERIFIED':
      return 'Please verify your email before signing in.';
    default:
      return GENERIC_MESSAGE;
  }
}

/** Sign-up errors. Here, unlike sign-in, it's fine (and helpful) to say the email is taken. */
export function mapSignUpError(code: string | undefined): string {
  switch (code) {
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return 'An account with this email already exists.';
    case 'INVALID_EMAIL':
      return 'Enter a valid email address.';
    case 'PASSWORD_TOO_SHORT':
      return 'Password must be at least 8 characters.';
    case 'PASSWORD_TOO_LONG':
      return 'Password is too long.';
    default:
      return GENERIC_MESSAGE;
  }
}

/**
 * Requesting a reset email never reveals whether the address has an account
 * — Better Auth returns `{ status: true }` either way, by design. This only
 * covers genuine failures (rate limiting, a malformed request).
 */
export function mapForgotPasswordError(_code: string | undefined): string {
  return GENERIC_MESSAGE;
}

/** Submitting a new password with the emailed token. */
export function mapResetPasswordError(code: string | undefined): string {
  switch (code) {
    case 'INVALID_TOKEN':
      return 'This reset link is no longer valid. Request a new one.';
    case 'PASSWORD_TOO_SHORT':
      return 'Password must be at least 8 characters.';
    case 'PASSWORD_TOO_LONG':
      return 'Password is too long.';
    default:
      return GENERIC_MESSAGE;
  }
}

/** Organization-creation errors, shown on the onboarding form. */
export function mapOnboardingError(code: string | undefined): string {
  switch (code) {
    case 'ORGANIZATION_SLUG_ALREADY_TAKEN':
      return 'That URL is already taken. Try another.';
    case 'YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS':
      return "You've reached the maximum number of organizations.";
    case 'YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION':
      return "You're not allowed to create a new organization.";
    default:
      return GENERIC_MESSAGE;
  }
}
