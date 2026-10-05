/**
 * Resend wiring for transactional email — invite links and (new in this phase)
 * password resets, which landlords had no path to before.
 *
 * Fails soft, never hard: `RESEND_API_KEY` is unset in every local/Docker
 * environment (no key there — docs/TASKS/002-docker-local.md), and an invite or a
 * reset request must still succeed without it. The landlord always has the one-time
 * `inviteUrl` in the API response as a fallback; a missing reset email just means the
 * person has to ask the landlord, or a future admin tool, for help — it must never
 * turn into a 500 on an otherwise-successful request.
 */

export interface EmailEnv {
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  /**
   * Mailtrap sandbox, for local development only. Never set in production — prod
   * secrets are set with `wrangler secret put`, and these two are not among them.
   *
   * Mailtrap's SMTP credentials are useless here: Workers cannot open TCP sockets, so
   * nodemailer and every other SMTP client is unavailable. Its HTTP send API works
   * fine, which is the same reason the database goes through an HTTP proxy locally.
   */
  MAILTRAP_API_TOKEN?: string;
  MAILTRAP_INBOX_ID?: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Resend's shared sandbox sender. Only delivers to the Resend account's own
// verified address until a sending domain is verified — see docs/PLAN-V1.md §6
// Phase 4 (blocking devops prerequisite). Acceptable for Phase 1: the one-time
// `inviteUrl` is the real fallback, and this keeps local/dev working without secrets.
const DEFAULT_FROM = 'Rent Manager <onboarding@resend.dev>';

export async function sendEmail(env: EmailEnv, input: SendEmailInput): Promise<void> {
  // Dev first: when a Mailtrap sandbox is configured, every message is captured there
  // and nothing reaches a real inbox. This is what makes the password-reset flow
  // testable locally at all — its token exists only inside the email.
  if (env.MAILTRAP_API_TOKEN && env.MAILTRAP_INBOX_ID) {
    return sendViaMailtrap(env, input);
  }

  if (!env.RESEND_API_KEY) {
    console.log(`[email] RESEND_API_KEY not set — skipping send to ${input.to}: "${input.subject}"`);
    return;
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL ?? DEFAULT_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });

    if (!res.ok) {
      console.error(`[email] Resend returned ${res.status} sending to ${input.to}:`, await res.text());
    }
  } catch (err) {
    // An email provider outage must never fail the request that triggered the send —
    // the invite row (or reset token) is already committed before this runs.
    console.error(`[email] failed to send to ${input.to}:`, err);
  }
}

/** The invite email body. `orgName`/`tenantFirstName` are both landlord-controlled
 *  strings, so they are HTML-escaped before interpolation. */
export function renderInviteEmail(params: { orgName: string; tenantFirstName: string; url: string }): SendEmailInput {
  const orgName = escapeHtml(params.orgName);
  const tenantFirstName = escapeHtml(params.tenantFirstName);
  const { url } = params;

  return {
    to: '', // filled by the caller, which knows the invite's email
    subject: `${params.orgName} invited you to their tenant portal`,
    html: `
      <p>Hi ${tenantFirstName},</p>
      <p><strong>${orgName}</strong> has invited you to set up access to your tenant portal,
      where you can see your lease, your balance and your payment history.</p>
      <p><a href="${url}">Accept your invitation</a></p>
      <p>This link expires in 14 days and can only be used once. If you weren't expecting
      this, you can ignore this email.</p>
    `.trim(),
    text:
      `Hi ${params.tenantFirstName},\n\n` +
      `${params.orgName} has invited you to set up access to your tenant portal.\n\n` +
      `Accept your invitation: ${url}\n\n` +
      'This link expires in 14 days and can only be used once. If you weren\'t expecting ' +
      'this, you can ignore this email.',
  };
}

/** Better Auth's `sendResetPassword` callback shape — `{ user, url }`, both plain
 *  server-trusted values (the url is Better Auth's own verification link). */
export function renderResetPasswordEmail(params: { userName: string; url: string }): SendEmailInput {
  const userName = escapeHtml(params.userName);
  const { url } = params;

  return {
    to: '',
    subject: 'Reset your password',
    html: `
      <p>Hi ${userName},</p>
      <p>Someone requested a password reset for your account. If this was you, click
      below to choose a new password:</p>
      <p><a href="${url}">Reset your password</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `.trim(),
    text:
      `Hi ${params.userName},\n\n` +
      'Someone requested a password reset for your account. If this was you, use this ' +
      `link to choose a new password:\n\n${url}\n\n` +
      "If you didn't request this, you can safely ignore this email.",
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Mailtrap's sandbox HTTP API. Captures mail in an inbox instead of delivering it, so
 * a mistyped tenant address in development can never reach a real person.
 */
async function sendViaMailtrap(env: EmailEnv, input: SendEmailInput): Promise<void> {
  const url = `https://sandbox.api.mailtrap.io/api/send/${env.MAILTRAP_INBOX_ID}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Api-Token': env.MAILTRAP_API_TOKEN!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { email: 'no-reply@rentmanager.local', name: 'Rent Manager (dev)' },
        to: [{ email: input.to }],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
    if (!res.ok) {
      // Body may name the misconfiguration (bad token, wrong inbox) but never carries
      // the message contents, so it is safe to log.
      console.error(`[email] Mailtrap returned ${res.status} for ${input.to}:`, await res.text());
      return;
    }
    console.log(`[email] captured in Mailtrap sandbox: "${input.subject}" -> ${input.to}`);
  } catch (err) {
    console.error(`[email] Mailtrap send failed for ${input.to}:`, err);
  }
}
