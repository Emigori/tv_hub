import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import { env } from '../config/env.js';

type ReportEmailData = {
  reason: string;
  description: string;
  status: string;
  createdAt: Date;
  evidenceUrls: string[];
  // Opcionales: un documento de Mongoose los trae, pero el correo no depende de ellos.
  _id?: { toString(): string };
  resolvedAt?: Date | null;
  resolvedBy?: unknown;
};

let transporterPromise: Promise<Transporter> | undefined;
let usesEthereal = false;

async function getTransporter(): Promise<Transporter> {
  if (transporterPromise) return transporterPromise;

  transporterPromise = (async () => {
    if (env.nodeEnv === 'test') {
      return nodemailer.createTransport({ jsonTransport: true });
    }

    if (env.smtpHost) {
      usesEthereal = false;
      return nodemailer.createTransport({
        host: env.smtpHost,
        port: env.smtpPort,
        secure: env.smtpPort === 465,
        auth: env.smtpUser && env.smtpPass ? { user: env.smtpUser, pass: env.smtpPass } : undefined
      });
    }

    usesEthereal = true;
    const account = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass }
    });
  })();

  return transporterPromise;
}

async function sendWithTransporter(message: SendMailOptions): Promise<void> {
  const transporter = await getTransporter();
  const info = await transporter.sendMail(message);

  if (usesEthereal) {
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) console.log(`Email preview: ${previewUrl}`);
  }
}

const reasonLabels: Record<string, string> = {
  STREAM_DOES_NOT_LOAD: 'El stream no carga',
  WRONG_CHANNEL: 'Canal incorrecto',
  AUDIO_PROBLEM: 'Problema de audio',
  VIDEO_PROBLEM: 'Problema de video',
  OTHER: 'Otro'
};

function formatReason(reason: string): string {
  return reasonLabels[reason] ?? reason;
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return 'No disponible';
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City'
  }).format(new Date(date));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function reportReference(report: ReportEmailData): string {
  return report._id ? `#${report._id.toString().slice(-6).toUpperCase()}` : '';
}

function resolverEmail(report: ReportEmailData): string | undefined {
  const resolver = report.resolvedBy as { email?: unknown } | undefined;
  return typeof resolver?.email === 'string' ? resolver.email : undefined;
}

function renderEmail(title: string, intro: string, rows: Array<[string, string]>): { text: string; html: string } {
  const text = [title, '', intro, '', ...rows.map(([label, value]) => `${label}: ${value}`), '', '— TV Hub Support'].join('\n');
  const htmlRows = rows
    .map(([label, value]) => `<tr><th align="left" style="padding:6px 12px 6px 0;color:#475569">${escapeHtml(label)}</th><td style="padding:6px 0">${escapeHtml(value)}</td></tr>`)
    .join('');
  const html = `<div style="font-family:Arial,sans-serif;color:#0f172a;max-width:560px">
<h2 style="margin:0 0 8px">${escapeHtml(title)}</h2>
<p style="margin:0 0 16px">${escapeHtml(intro)}</p>
<table style="border-collapse:collapse">${htmlRows}</table>
<p style="margin-top:24px;color:#64748b;font-size:12px">— TV Hub Support</p>
</div>`;
  return { text, html };
}

export async function sendReportCreatedEmail(report: ReportEmailData, channelName: string): Promise<void> {
  // TODO V6 MAIL 1
  // Notificación para el buzón de soporte (REPORT_NOTIFICATION_EMAIL) con los
  // datos del incidente. Se envía con el transporter existente (Ethereal o SMTP).
  const reference = reportReference(report);
  const { text, html } = renderEmail(
    `Nuevo Report ${reference} · ${channelName}`.replace('  ', ' '),
    'Se registró un nuevo Report de un canal en TV Hub.',
    [
      ['Canal', channelName],
      ['Razón', formatReason(report.reason)],
      ['Descripción', report.description],
      ['Estado', report.status],
      ['Fecha de creación', formatDate(report.createdAt)],
      ['Evidencias', String(report.evidenceUrls.length)]
    ]
  );

  await sendWithTransporter({
    from: env.smtpFrom,
    to: env.reportNotificationEmail,
    subject: `[TV Hub] Nuevo Report: ${formatReason(report.reason)} en ${channelName}`,
    text,
    html
  });
}

export async function sendReportResolvedEmail(report: ReportEmailData, channelName: string, recipient: string): Promise<void> {
  // TODO V6 MAIL 2
  // Notificación para el usuario que creó el Report cuando soporte lo resuelve.
  const reference = reportReference(report);
  const rows: Array<[string, string]> = [
    ['Report', reference || `${formatReason(report.reason)} del ${formatDate(report.createdAt)}`],
    ['Canal', channelName],
    ['Razón', formatReason(report.reason)],
    ['Descripción', report.description],
    ['Estado final', report.status],
    ['Creado', formatDate(report.createdAt)],
    ['Resuelto', formatDate(report.resolvedAt)]
  ];
  const resolver = resolverEmail(report);
  if (resolver) rows.push(['Atendido por', resolver]);

  const { text, html } = renderEmail(
    `Tu Report ${reference} fue resuelto`.replace('  ', ' '),
    `Soporte de TV Hub resolvió el Report que enviaste sobre ${channelName}. Gracias por avisarnos.`,
    rows
  );

  await sendWithTransporter({
    from: env.smtpFrom,
    to: recipient,
    subject: `[TV Hub] Tu Report sobre ${channelName} fue resuelto`,
    text,
    html
  });
}
