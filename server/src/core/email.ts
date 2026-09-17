// Outgoing email via the Resend HTTP API. The API key lives in the deployment
// config (RESEND_API_KEY env/binding), set once at boot via initEmailConfig;
// the site URL used in message bodies stays an editable household setting.

import type { DbClient } from "./db.js";
import { getSetting } from "./db.js";

const FROM = "Clanboard <no-reply@clanboard.app>";

export interface EmailOptions {
  to: string;
  subject: string;
  text: string;
}

// Resolved from the deployment config at boot. The legacy admin-settings row
// ("resend_api_key") is kept purely as a fallback so un-configured dev boxes
// and the test suite keep working without a secret installed.
export interface EmailConfig {
  resendApiKey: string | null;
}

let emailConfig: EmailConfig = { resendApiKey: null };

export function initEmailConfig(cfg: Partial<EmailConfig>): void {
  emailConfig = { ...emailConfig, ...cfg };
}

async function configuredApiKey(db: DbClient): Promise<string | null> {
  return emailConfig.resendApiKey ?? (await getSetting(db, "resend_api_key"));
}

// True when a Resend API key is available (config binding or legacy setting).
export async function emailConfigured(db: DbClient): Promise<boolean> {
  return !!(await configuredApiKey(db));
}

// Send a plain-text email through Resend. Throws a 400 when no API key is
// configured, so callers (member creation) can fail loudly in the admin UI.
export async function sendEmail(db: DbClient, opts: EmailOptions): Promise<void> {
  const apiKey = await configuredApiKey(db);
  if (!apiKey) {
    throw Object.assign(new Error("Email sending is not configured. Add a RESEND_API_KEY secret in the deployment config."), {
      status: 400,
    });
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to: opts.to, subject: opts.subject, text: opts.text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[email] Resend error ${res.status}: ${detail}`);
    throw Object.assign(new Error("Could not send email right now — please try again later."), {
      status: 502,
    });
  }
}

export async function siteUrl(db: DbClient): Promise<string> {
  return (await getSetting(db, "site_url")) || "https://clanboard.app";
}

export async function sendWelcomeEmail(db: DbClient, to: string): Promise<void> {
  const base = await siteUrl(db);
  await sendEmail(db, {
    to,
    subject: "Welcome to Clanboard!",
    text: `Welcome to Clanboard!

Your account is ready. Sign in at ${base} — add it to your home screen (PWA) from the address bar and you'll have the whole family board one tap away.

You'll get a separate email with a temporary password for your first sign-in.`,
  });
}

export async function sendTemporaryPasswordEmail(
  db: DbClient,
  to: string,
  password: string,
  reason: "welcome" | "reset"
): Promise<void> {
  const base = await siteUrl(db);
  const subject = reason === "welcome" ? "Your Clanboard temporary password" : "Your Clanboard password has been reset";
  await sendEmail(db, {
    to,
    subject,
    text: `${subject}.

Your temporary password is:

  ${password}

Sign in at ${base} with your member name and this password. You'll be asked to choose a new password on your first sign-in.`,
  });
}