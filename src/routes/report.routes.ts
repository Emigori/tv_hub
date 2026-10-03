import { Router } from 'express';
import { createReport, deleteReport, listReports, updateReport } from '../controllers/report.controller.js';
import { authenticate } from '../middleware/authenticate.middleware.js';
import { upload } from '../middleware/upload.js';

export const reportRouter = Router();

reportRouter.get('/', authenticate, listReports);
// TODO v4.5 1 / TODO 7:
// Multer procesa hasta 5 imágenes del campo "evidence" antes de ejecutar createReport.
// El Controller accede a los archivos mediante request.files.
reportRouter.post(
  '/',
  authenticate,
  upload.array('evidence', 5),
  createReport
);

// TODO 11: modificar parcialmente un Report (reason, description, status).
reportRouter.patch(
  '/:id',
  authenticate,
  updateReport
);

// TODO 14: eliminar un Report propio.
reportRouter.delete(
  '/:id',
  authenticate,
  deleteReport
);
