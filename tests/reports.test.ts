import { access, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../src/app.js';
import { Channel } from '../src/models/channel.model.js';
import { Report } from '../src/models/report.model.js';
import { Session } from '../src/models/session.model.js';
import { User } from '../src/models/user.model.js';
import { reportUploadsDirectory } from '../src/middleware/upload.js';
import { emitReportCreated, emitReportUpdated } from '../src/realtime/socket.js';
import { sendReportCreatedEmail, sendReportResolvedEmail } from '../src/notifications/report-email.js';

jest.mock('../src/realtime/socket.js', () => ({
  emitReportCreated: jest.fn(),
  emitReportUpdated: jest.fn()
}));

jest.mock('../src/notifications/report-email.js', () => ({
  sendReportCreatedEmail: jest.fn().mockResolvedValue(undefined),
  sendReportResolvedEmail: jest.fn().mockResolvedValue(undefined)
}));

const createdEmail = sendReportCreatedEmail as jest.MockedFunction<typeof sendReportCreatedEmail>;
const resolvedEmail = sendReportResolvedEmail as jest.MockedFunction<typeof sendReportResolvedEmail>;

let mongo: MongoMemoryServer;
let channelId: string;

async function registerAgent(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/register').send({ email, password: 'StrongPass123!' }).expect(201);
  return agent;
}

function reportFields(description = 'A valid report description.') {
  return { channelId, reason: 'VIDEO_PROBLEM', description };
}

async function clearUploadedEvidence() {
  const names = await readdir(reportUploadsDirectory);
  await Promise.all(names.filter((name) => name !== '.gitkeep').map((name) => unlink(path.join(reportUploadsDirectory, name))));
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  jest.clearAllMocks();
  await Report.deleteMany({});
  await Session.deleteMany({});
  await User.deleteMany({});
  await Channel.deleteMany({});
  await clearUploadedEvidence();

  const channel = await Channel.create({
    name: 'Report Channel',
    logoUrl: 'https://example.com/logo.png',
    streamUrl: 'https://example.com/stream.m3u8',
    country: 'Mexico',
    categories: ['News'],
    isActive: true
  });
  channelId = channel.id;
});

afterAll(async () => {
  await clearUploadedEvidence();
  await mongoose.disconnect();
  await mongo.stop();
});

test('reports require authentication', async () => {
  await request(app).get('/api/reports').expect(401);
  await request(app).post('/api/reports').expect(401);
  await request(app).patch('/api/reports/507f1f77bcf86cd799439011').expect(401);
  await request(app).delete('/api/reports/507f1f77bcf86cd799439011').expect(401);
});

test('an authenticated user can create and list a report', async () => {
  const agent = await registerAgent('reporter@example.com');
  const created = await agent.post('/api/reports').field(reportFields('The channel has no sound.')).expect(201);

  expect(created.body.report).toEqual(expect.objectContaining({
    channelId,
    reason: 'VIDEO_PROBLEM',
    description: 'The channel has no sound.',
    evidenceUrls: [],
    status: 'OPEN'
  }));

  const listed = await agent.get('/api/reports').expect(200);
  expect(listed.body.reports).toHaveLength(1);
  expect(listed.body.reports[0].channelId).toEqual(expect.objectContaining({ name: 'Report Channel' }));
  expect(listed.body.reports[0].evidenceUrls).toEqual([]);
  expect(emitReportCreated).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ channelId: expect.objectContaining({ name: 'Report Channel' }) })
  );
});

test('sends the report-created email after the report is persisted', async () => {
  const agent = await registerAgent('mail-created@example.com');
  createdEmail.mockImplementationOnce(async (report) => {
    // Cuando se intenta el envío, el Report ya existe en MongoDB.
    expect(await Report.countDocuments({ description: report.description })).toBe(1);
  });

  await agent.post('/api/reports').field(reportFields('Email after persistence.')).expect(201);

  expect(createdEmail).toHaveBeenCalledTimes(1);
  expect(createdEmail).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'VIDEO_PROBLEM', description: 'Email after persistence.', status: 'OPEN' }),
    'Report Channel'
  );
});

