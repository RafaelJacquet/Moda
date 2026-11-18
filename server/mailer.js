// Envoi des codes de connexion. Sans SMTP configuré : mode développement,
// le code est affiché dans la console du serveur.
import nodemailer from 'nodemailer';
import { config } from './config.js';

const smtpConfigured = Boolean(config.smtp.host);

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

export function isSmtpConfigured() {
  return smtpConfigured;
}

export async function sendOtp(email, code) {
  const minutes = Math.round(config.otpTtlMs / 60000);
  if (!transporter) {
    // eslint-disable-next-line no-console
    console.log(`\n  ┌──────────────────────────────────────────────┐`);
    console.log(`  │  [DEV] Code de connexion pour ${email}`);
    console.log(`  │  CODE : ${code}   (valable ${minutes} min)`);
    console.log(`  └──────────────────────────────────────────────┘\n`);
    return;
  }
  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: `${code} — votre code de connexion French Flair Moda`,
    text:
      `Bonjour,\n\nVotre code de connexion : ${code}\n` +
      `Il est valable ${minutes} minutes.\n\n` +
      `Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.\n\n` +
      `— French Flair Moda`,
    html:
      `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;` +
      `background:#F2E8D8;border-radius:16px;color:#1A0033">` +
      `<h2 style="color:#4B0090;margin-top:0">French Flair — Moda</h2>` +
      `<p>Votre code de connexion :</p>` +
      `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#4B0090;` +
      `background:#fff;padding:16px;border-radius:12px;text-align:center">${code}</p>` +
      `<p>Il est valable ${minutes} minutes.</p>` +
      `<p style="color:#666;font-size:12px">Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>` +
      `</div>`,
  });
}
