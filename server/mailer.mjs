// Transactional email. Pluggable provider — Resend over HTTP today (no extra
// dependency), trivially swappable for SES/Postmark/SMTP. When no provider is
// configured, sends fall back to a console log so dev/stub still works.
import { config } from "./config.mjs";

/** True when a real email provider is wired up (so resets actually deliver). */
export function emailConfigured() {
  return config.email.provider === "resend" && !!config.email.resendApiKey;
}

/**
 * Send one email. Returns { delivered: true } when a provider actually accepted
 * it, { delivered: false } when it only fell back to logging. Throws if a
 * configured provider rejects the send (so the caller can log the failure).
 */
export async function sendEmail({ to, subject, html, text }) {
  if (config.email.provider === "resend" && config.email.resendApiKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.email.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: config.email.from, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
    }
    return { delivered: true };
  }
  // No provider configured — log so a developer can still grab the contents.
  console.log(`[kolex] (no email provider) → ${to}: ${subject}`);
  return { delivered: false };
}

/** Branded password-reset email (HTML + plain-text). */
export function passwordResetEmail(resetUrl) {
  const text = `Reset your Kolex password

Click the link below to choose a new password. It expires in 1 hour and can be
used once. If you didn't request this, you can ignore this email.

${resetUrl}
`;
  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#0a0e0c;font-family:-apple-system,Segoe UI,sans-serif;color:#eaf6ef">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px">
      <div style="font-weight:800;font-size:20px;letter-spacing:-.03em;color:#16e0a3;margin-bottom:20px">kolex</div>
      <h1 style="font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0 0 12px">Reset your password</h1>
      <p style="color:#8a9a91;font-size:15px;line-height:1.6;margin:0 0 22px">
        Click the button to choose a new password. This link expires in 1 hour and can be used once.
        If you didn't request it, you can safely ignore this email.
      </p>
      <a href="${resetUrl}" style="display:inline-block;background:#16e0a3;color:#052016;font-weight:700;text-decoration:none;padding:13px 24px;border-radius:10px;font-size:15px">Set a new password</a>
      <p style="color:#5e6e65;font-size:12px;line-height:1.6;margin:24px 0 0">
        Or paste this link into your browser:<br />
        <a href="${resetUrl}" style="color:#16e0a3;word-break:break-all">${resetUrl}</a>
      </p>
    </div>
  </body>
</html>`;
  return { subject: "Reset your Kolex password", html, text };
}

/** Branded email-verification email (HTML + plain-text). */
export function verifyEmail(verifyUrl, bonusUsd = 0) {
  const bonusLine = bonusUsd > 0
    ? `Verifying is step one toward your $${bonusUsd.toFixed(2)} welcome bonus (then add the extension at launch and clock 5 minutes of AI loading time).`
    : `Verifying keeps your account secure.`;
  const text = `Confirm your email for Kolex

${bonusLine}

Click to confirm:
${verifyUrl}

This link expires in 7 days. If you didn't create a Kolex account, ignore this email.
`;
  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#0a0e0c;font-family:-apple-system,Segoe UI,sans-serif;color:#eaf6ef">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px">
      <div style="font-weight:800;font-size:20px;letter-spacing:-.03em;color:#16e0a3;margin-bottom:20px">kolex</div>
      <h1 style="font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0 0 12px">Confirm your email</h1>
      <p style="color:#8a9a91;font-size:15px;line-height:1.6;margin:0 0 22px">
        ${bonusLine} Tap the button to confirm this is you.
      </p>
      <a href="${verifyUrl}" style="display:inline-block;background:#16e0a3;color:#052016;font-weight:700;text-decoration:none;padding:13px 24px;border-radius:10px;font-size:15px">Confirm my email</a>
      <p style="color:#5e6e65;font-size:12px;line-height:1.6;margin:24px 0 0">
        Or paste this link into your browser:<br />
        <a href="${verifyUrl}" style="color:#16e0a3;word-break:break-all">${verifyUrl}</a>
      </p>
    </div>
  </body>
</html>`;
  return { subject: "Confirm your email for Kolex", html, text };
}