test('keeps a persisted report when the report-created email delivery fails', async () => {
  const agent = await registerAgent('mail-failure@example.com');
  createdEmail.mockRejectedValueOnce(new Error('SMTP is down'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  const created = await agent.post('/api/reports').field(reportFields('Mail fails but report stays.'))
    .attach('evidence', Buffer.from('image'), { filename: 'kept.png', contentType: 'image/png' })
    .expect(201);

  expect(await Report.findById(created.body.report._id)).toEqual(expect.objectContaining({ status: 'OPEN' }));
  await request(app).get(created.body.report.evidenceUrls[0]).expect(200);
  expect(emitReportCreated).toHaveBeenCalledTimes(1);
  consoleError.mockRestore();
});

test('resolution email is sent once, only after RESOLVED is persisted, and failures keep the resolution', async () => {
  const owner = await registerAgent('mail-owner@example.com');
  const created = await owner.post('/api/reports').field(reportFields()).expect(201);
  const admin = await registerAgent('mail-admin@example.com');
  await User.updateOne({ email: 'mail-admin@example.com' }, { role: 'ADMIN' });
  await admin.post('/api/auth/login').send({ email: 'mail-admin@example.com', password: 'StrongPass123!' }).expect(200);

  resolvedEmail.mockImplementationOnce(async () => {
    const stored = await Report.findById(created.body.report._id);
    expect(stored).toEqual(expect.objectContaining({ status: 'RESOLVED', resolvedAt: expect.any(Date) }));
    throw new Error('SMTP is down');
  });
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  await admin.patch(`/api/admin/reports/${created.body.report._id}/close`).expect(200);
  expect(resolvedEmail).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'RESOLVED' }),
    'Report Channel',
    'mail-owner@example.com'
  );
  const stored = await Report.findById(created.body.report._id);
  expect(stored?.status).toBe('RESOLVED');
  expect(stored?.resolvedAt).toBeInstanceOf(Date);
  expect(stored?.resolvedBy).toBeDefined();
  expect(emitReportUpdated).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'RESOLVED' }));

  // Cerrar de nuevo no reenvía el correo.
  await admin.patch(`/api/admin/reports/${created.body.report._id}/close`).expect(200);
  expect(resolvedEmail).toHaveBeenCalledTimes(1);
  consoleError.mockRestore();
});

test('only an ADMIN can view the support report queue', async () => {
  const reporter = await registerAgent('support-reporter@example.com');
  await reporter.post('/api/reports').field(reportFields()).expect(201);
  await reporter.get('/api/admin/reports').expect(403);

  const admin = await registerAgent('support-admin@example.com');
  await User.updateOne({ email: 'support-admin@example.com' }, { role: 'ADMIN' });
  await admin.post('/api/auth/login').send({ email: 'support-admin@example.com', password: 'StrongPass123!' }).expect(200);

  const listed = await admin.get('/api/admin/reports').expect(200);
  expect(listed.body.reports).toHaveLength(1);
  expect(listed.body.reports[0]).toEqual(expect.objectContaining({
    channelId: expect.objectContaining({ name: 'Report Channel' }),
    userId: expect.objectContaining({ email: 'support-reporter@example.com' })
  }));
});

test('an ADMIN closes a report and the owner sees RESOLVED', async () => {
  const owner = await registerAgent('close-owner@example.com');
  const created = await owner.post('/api/reports').field(reportFields()).expect(201);
  const admin = await registerAgent('close-admin@example.com');
  await User.updateOne({ email: 'close-admin@example.com' }, { role: 'ADMIN' });
  await admin.post('/api/auth/login').send({ email: 'close-admin@example.com', password: 'StrongPass123!' }).expect(200);
  jest.clearAllMocks();

  const closed = await admin.patch(`/api/admin/reports/${created.body.report._id}/close`).expect(200);

  expect(closed.body.report).toEqual(expect.objectContaining({ status: 'RESOLVED', resolvedAt: expect.any(String) }));
  expect(emitReportUpdated).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'RESOLVED' }));
  const ownerReports = await owner.get('/api/reports').expect(200);
  expect(ownerReports.body.reports[0]).toEqual(expect.objectContaining({ status: 'RESOLVED', resolvedAt: expect.any(String) }));
  await owner.patch(`/api/reports/${created.body.report._id}`).send({
    reason: 'OTHER', description: 'This report is already resolved.', status: 'RESOLVED'
  }).expect(409, { error: { code: 'REPORT_ALREADY_RESOLVED', message: 'Resolved reports cannot be edited' } });
  await owner.delete(`/api/reports/${created.body.report._id}`).expect(409, {
    error: { code: 'REPORT_ALREADY_RESOLVED', message: 'Resolved reports cannot be deleted' }
  });
});

test('support metrics count only reports closed by an ADMIN', async () => {
  const owner = await registerAgent('metrics-owner@example.com');
  const closedCandidate = await owner.post('/api/reports').field(reportFields()).expect(201);
  await owner.post('/api/reports').field(reportFields('This report remains open.')).expect(201);
  const admin = await registerAgent('metrics-admin@example.com');
  await User.updateOne({ email: 'metrics-admin@example.com' }, { role: 'ADMIN' });
  await admin.post('/api/auth/login').send({ email: 'metrics-admin@example.com', password: 'StrongPass123!' }).expect(200);

  await admin.patch(`/api/admin/reports/${closedCandidate.body.report._id}/close`).expect(200);
  const metrics = await admin.get('/api/admin/reports/metrics?days=14').expect(200);

  expect(metrics.body.metrics).toHaveLength(1);
  expect(metrics.body.metrics[0]).toEqual(expect.objectContaining({
    day: expect.any(String),
    resolvedCount: 1,
    averageResponseMinutes: expect.any(Number)
  }));
  expect((await admin.get('/api/admin/reports?filter=open').expect(200)).body.reports).toHaveLength(1);
  expect((await admin.get('/api/admin/reports?filter=closed').expect(200)).body.reports).toHaveLength(1);
  expect((await admin.get('/api/admin/reports?filter=all').expect(200)).body.reports).toHaveLength(2);
});

