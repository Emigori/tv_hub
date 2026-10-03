import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { Report } from '../models/report.model.js';
import { emitReportUpdated } from '../realtime/socket.js';

let escalationTask: ScheduledTask | undefined;

export async function escalateOldReports(): Promise<number> {
  // TODO V6 CRON 1
  // Un Report OPEN se escala cuando su createdAt es anterior o igual al threshold
  // (ahora - REPORT_ESCALATION_MINUTES).
  const threshold = new Date(Date.now() - env.reportEscalationMinutes * 60_000);
  const candidates = await Report.find({ status: 'OPEN', createdAt: { $lte: threshold } }).select('_id');

  let escalatedCount = 0;
  for (const { _id } of candidates) {
    // La condición status: 'OPEN' se repite en la actualización para no pisar un
    // Report que soporte resolvió o que el usuario editó entre la consulta y el guardado.
    const report = await Report.findOneAndUpdate(
      { _id, status: 'OPEN' },
      { status: 'ESCALATED' },
      { new: true, runValidators: true }
    ).populate([
      { path: 'channelId', select: 'name' },
      { path: 'userId', select: 'email' }
    ]);
    if (!report) continue;

    const owner = report.userId as unknown as { _id: { toString(): string } };
    emitReportUpdated(owner._id.toString(), report.toObject());
    escalatedCount += 1;
  }

  return escalatedCount;
}

export function startReportEscalationJob(): void {
  // TODO V6 CRON 2
  // Ejecuta escalateOldReports() con la expresión REPORT_ESCALATION_CRON.
  // noOverlap evita dos ejecuciones simultáneas y el try/catch impide que un
  // error del job detenga el servidor.
  if (escalationTask) return;

  escalationTask = cron.schedule(
    env.reportEscalationCron,
    async () => {
      try {
        const escalatedCount = await escalateOldReports();
        if (escalatedCount > 0) {
          console.log(`[report-escalation] ${escalatedCount} report(s) escalated to ESCALATED`);
        }
      } catch (error) {
        console.error('[report-escalation] Job failed:', error);
      }
    },
    { name: 'report-escalation', noOverlap: true }
  );

  console.log(
    `[report-escalation] Job scheduled with "${env.reportEscalationCron}" (threshold: ${env.reportEscalationMinutes} min)`
  );
}
