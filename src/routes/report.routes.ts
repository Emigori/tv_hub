import { Router } from 'express';
import { createReport, listReports } from '../controllers/report.controller.js';
import { authenticate } from '../middleware/authenticate.middleware.js';
import { upload } from '../middleware/upload.js';

export const reportRouter = Router();

reportRouter.get('/', authenticate, listReports);
// TODO v4.5 1:
// Completa el método de Multer utilizado para recibir una sola evidencia.
// Objetivo: procesar la imagen antes de ejecutar createReport.
// Resultado esperado: el Controller podrá acceder al archivo mediante request.file.
reportRouter.post(
  '/',
  authenticate,
  upload.single('evidence'),
  createReport
);
