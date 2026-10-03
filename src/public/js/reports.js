const reportsList = document.querySelector('#reports-list');
const reportsStatus = document.querySelector('#reports-status');
const reportFormSection = document.querySelector('#report-form-section');
const reportForm = document.querySelector('#report-form');
const reportFormStatus = document.querySelector('#report-form-status');
const channelId = new URLSearchParams(location.search).get('channelId');

async function loadUser() {
  const response = await fetch('/api/users/me');
  if (!response.ok) { location.href = '/login'; return false; }
  const user = await response.json();
  document.querySelector('#welcome').textContent = `Welcome, ${user.email}`;
  return true;
}

const reasonOptions = ['STREAM_DOES_NOT_LOAD', 'WRONG_CHANNEL', 'AUDIO_PROBLEM', 'VIDEO_PROBLEM', 'OTHER'];
const statusOptions = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];

function formatReason(reason) {
  return reason.toLowerCase().split('_').map((word) => `${word[0].toUpperCase()}${word.slice(1)}`).join(' ');
}

function getEvidenceUrls(report) {
  if (Array.isArray(report.evidenceUrls)) return report.evidenceUrls;
  return report.evidenceUrl ? [report.evidenceUrl] : [];
}

function createSelect(id, values, selected) {
  const select = document.createElement('select');
  select.id = id;
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = formatReason(value);
    option.selected = value === selected;
    select.append(option);
  }
  return select;
}

function createLabel(text, control) {
  const label = document.createElement('label');
  label.textContent = text;
  label.append(control);
  return label;
}

function createEditForm(report, item) {
  const form = document.createElement('form');
  form.className = 'report-edit-form';
  const reason = createSelect(`edit-reason-${report._id}`, reasonOptions, report.reason);
  const status = createSelect(`edit-status-${report._id}`, statusOptions, report.status);
  const description = document.createElement('textarea');
  description.id = `edit-description-${report._id}`;
  description.maxLength = 1000;
  description.required = true;
  description.value = report.description;
  const actions = document.createElement('div');
  actions.className = 'report-actions';
  const save = Object.assign(document.createElement('button'), { type: 'submit', className: 'report-button', textContent: 'Save changes' });
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'report-button', textContent: 'Cancel' });
  const message = Object.assign(document.createElement('p'), { className: 'form-status' });
  actions.append(save, cancel);
  form.append(createLabel('Reason', reason), createLabel('Description', description), createLabel('Status', status), actions, message);
  cancel.addEventListener('click', () => item.replaceWith(createReportItem(report)));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = 'Saving…';
    const ok = await updateReport(report._id, {
      reason: reason.value,
      description: description.value,
      status: status.value
    }, message);
    if (ok) await loadReports();
  });
  return form;
}

// TODO 13: enviar la actualización como JSON con PATCH.
async function updateReport(reportId, { reason, description, status }, message) {
  const response = await fetch(`/api/reports/${reportId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      reason,
      description,
      status
    })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    message.textContent = payload.error?.message || 'Could not update the report.';
    return false;
  }
  reportsStatus.textContent = 'Report updated.';
  return true;
}

// TODO 16: invocar DELETE desde la View.
async function deleteReport(reportId) {
  if (!confirm('Delete this report? This cannot be undone.')) return;
  const response = await fetch(`/api/reports/${reportId}`, {
    method: 'DELETE'
  });
  if (!response.ok) {
    reportsStatus.textContent = 'Could not delete the report.';
    return;
  }
  await loadReports();
  reportsStatus.textContent += ' · Report deleted.';
}

function createReportItem(report) {
  const item = document.createElement('article');
  item.className = 'report-item';
  item.dataset.reportId = report._id;
  const channel = document.createElement('h3');
  channel.textContent = report.channelId?.name || 'Channel unavailable';
  const reason = document.createElement('p');
  reason.textContent = `Reason: ${formatReason(report.reason)}`;
  const description = document.createElement('p');
  description.textContent = report.description;
  const status = document.createElement('p');
  status.className = 'report-status';
  status.dataset.status = report.status;
  status.textContent = report.status;
  const created = document.createElement('p');
  created.className = 'report-date';
  created.textContent = new Date(report.createdAt).toLocaleString();
  if (report.updatedAt && report.updatedAt !== report.createdAt) {
    created.textContent += ` · Updated ${new Date(report.updatedAt).toLocaleString()}`;
  }
  item.append(channel, reason, description, status, created);

  const evidenceUrls = getEvidenceUrls(report);
  if (evidenceUrls.length > 0) {
    const evidenceList = document.createElement('div');
    evidenceList.className = 'report-evidence';
    evidenceUrls.forEach((url, index) => {
      const evidence = document.createElement('a');
      evidence.href = url;
      evidence.target = '_blank';
      evidence.rel = 'noopener';
      evidence.textContent = evidenceUrls.length === 1 ? 'View evidence image' : `View evidence image ${index + 1}`;
      evidenceList.append(evidence);
    });
    item.append(evidenceList);
  }

  const actions = document.createElement('div');
  actions.className = 'report-actions';
  const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'report-button', textContent: 'Edit' });
  const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'report-button report-delete', textContent: 'Delete' });
  edit.addEventListener('click', () => {
    const editing = item.cloneNode(false);
    editing.append(channel.cloneNode(true), createEditForm(report, editing));
    item.replaceWith(editing);
  });
  remove.addEventListener('click', () => deleteReport(report._id));
  actions.append(edit, remove);
  item.append(actions);
  return item;
}

async function loadReports() {
  const response = await fetch('/api/reports');
  if (!response.ok) { reportsStatus.textContent = 'Could not load reports.'; return; }
  const { reports } = await response.json();
  reportsStatus.textContent = `${reports.length} report${reports.length === 1 ? '' : 's'}`;
  if (reports.length === 0) {
    reportsList.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: 'You have not reported a channel yet.' }));
    return;
  }
  reportsList.replaceChildren(...reports.map(createReportItem));
}

async function submitReport(event) {
  event.preventDefault();
  const formData = new FormData();
  formData.append('channelId', channelId);
  formData.append('reason', document.querySelector('#report-reason').value);
  formData.append('description', document.querySelector('#report-description').value);
  // TODO v4.5 4 / TODO 10:
  // Cada imagen se agrega con el mismo nombre "evidence" que espera upload.array('evidence', 5).
  const evidenceFiles =
    document.querySelector('#report-evidence').files;

  for (const file of evidenceFiles) {
    formData.append('evidence', file);
  }

  reportFormStatus.textContent = 'Submitting report…';
  // TODO v4.5 5:
  // FormData se envía como body; el navegador genera el boundary de multipart/form-data.
  const response = await fetch('/api/reports', {
    method: 'POST',
    body: formData
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    reportFormStatus.textContent = payload.error?.message || 'Could not submit the report.';
    return;
  }

  reportForm.reset();
  reportFormStatus.textContent = 'Report saved.';
  await loadReports();
}

function configureReportForm() {
  if (!channelId) return;
  reportFormSection.hidden = false;
  document.querySelector('#report-channel-id').value = channelId;
  document.querySelector('#report-channel').textContent = 'Report the selected channel.';
  reportForm.addEventListener('submit', submitReport);
}

document.querySelector('#logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login'; });
async function start() { if (await loadUser()) { configureReportForm(); await loadReports(); } }
start();
