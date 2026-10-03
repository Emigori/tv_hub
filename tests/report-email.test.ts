import nodemailer from 'nodemailer';
import { sendReportCreatedEmail, sendReportResolvedEmail } from '../src/notifications/report-email.js';

const sendMail = jest.fn().mockResolvedValue({ messageId: 'test' });
jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);

const report = {
  _id: { toString: () => '6ac12d3bd38668627b5c6294' },
  reason: 'AUDIO_PROBLEM',
  description: 'No sound <b>at all</b>',
  status: 'OPEN',
  createdAt: new Date('2026-10-03T16:28:43.086Z'),
  evidenceUrls: ['/uploads/reports/a.png']
};

beforeEach(() => sendMail.mockClear());

test('report-created email includes channel, reason, description, status and creation date', async () => {
  await sendReportCreatedEmail(report, '15TV');

  const message = sendMail.mock.calls[0][0];
  expect(message.to).toBe('reports@tvhub.local');
  expect(message.subject).toContain('15TV');
  for (const value of ['15TV', 'Problema de audio', 'No sound <b>at all</b>', 'OPEN', '3 de octubre de 2026']) {
    expect(message.text).toContain(value);
  }
  expect(message.html).toContain('No sound &lt;b&gt;at all&lt;/b&gt;');
});

test('report-resolved email goes to the recipient and says the report was resolved', async () => {
  await sendReportResolvedEmail({ ...report, status: 'RESOLVED', resolvedAt: new Date('2026-10-03T17:00:00Z') }, '15TV', 'owner@example.com');

  const message = sendMail.mock.calls[0][0];
  expect(message.to).toBe('owner@example.com');
  expect(message.subject).toMatch(/resuelto/i);
  for (const value of ['#5C6294', '15TV', 'RESOLVED', 'resolvió']) expect(message.text).toContain(value);
});
