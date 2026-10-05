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
