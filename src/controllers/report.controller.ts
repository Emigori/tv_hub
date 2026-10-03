import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { isValidObjectId } from 'mongoose';
import { reportUploadsDirectory } from '../middleware/upload.js';
import { Channel } from '../models/channel.model.js';
import { Report, reportReasons, reportStatuses } from '../models/report.model.js';
import { AppError } from '../utils/app-error.js';

function getUserId(request: Parameters<RequestHandler>[0]): string {
  if (!request.auth) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  return request.auth.userId;
}

function readRequiredText(value: unknown, code: string, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, code, message);
  return value.trim();
}

function readReason(value: unknown): string {
  const reason = readRequiredText(value, 'INVALID_REPORT_REASON', 'Report reason is invalid');
  if (!reportReasons.includes(reason as (typeof reportReasons)[number])) {
    throw new AppError(400, 'INVALID_REPORT_REASON', 'Report reason is invalid');
  }
  return reason;
}

function readDescription(value: unknown): string {
  const description = readRequiredText(value, 'INVALID_REPORT_DESCRIPTION', 'Description is required');
  if (description.length > 1000) {
    throw new AppError(400, 'INVALID_REPORT_DESCRIPTION', 'Description must be 1000 characters or fewer');
  }
  return description;
}

function readStatus(value: unknown): string {
  const status = readRequiredText(value, 'INVALID_REPORT_STATUS', 'Report status is invalid');
  if (!reportStatuses.includes(status as (typeof reportStatuses)[number])) {
    throw new AppError(400, 'INVALID_REPORT_STATUS', 'Report status is invalid');
  }
  return status;
}

function readReportId(request: Parameters<RequestHandler>[0]): string {
  const reportId = request.params.id;
  if (typeof reportId !== 'string' || !isValidObjectId(reportId)) {
    throw new AppError(400, 'INVALID_REPORT_ID', 'Report id is invalid');
  }
  return reportId;
}

function getUploadedFiles(request: Parameters<RequestHandler>[0]): Express.Multer.File[] {
  return Array.isArray(request.files) ? request.files : [];
}

async function removeUploadedEvidence(files: Express.Multer.File[]): Promise<void> {
  await Promise.all(files.map((file) => unlink(file.path).catch(() => undefined)));
}

// Reto adicional: convertir /uploads/reports/archivo.png en una ruta del filesystem y borrarla.
async function removeStoredEvidence(evidenceUrls: string[]): Promise<void> {
  await Promise.all(evidenceUrls.map((url) => {
    const filePath = path.join(reportUploadsDirectory, path.basename(url));
    return unlink(filePath).catch(() => undefined);
  }));
}

export const createReport: RequestHandler = async (request, response) => {
  // TODO 9: Multer deja la lista de archivos en request.files.
  const files = getUploadedFiles(request);

  try {
    const userId = getUserId(request);
    const channelId = readRequiredText(request.body.channelId, 'INVALID_CHANNEL_ID', 'Channel id is invalid');
    if (!isValidObjectId(channelId)) throw new AppError(400, 'INVALID_CHANNEL_ID', 'Channel id is invalid');

    const reason = readReason(request.body.reason);
    const description = readDescription(request.body.description);

    const channel = await Channel.findOne({ _id: channelId, isActive: true });
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel was not found');

    // TODO v4.5 2 / TODO 9:
    // Cada archivo guardado por Multer se convierte en una URL pública basada en file.filename.
    const evidenceUrls = files.map(
      (file) => `/uploads/reports/${file.filename}`
    );

    // TODO v4.5 3:
    // Report.create persiste los datos del reporte y las referencias de las evidencias.
    const report = await Report.create({
      userId,
      channelId,
      reason,
      description,
      evidenceUrls
    });

    response.status(201).json({ report });
  } catch (error) {
    await removeUploadedEvidence(files);
    throw error;
  }
};

export const listReports: RequestHandler = async (request, response) => {
  // TODO v4.5 6:
  // Report.find recupera únicamente los Reports del usuario autenticado, del más reciente al más antiguo.
  const reports = await Report.find({ userId: getUserId(request) })
    .populate('channelId', 'name')
    .sort('-createdAt');

  response.json({ reports });
};

export const updateReport: RequestHandler = async (request, response) => {
  const userId = getUserId(request);
  const reportId = readReportId(request);
  const body = request.body ?? {};

  const changes: Record<string, string> = {};
  if (body.reason !== undefined) changes.reason = readReason(body.reason);
  if (body.description !== undefined) changes.description = readDescription(body.description);
  if (body.status !== undefined) changes.status = readStatus(body.status);
  if (Object.keys(changes).length === 0) {
    throw new AppError(400, 'EMPTY_REPORT_UPDATE', 'Provide reason, description or status');
  }

  // TODO 12: filtrar por _id y userId evita modificar Reports de otros usuarios.
  const report = await Report.findOneAndUpdate(
    {
      _id: reportId,
      userId
    },
    changes,
    {
      new: true,
      runValidators: true
    }
  ).populate('channelId', 'name');

  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report was not found');
  response.json({ report });
};

export const deleteReport: RequestHandler = async (request, response) => {
  const userId = getUserId(request);
  const reportId = readReportId(request);

  // TODO 15: eliminar solamente Reports propios.
  const report = await Report.findOneAndDelete({
    _id: reportId,
    userId
  });

  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report was not found');

  // Reto adicional: borrar también las imágenes físicas del storage local.
  await removeStoredEvidence(report.evidenceUrls ?? []);
  response.status(204).end();
};