test('POST accepts multiple evidence images and GET returns their URLs', async () => {
  const agent = await registerAgent('images@example.com');
  const created = await agent.post('/api/reports').field(reportFields())
    .attach('evidence', Buffer.from('first image'), { filename: 'first.png', contentType: 'image/png' })
    .attach('evidence', Buffer.from('second image'), { filename: 'second.jpg', contentType: 'image/jpeg' })
    .expect(201);

  expect(created.body.report.evidenceUrls).toHaveLength(2);
  await Promise.all(created.body.report.evidenceUrls.map((evidenceUrl: string) => request(app).get(evidenceUrl).expect(200)));

  const listed = await agent.get('/api/reports').expect(200);
  expect(listed.body.reports[0].evidenceUrls).toEqual(created.body.report.evidenceUrls);
});

test('POST rejects more than five evidence images', async () => {
  const agent = await registerAgent('limit@example.com');
  let response = agent.post('/api/reports').field(reportFields());
  for (let index = 0; index < 6; index += 1) {
    response = response.attach('evidence', Buffer.from(`image ${index}`), { filename: `${index}.png`, contentType: 'image/png' });
  }
  await response.expect(400, { error: { code: 'UPLOAD_ERROR', message: 'Could not upload evidence image' } });
});

test('reports reject invalid report data and invalid files', async () => {
  const agent = await registerAgent('validation@example.com');
  await agent.post('/api/reports').field({ channelId, reason: 'NOT_A_REASON', description: 'A valid description.' }).expect(400, {
    error: { code: 'INVALID_REPORT_REASON', message: 'Report reason is invalid' }
  });
  await agent.post('/api/reports').field({ channelId, reason: 'OTHER', description: '' }).expect(400, {
    error: { code: 'INVALID_REPORT_DESCRIPTION', message: 'Description is required' }
  });
  await agent.post('/api/reports').field({ channelId, reason: 'OTHER', description: 'Text evidence is invalid.' })
    .attach('evidence', Buffer.from('not an image'), { filename: 'evidence.txt', contentType: 'text/plain' })
    .expect(400, { error: { code: 'INVALID_EVIDENCE_FILE', message: 'Evidence must be an image file' } });
  await agent.post('/api/reports').field({ channelId, reason: 'OTHER', description: 'Large evidence is invalid.' })
    .attach('evidence', Buffer.alloc(2 * 1024 * 1024 + 1), { filename: 'large.png', contentType: 'image/png' })
    .expect(400, { error: { code: 'UPLOAD_ERROR', message: 'Evidence image must be 2 MB or smaller' } });
});

test('PATCH updates a report owned by the current user', async () => {
  const agent = await registerAgent('editor@example.com');
  const created = await agent.post('/api/reports').field(reportFields()).expect(201);
  const updated = await agent.patch(`/api/reports/${created.body.report._id}`).send({
    reason: 'AUDIO_PROBLEM',
    description: 'The audio is delayed.',
    status: 'IN_PROGRESS'
  }).expect(200);

  expect(updated.body.report).toEqual(expect.objectContaining({
    reason: 'AUDIO_PROBLEM',
    description: 'The audio is delayed.',
    status: 'IN_PROGRESS'
  }));
  expect(emitReportUpdated).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ status: 'IN_PROGRESS', channelId: expect.objectContaining({ name: 'Report Channel' }) })
  );
});

test('PATCH cannot update another user report', async () => {
  const owner = await registerAgent('owner@example.com');
  const otherUser = await registerAgent('other@example.com');
  const created = await owner.post('/api/reports').field(reportFields()).expect(201);

  await otherUser.patch(`/api/reports/${created.body.report._id}`).send({
    reason: 'OTHER',
    description: 'This must not update.',
    status: 'RESOLVED'
  }).expect(404, { error: { code: 'REPORT_NOT_FOUND', message: 'Report was not found' } });
});

test('DELETE removes an owned report and its physical evidence files', async () => {
  const agent = await registerAgent('deleter@example.com');
  const created = await agent.post('/api/reports').field(reportFields())
    .attach('evidence', Buffer.from('image evidence'), { filename: 'evidence.png', contentType: 'image/png' })
    .expect(201);
  const evidencePath = path.join(reportUploadsDirectory, path.basename(created.body.report.evidenceUrls[0]));
  await access(evidencePath);

  await agent.delete(`/api/reports/${created.body.report._id}`).expect(204);
  await expect(access(evidencePath)).rejects.toThrow();
  await agent.get('/api/reports').expect(200, { reports: [] });
});

test('DELETE cannot remove another user report', async () => {
  const owner = await registerAgent('delete-owner@example.com');
  const otherUser = await registerAgent('delete-other@example.com');
  const created = await owner.post('/api/reports').field(reportFields()).expect(201);

  await otherUser.delete(`/api/reports/${created.body.report._id}`).expect(404, {
    error: { code: 'REPORT_NOT_FOUND', message: 'Report was not found' }
  });
  await owner.get('/api/reports').expect(200);
});
