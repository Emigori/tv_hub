import { unlink } from 'node:fs/promises';
import type { RequestHandler } from 'express';
import { isValidObjectId } from 'mongoose';
import { Channel } from '../models/channel.model.js';
import { Report, reportReasons } from '../models/report.model.js';
import { AppError } from '../utils/app-error.js';

function getUserId(request: Parameters<RequestHandler>[0]): string {
  if (!request.auth) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  return request.auth.userId;
}

function readRequiredText(value: unknown, code: string, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, code, message);
  return value.trim();
}

async function removeUploadedEvidence(file: Express.Multer.File | undefined): Promise<void> {
  if (file) await unlink(file.path).catch(() => undefined);
}

export const createReport: RequestHandler = async (request, response) => {
  const file = request.file;

  try {
    const userId = getUserId(request);
    const channelId = readRequiredText(request.body.channelId, 'INVALID_CHANNEL_ID', 'Channel id is invalid');
    if (!isValidObjectId(channelId)) throw new AppError(400, 'INVALID_CHANNEL_ID', 'Channel id is invalid');

    const reason = readRequiredText(request.body.reason, 'INVALID_REPORT_REASON', 'Report reason is invalid');
    if (!reportReasons.includes(reason as (typeof reportReasons)[number])) {
      throw new AppError(400, 'INVALID_REPORT_REASON', 'Report reason is invalid');
    }

    const description = readRequiredText(request.body.description, 'INVALID_REPORT_DESCRIPTION', 'Description is required');
    if (description.length > 1000) {
      throw new AppError(400, 'INVALID_REPORT_DESCRIPTION', 'Description must be 1000 characters or fewer');
    }

    const channel = await Channel.findOne({ _id: channelId, isActive: true });
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel was not found');

    // TODO v4.5 2:
    // Completa la propiedad de Multer que contiene el nombre final del archivo.
    // Objetivo: construir la URL que se almacenará dentro del Report.
    // Resultado esperado: evidenceUrl tendrá una ruta como /uploads/reports/archivo.png.
    const evidenceUrl = file
      ? `/uploads/reports/${file.filename}`
      : undefined;

    // TODO v4.5 3:
    // Completa el método del Model utilizado para crear un nuevo Report.
    // Objetivo: persistir los datos del reporte y la referencia de la evidencia.
    // Resultado esperado: MongoDB contendrá un nuevo Report con status OPEN.
    const report = await Report.create({
      userId,
      channelId,
      reason,
      description,
      evidenceUrl
    });

    response.status(201).json({ report });
  } catch (error) {
    await removeUploadedEvidence(file);
    throw error;
  }
};

export const listReports: RequestHandler = async (request, response) => {
  // TODO v4.5 6:
  // Completa el método de Mongoose utilizado para consultar los Reports del usuario.
  // Objetivo: recuperar los reportes existentes del usuario autenticado.
  // Resultado esperado: GET /api/reports devolverá los Reports ordenados por fecha.
  const reports = await Report.find({ userId: getUserId(request) })
    .populate('channelId', 'name')
    .sort('-createdAt');

  response.json({ reports });
};
