/*
 * DEPDev DRMS + AMS Integration Layer
 * ------------------------------------
 * This file keeps DRMS as the single application shell and adds the AMS
 * approval state machine on top of the existing document records.
 *
 * Key invariants:
 *  - DMS/DRMS owns the document record and file metadata.
 *  - AMS owns approval workflow state.
 *  - Standard route: Supervisor -> Division Chief -> ARD -> RD.
 *  - Supervisor/DC = Endorse; ARD = Clear; RD = Final Approve.
 *  - Return makes the request editable for the requestor.
 *  - Resubmission starts a new cycle at the first approver.
 *  - Reject is terminal for that approval request.
 *  - Document version increments only when a revised file is submitted.
 *  - E-signature is intentionally not forced because that decision remains
 *    pending client confirmation.
 */
(function () {
  'use strict';

  var AMS_STANDARD_ROUTE = ['Supervisor', 'Division Chief', 'ARD', 'RD'];
  var AMS_ROLE_LABELS = {
    supervisor: 'Supervisor',
    dc: 'Division Chief',
    'division chief': 'Division Chief',
    ard: 'ARD',
    rd: 'RD'
  };
  var amsActionState = { ref: null, action: null };
  var amsRevisionRef = null;
  var originalShowPage = window.showPage;
  var originalConfirmApprovalRequest = window.confirmApprovalRequest;
  var originalRenderActionsMenu = window.renderActionsMenu;

  function roleKey(role) {
    var c = (typeof canonicalRole === 'function' ? canonicalRole(role) : String(role || '').toLowerCase()).trim();
    if (c === 'division chief' || c === 'chief' || c === 'dc') return 'dc';
    if (c === 'assistant regional director' || c === 'asst regional director' || c === 'ard') return 'ard';
    if (c === 'regional director' || c === 'rd') return 'rd';
    if (c === 'supervisor') return 'supervisor';
    return c;
  }

  function roleLabel(role) {
    return AMS_ROLE_LABELS[roleKey(role)] || (role || 'Approver');
  }

  function currentApprovalRole() {
    return roleLabel(currentUser && currentUser.role);
  }

  function isApproverRole(role) {
    return ['supervisor', 'dc', 'ard', 'rd', 'oic'].indexOf(roleKey(role)) !== -1;
  }

  function isStaffRole(role) { return roleKey(role) === 'staff'; }

  function getApprovalDocs() {
    return (window.DOCS || []).filter(function (d) { return d && d.isApprovalRequest; });
  }

  function getApprovalDoc(ref) {
    return (window.DOCS || []).find(function (d) { return d && d.ref === ref && d.isApprovalRequest; }) || null;
  }

  function isApprovalParticipant(doc, user) {
    if (!doc || !user || !doc.isApprovalRequest) return false;
    ensureApprovalState(doc);
    var userKeys = [user.name, user.email, user.id].filter(Boolean).map(function (value) {
      return String(value).trim().toLowerCase();
    });
    var people = (doc.approvalApproverChain || []).concat(doc.approvalApprovers || []);
    people.push({ name: doc.uploadedBy }, { name: doc.from }, { email: doc.senderEmail }, { id: doc.senderId });
    return people.some(function (person) {
      return [person.name, person.email, person.id].filter(Boolean).some(function (value) {
        return userKeys.indexOf(String(value).trim().toLowerCase()) !== -1;
      });
    });
  }

  window.canViewApprovalDocument = isApprovalParticipant;

  function getPersonForRole(role, division) {
    var rk = roleKey(role);
    var accounts = (window.USER_ACCOUNTS || []).filter(function (u) {
      if (!u || u.status === 'Deactivated') return false;
      return roleKey(u.roleLabel || u.role) === rk;
    });
    if (division) {
      var sameDivision = accounts.find(function (u) { return !u.division || u.division === division; });
      if (sameDivision) return sameDivision;
    }
    if (accounts.length) return accounts[0];
    var users = window.USERS || {};
    var fallback = Object.keys(users).map(function (k) { return users[k]; }).find(function (u) { return roleKey(u.roleLabel || u.role) === rk; });
    return fallback || { name: roleLabel(role), email: '' , role: rk, roleLabel: roleLabel(role) };
  }

  function personForStage(doc, index) {
    var route = doc.approvalRoute || AMS_STANDARD_ROUTE;
    var role = route[index];
    if (doc.approvalApproverChain && doc.approvalApproverChain[index]) return doc.approvalApproverChain[index];
    if (doc.approvalWorkflowMode === 'custom' && Array.isArray(doc.approvalApprovers)) {
      var custom = doc.approvalApprovers[index];
      if (custom) return custom;
    }
    return getPersonForRole(role, doc.division);
  }

  function nowISO() { return new Date().toISOString(); }
  function nowLabel() {
    try { return formatManilaDateTime(new Date()); } catch (e) { return new Date().toLocaleString(); }
  }

  function saveAMSState() {
    try { localStorage.setItem('depdev_ams_integrated_version', '1'); } catch (e) {}
    if (typeof saveDocuments === 'function') saveDocuments();
  }

  function ensureApprovalState(doc) {
    if (!doc || !doc.isApprovalRequest) return;
    doc.direction = 'outgoing';
    doc.kind = 'outgoing';
    if (!Array.isArray(doc.approvalRoute) || !doc.approvalRoute.length) {
      if (doc.approvalWorkflowMode === 'custom' && Array.isArray(doc.approvalApprovers) && doc.approvalApprovers.length) {
        doc.approvalRoute = doc.approvalApprovers.map(function (a) { return roleLabel(a.role); });
      } else doc.approvalRoute = AMS_STANDARD_ROUTE.slice();
    }
    if (typeof doc.approvalStageIndex !== 'number') doc.approvalStageIndex = doc.approvalStatus === 'Completed' ? doc.approvalRoute.length : 0;
    if (!doc.approvalCycle) doc.approvalCycle = 1;
    if (!doc.version) doc.version = 1;
    if (!Array.isArray(doc.approvalHistory)) {
      doc.approvalHistory = [];
      if (doc.tracking && Array.isArray(doc.tracking.trail)) {
        doc.tracking.trail.forEach(function (t) {
          if ((t.action || '').toLowerCase().indexOf('approval') !== -1 || (t.action || '').indexOf('Submitted') !== -1) {
            doc.approvalHistory.push({ cycle: doc.approvalCycle, actor: t.user, role: '', action: t.action, remarks: '', timestamp: t.timestamp });
          }
        });
      }
    }
    if (!Array.isArray(doc.approvalVersionHistory)) doc.approvalVersionHistory = [];
    if (!doc.approvalStatus) {
      if (doc.status === 'Done') doc.approvalStatus = 'Completed';
      else if (doc.status === 'Rejected') doc.approvalStatus = 'Rejected';
      else if (doc.status === 'Needs Clarification') doc.approvalStatus = 'Returned';
      else if (doc.status === 'Sent') doc.approvalStatus = 'For Approval';
    }
    if (!doc.approvalCurrentRole && doc.approvalStageIndex < doc.approvalRoute.length) doc.approvalCurrentRole = doc.approvalRoute[doc.approvalStageIndex];
    if (!doc.approvalCurrentApprover && doc.approvalStageIndex < doc.approvalRoute.length) doc.approvalCurrentApprover = personForStage(doc, doc.approvalStageIndex).name;
  }

  function normalizeExistingApprovalDocs() {
    getApprovalDocs().forEach(function (d) { ensureApprovalState(d); });
    if (typeof saveDocuments === 'function') saveDocuments();
  }

  function addApprovalHistory(doc, action, remarks, actor, role, cycle) {
    ensureApprovalState(doc);
    var entry = {
      cycle: cycle || doc.approvalCycle || 1,
      actor: actor || currentUser.name,
      role: role || currentApprovalRole(),
      action: action,
      remarks: remarks || '',
      timestamp: nowISO()
    };
    doc.approvalHistory.push(entry);
    if (!doc.tracking) doc.tracking = { trail: [], lastActor: '', lastUpdated: nowISO() };
    if (!Array.isArray(doc.tracking.trail)) doc.tracking.trail = [];
    doc.tracking.trail.push({ user: entry.actor, action: 'Approval: ' + action, timestamp: entry.timestamp, remarks: entry.remarks });
    doc.tracking.lastActor = currentUser.role;
    doc.tracking.lastUpdated = entry.timestamp;
  }

  function notifyApprovalRecipient(doc, person, message, type) {
    if (typeof addNotification !== 'function' || !person) return;
    var recipient = typeof resolveRecipient === 'function' ? resolveRecipient(person.email || person.name) : person;
    if (!recipient) return;
    addNotification({
      recipientKey: typeof getNotificationKeyForUser === 'function' ? getNotificationKeyForUser(recipient) : (recipient.email || recipient.name),
      type: type || 'document_received',
      documentId: doc.ref,
      documentRef: doc.ref,
      documentTitle: doc.subject,
      senderId: currentUser.id || currentUser.email || currentUser.name,
      senderName: currentUser.name,
      senderRole: currentUser.roleLabel || currentUser.role,
      message: message,
      preview: doc.subject
    });
  }

  function notifyRequestor(doc, message) {
    var author = typeof getDocumentAuthor === 'function' ? getDocumentAuthor(doc) : null;
    if (!author) author = { name: doc.uploadedBy, email: doc.senderEmail };
    if (!author || !author.name || author.name === currentUser.name) return;
    notifyApprovalRecipient(doc, author, message, 'document_message');
  }

  function patchAccountFeatures() {
    var approverRoles = ['supervisor', 'dc', 'ard', 'rd', 'oic', 'admin'];
    (window.USER_ACCOUNTS || []).forEach(function (u) {
      var rk = roleKey(u.role);
      if (approverRoles.indexOf(rk) !== -1) {
        u.features = Array.isArray(u.features) ? u.features : [];
        if (u.features.indexOf('approval-queue') === -1) u.features.push('approval-queue');
        if (u.features.indexOf('approval-history') === -1) u.features.push('approval-history');
      }
    });
  }

  function patchNav() {
    if (!window.MASTER_NAV) return;
    var main = window.MASTER_NAV.find(function (s) { return s.label === 'Main'; });
    if (main) main.items = main.items.filter(function (item) { return item.page !== 'approval-queue'; });

    var sectionIndex = window.MASTER_NAV.findIndex(function (s) { return s.label === 'Approval'; });
    var section = sectionIndex >= 0 ? window.MASTER_NAV[sectionIndex] : null;
    if (!section) {
      section = { label: 'Approval', items: [
        { icon: svgIcon('check', 16), text: 'Approval Queue', page: 'approval-queue' },
        { icon: svgIcon('filetext', 16), text: 'Approval History', page: 'approval-history' }
      ]};
      window.MASTER_NAV.push(section);
    }

    section.items = [
      { icon: svgIcon('check', 16), text: 'Approval Queue', page: 'approval-queue' },
      { icon: svgIcon('filetext', 16), text: 'Approval History', page: 'approval-history' }
    ];
    sectionIndex = window.MASTER_NAV.indexOf(section);
    var mainIndex = window.MASTER_NAV.indexOf(main);
    if (mainIndex >= 0 && sectionIndex !== mainIndex + 1) {
      window.MASTER_NAV.splice(sectionIndex, 1);
      window.MASTER_NAV.splice(mainIndex + 1, 0, section);
    }
  }

  function approvalAllowed(page) {
    var r = roleKey(currentUser.role);
    if (page === 'approval-queue') return ['supervisor','dc','ard','rd','oic','admin'].indexOf(r) !== -1;
    if (page === 'approval-history') return ['supervisor','dc','ard','rd','oic','admin'].indexOf(r) !== -1;
    if (page === 'approval-review') return ['supervisor','dc','ard','rd','oic','admin','staff'].indexOf(r) !== -1;
    return false;
  }

  function approvalPageTitle(page) {
    return page === 'approval-queue' ? 'Approval Queue' : page === 'approval-history' ? 'Approval History' : 'Review Document';
  }

  function statusBadge(status) {
    var cls = status === 'Returned' ? 'returned' : status === 'Rejected' ? 'rejected' : status === 'Completed' ? 'completed' : status === 'Draft' ? 'draft' : 'pending';
    return '<span class="ams-status ' + cls + '">' + escapeHtml(status || 'Pending') + '</span>';
  }

  function directionBadge(doc) {
    var d = (doc.direction || doc.kind || '').toLowerCase();
    var label = d === 'incoming' ? 'INCOMING' : d === 'outgoing' ? 'OUTGOING' : 'INTERNAL';
    return '<span class="direction-badge direction-' + (d || 'outgoing') + '">' + label + '</span>';
  }

  function routeDisplay(doc) {
    ensureApprovalState(doc);
    return doc.approvalRoute.map(function (r, i) {
      var cls = i < doc.approvalStageIndex ? 'done' : i === doc.approvalStageIndex && doc.approvalStatus === 'Returned' ? 'returned' : i === doc.approvalStageIndex ? 'current' : '';
      var state = i < doc.approvalStageIndex ? 'Completed' : i === doc.approvalStageIndex ? (doc.approvalStatus === 'Returned' ? 'Returned for revision' : 'Current') : 'Pending';
      return '<div class="ams-stage ' + cls + '"><div class="ams-stage-box"><div class="ams-stage-number">Stage ' + (i + 1) + '</div><div class="ams-stage-role">' + escapeHtml(r) + '</div><div class="ams-stage-state">' + escapeHtml(state) + '</div></div></div>';
    }).join('');
  }

  function approvalQueueDocs() {
    normalizeExistingApprovalDocs();
    var rk = roleKey(currentUser.role);
    if (rk === 'admin') return getApprovalDocs().filter(function (d) { return ['For Approval','Returned'].indexOf(d.approvalStatus) !== -1; });
    return getApprovalDocs().filter(function (d) {
      ensureApprovalState(d);
      return ['For Approval', 'Returned'].indexOf(d.approvalStatus) !== -1 && isApprovalParticipant(d, currentUser);
    });
  }

  function renderApprovalQueue() {
    var docs = approvalQueueDocs();
    var assignedCount = docs.filter(function (d) { return canActOnDoc(d); }).length;
    var all = getApprovalDocs();
    var pending = all.filter(function (d) { return d.approvalStatus === 'For Approval'; }).length;
    var returned = all.filter(function (d) { return d.approvalStatus === 'Returned'; }).length;
    var completed = all.filter(function (d) { return d.approvalStatus === 'Completed'; }).length;
    var h = '<div class="ams-page">';
    h += '<div class="ams-kpi-grid"><div class="ams-kpi"><div class="ams-kpi-label">Assigned to Me</div><div class="ams-kpi-value">' + assignedCount + '</div><div class="ams-kpi-note">Requests awaiting your action</div></div>';
    h += '<div class="ams-kpi"><div class="ams-kpi-label">All Pending</div><div class="ams-kpi-value">' + pending + '</div><div class="ams-kpi-note">Across approval workflows</div></div>';
    h += '<div class="ams-kpi"><div class="ams-kpi-label">Returned</div><div class="ams-kpi-value">' + returned + '</div><div class="ams-kpi-note">Awaiting requestor revision</div></div>';
    h += '<div class="ams-kpi"><div class="ams-kpi-label">Completed</div><div class="ams-kpi-value">' + completed + '</div><div class="ams-kpi-note">Final approval completed</div></div></div>';
    h += '<div class="card"><div class="card-head"><div><div class="card-title">Approval Requests</div><div style="font-size:11px;color:var(--muted);margin-top:.15rem">Review requests assigned to your current approval stage.</div></div></div>';
    h += '<div class="doc-table-wrap"><table class="doc-table"><thead><tr><th>Reference No.</th><th>Direction</th><th>Document</th><th>Current Stage</th><th>Requestor</th><th>Priority</th><th>Status</th><th>Action</th></tr></thead><tbody>';
    if (!docs.length) h += '<tr><td colspan="8"><div class="ams-empty"><strong>No approval requests assigned to you</strong>New requests will appear here when routed to your stage.</div></td></tr>';
    docs.forEach(function (d) {
      ensureApprovalState(d);
      var person = personForStage(d, d.approvalStageIndex);
      var priority = d.priority && d.priority !== 'Normal' ? '<span class="pill pill-' + (d.priority === 'Urgent' || d.priority === 'High' ? 'red' : 'amber') + '">' + escapeHtml(d.priority) + '</span>' : '<span style="font-size:11px;color:var(--muted)">Normal</span>';
      h += '<tr><td style="font-family:monospace;font-size:12px;font-weight:700">' + escapeHtml(d.ref) + '</td><td>' + directionBadge(d) + '</td><td><div style="font-weight:650;color:var(--navy)">' + escapeHtml(d.subject || 'Untitled') + '</div><div style="font-size:10px;color:var(--muted)">' + escapeHtml(d.type || '') + '</div></td><td><span class="ams-role-chip">' + escapeHtml(d.approvalCurrentRole || '—') + '</span><div style="font-size:10px;color:var(--muted);margin-top:.2rem">' + escapeHtml(person.name || '') + '</div></td><td>' + escapeHtml(d.uploadedBy || d.from || '—') + '</td><td>' + priority + '</td><td>' + statusBadge(d.approvalStatus || 'For Approval') + '</td><td><button class="btn-sm primary" onclick="openAMSReview(\'' + escapeHtml(d.ref) + '\')">' + (canActOnDoc(d) ? 'Review' : 'View') + '</button></td></tr>';
    });
    h += '</tbody></table></div></div></div>';
    return h;
  }

  function historyRows() {
    var rows = [];
    getApprovalDocs().forEach(function (d) {
      ensureApprovalState(d);
      (d.approvalHistory || []).forEach(function (x) { rows.push({ doc: d, entry: x }); });
    });
    rows.sort(function (a,b) { return new Date(b.entry.timestamp || 0) - new Date(a.entry.timestamp || 0); });
    return rows;
  }

  function renderApprovalHistory() {
    var rows = historyRows();
    var h = '<div class="ams-page"><div class="card"><div class="card-head"><div><div class="card-title">Approval History</div><div style="font-size:11px;color:var(--muted);margin-top:.15rem">Recorded approval actions across requests and approval cycles.</div></div></div>';
    h += '<div class="doc-table-wrap"><table class="ams-history-table"><thead><tr><th>Reference No.</th><th>Cycle</th><th>Actor</th><th>Role</th><th>Action</th><th>Date / Time</th><th>Remarks</th></tr></thead><tbody>';
    if (!rows.length) h += '<tr><td colspan="7"><div class="ams-empty"><strong>No approval history yet</strong>Approval actions will be recorded here.</div></td></tr>';
    rows.forEach(function (r) {
      h += '<tr><td style="font-family:monospace;font-weight:700;color:var(--navy3)">' + escapeHtml(r.doc.ref) + '</td><td>C' + escapeHtml(r.entry.cycle || 1) + '</td><td>' + escapeHtml(r.entry.actor || '—') + '</td><td>' + escapeHtml(r.entry.role || '—') + '</td><td class="ams-history-action">' + escapeHtml(r.entry.action || '—') + '</td><td>' + escapeHtml(r.entry.timestamp ? formatTrailTimestamp(r.entry.timestamp) : '—') + '</td><td>' + escapeHtml(r.entry.remarks || '—') + '</td></tr>';
    });
    h += '</tbody></table></div></div></div>';
    return h;
  }

  function canActOnDoc(doc) {
    ensureApprovalState(doc);
    if (!doc || doc.approvalStatus !== 'For Approval') return false;
    var rk = roleKey(currentUser.role);
    var stageRole = roleKey(doc.approvalCurrentRole);
    if (rk !== stageRole) return false;
    var p = personForStage(doc, doc.approvalStageIndex);
    return !p.name || p.name === currentUser.name || rk === 'admin';
  }

  function renderReview(ref) {
    var doc = getApprovalDoc(ref);
    if (!doc) return '<div class="card"><div style="padding:2rem">Approval request not found.</div></div>';
    ensureApprovalState(doc);
    var stagePerson = personForStage(doc, doc.approvalStageIndex);
    var canAct = canActOnDoc(doc);
    var isRequestor = doc.uploadedBy === currentUser.name || doc.from === currentUser.name;
    var h = '<div class="ams-page"><div style="margin-bottom:.75rem"><button class="btn-sm" onclick="showPage(\'' + (isRequestor ? 'outgoing' : 'approval-queue') + '\')">← Back</button></div>';
    h += '<div class="ams-doc-header"><div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;flex-wrap:wrap"><div><div class="ams-doc-ref">' + escapeHtml(doc.ref) + ' &nbsp; ' + directionBadge(doc) + '</div><div class="ams-doc-title">' + escapeHtml(doc.subject || 'Untitled Document') + '</div><div style="font-size:11px;color:var(--muted)">' + escapeHtml(doc.type || 'Document') + ' · Cycle ' + escapeHtml(doc.approvalCycle || 1) + ' · Version ' + escapeHtml(doc.version || 1) + '</div></div><div>' + statusBadge(doc.approvalStatus || 'For Approval') + '</div></div>';
    h += '<div class="ams-meta-grid"><div class="ams-meta-item"><div class="ams-meta-label">Requestor</div><div class="ams-meta-value">' + escapeHtml(doc.uploadedBy || doc.from || '—') + '</div></div><div class="ams-meta-item"><div class="ams-meta-label">Current Stage</div><div class="ams-meta-value">' + escapeHtml(doc.approvalCurrentRole || 'Completed') + (stagePerson && stagePerson.name ? ' · ' + escapeHtml(stagePerson.name) : '') + '</div></div><div class="ams-meta-item"><div class="ams-meta-label">Document Date</div><div class="ams-meta-value">' + escapeHtml(doc.documentDate || doc.date || '—') + '</div></div><div class="ams-meta-item"><div class="ams-meta-label">Priority</div><div class="ams-meta-value">' + escapeHtml(doc.priority || 'Normal') + '</div></div></div></div>';
    h += '<div class="ams-review-grid"><div class="ams-panel"><div class="ams-panel-head"><div class="ams-panel-title">Approval Workflow</div><span class="ams-role-chip">' + escapeHtml(doc.approvalWorkflowMode === 'custom' ? 'Custom Chain' : 'Standard Workflow') + '</span></div><div class="ams-panel-body"><div class="ams-tracker">' + routeDisplay(doc) + '</div>';
    h += '<div style="margin-top:.75rem"><button class="btn-sm" onclick="viewAMSVersion(\'' + escapeHtml(doc.ref) + '\',' + (doc.version || 1) + ')">View Latest</button>';
    h += renderApprovalVersionToggle(doc);
    h += ' <button class="btn-sm" onclick="viewAMSAudit(\'' + escapeHtml(doc.ref) + '\')">View Audit Trail</button></div>';
    h += '<div style="margin-top:1rem"><div class="ams-panel-title" style="font-size:12px;margin-bottom:.55rem">Approval History · Cycle ' + escapeHtml(doc.approvalCycle || 1) + '</div>' + renderRecentHistory(doc) + '</div>';
    h += '</div></div>';
    h += '<div class="ams-panel"><div class="ams-panel-head"><div class="ams-panel-title">Document Information</div></div><div class="ams-panel-body"><div style="font-size:11px;color:var(--muted);line-height:1.55">The document is maintained by DRMS. Approval configuration and decision history are maintained by AMS.</div>';
    h += '<div style="margin-top:1rem"><div class="ams-meta-item"><div class="ams-meta-label">Reference Number</div><div class="ams-meta-value" style="font-family:monospace">' + escapeHtml(doc.ref) + '</div></div></div>';
    if (doc.approvalRemarks) h += '<div style="margin-top:.65rem"><div class="ams-meta-item"><div class="ams-meta-label">Routing Instructions</div><div class="ams-meta-value">' + escapeHtml(doc.approvalRemarks) + '</div></div></div>';
    if (doc.approvalCC) h += '<div style="margin-top:.65rem"><div class="ams-meta-item"><div class="ams-meta-label">CC / For Information</div><div class="ams-meta-value">' + escapeHtml(doc.approvalCC) + '</div></div></div>';
    h += '</div></div></div>';
    if (canAct) {
      var rk = roleKey(currentUser.role); var label = rk === 'supervisor' || rk === 'dc' ? 'Endorse' : rk === 'ard' ? 'Clear' : rk === 'rd' ? 'Final Approve' : 'Act';
      h += '<div class="ams-action-bar"><button class="ams-action-secondary" onclick="openAMSAction(\'' + escapeHtml(doc.ref) + '\',\'return\')">Return</button><button class="ams-action-danger" onclick="openAMSAction(\'' + escapeHtml(doc.ref) + '\',\'reject\')">Reject</button><button class="ams-action-primary" onclick="openAMSAction(\'' + escapeHtml(doc.ref) + '\',\'advance\')">' + label + '</button></div>';
    } else if (doc.approvalStatus === 'Returned' && isRequestor) {
      h += '<div class="ams-action-bar"><button class="ams-action-primary" onclick="openAMSRevision(\'' + escapeHtml(doc.ref) + '\')">Revise &amp; Resubmit</button></div>';
    }
    h += '</div>';
    return h;
  }

  function renderRecentHistory(doc) {
    var arr = (doc.approvalHistory || []).filter(function (x) { return Number(x.cycle || 1) === Number(doc.approvalCycle || 1); });
    if (!arr.length) return '<div style="font-size:11px;color:var(--muted);padding:.75rem;background:#f8fafc;border-radius:7px">No actions recorded in this cycle yet.</div>';
    return '<div class="ams-audit-list">' + arr.slice().reverse().map(function (x) { return '<div class="ams-audit-item"><span class="ams-audit-dot"></span><div class="ams-audit-main"><strong>' + escapeHtml(x.actor || 'User') + '</strong> · ' + escapeHtml(x.action || '') + '<div class="ams-audit-time">' + escapeHtml(x.role || '') + ' · ' + escapeHtml(x.timestamp ? formatTrailTimestamp(x.timestamp) : '') + (x.remarks ? ' · ' + escapeHtml(x.remarks) : '') + '</div></div></div>'; }).join('') + '</div>';
  }

  function viewAMSOriginalDocument(ref) {
    if (!getApprovalDoc(ref)) return;
    currentEditingRef = ref;
    if (typeof viewDoc === 'function') viewDoc(ref);
  }

  function renderApprovalVersionToggle(doc) {
    var versions = [{ version: doc.version || 1, current: true, fileName: doc.fileName || (doc.attachments && doc.attachments[0] && doc.attachments[0].name) }];
    (doc.approvalVersionHistory || []).forEach(function (entry) {
      if (!versions.some(function (item) { return item.version === entry.version; })) {
        versions.push({ version: entry.version, current: false, fileName: entry.file || (entry.attachment && entry.attachment.name) });
      }
    });
    if (versions.length < 2) return '';
    versions.sort(function (a, b) { return b.version - a.version; });
    return '<span style="display:inline-flex;align-items:center;gap:.25rem;margin-left:.35rem;padding:.2rem;background:#f1f5f9;border:1px solid var(--border);border-radius:7px" aria-label="Document versions">' +
      versions.map(function (item) {
        var label = item.current ? 'Latest v' + item.version : 'Previous v' + item.version;
        return '<button class="btn-sm' + (item.current ? ' primary' : '') + '" title="' + escapeHtml(item.fileName || label) + '" onclick="viewAMSVersion(\'' + escapeHtml(doc.ref) + '\',' + item.version + ')">' + escapeHtml(label) + '</button>';
      }).join('') + '</span>';
  }

  function viewAMSVersion(ref, version) {
    var doc = getApprovalDoc(ref);
    if (!doc) return;
    var entry = (doc.approvalVersionHistory || []).find(function (item) { return Number(item.version) === Number(version); });
    if (Number(version) !== Number(doc.version) && (!entry || !entry.attachment)) {
      showError('The previous file is not available in this saved request.');
      return;
    }
    currentEditingRef = ref;
    if (typeof viewDoc === 'function') viewDoc(ref, Number(version));
  }

  function viewAMSAudit(ref) {
    currentEditingRef = ref;
    showPage('document-trail');
  }

  window.openAMSReview = function (ref) { showPage('approval-review', ref); };
  window.viewAMSOriginalDocument = viewAMSOriginalDocument;
  window.viewAMSVersion = viewAMSVersion;
  window.viewAMSAudit = viewAMSAudit;

  function renderApprovalPage(page, ref) {
    if (!approvalAllowed(page)) return '<div class="card"><div style="padding:2rem;text-align:center">Access denied.</div></div>';
    if (page === 'approval-queue') return renderApprovalQueue();
    if (page === 'approval-history') return renderApprovalHistory();
    return renderReview(ref);
  }

  window.showPage = function (page, ref) {
    if (page === 'approval-queue' || page === 'approval-history' || page === 'approval-review') {
      closeSidebarOnMobile();
      if (!approvalAllowed(page)) { showError('You do not have permission to access Approval Management.'); return; }
      currentPage = page;
      document.querySelectorAll('.sb-item').forEach(function (i) { i.classList.remove('active'); });
      var nav = document.getElementById('nav-' + page);
      if (nav) nav.classList.add('active');
      var title = approvalPageTitle(page);
      document.title = title + ' | DepDev DRMS Prototype';
      var c = document.getElementById('main-content');
      c.innerHTML = renderPageHeader(title) + renderApprovalPage(page, ref || currentEditingRef || null);
      return;
    }
    return originalShowPage.apply(this, arguments);
  };

  function decorateNewApprovalDocument(doc, captured) {
    if (!doc) return;
    var mode = captured.mode || 'standard';
    var selected = captured.selected || [];
    var route, chain;
    if (mode === 'custom') {
      route = selected.map(function (a) { return roleLabel(a.role); });
      chain = selected.map(function (a) { return { name: a.name, email: a.email, role: roleLabel(a.role) }; });
    } else {
      route = AMS_STANDARD_ROUTE.slice();
      chain = route.map(function (r) { var p = getPersonForRole(r, doc.division); return { name: p.name, email: p.email || '', role: r }; });
    }
    doc.isApprovalRequest = true;
    doc.direction = 'outgoing';
    doc.kind = 'outgoing';
    doc.approvalStatus = 'For Approval';
    doc.approvalWorkflowMode = mode;
    doc.approvalRoute = route;
    doc.approvalApproverChain = chain;
    doc.approvalStageIndex = 0;
    doc.approvalCurrentRole = route[0];
    doc.approvalCurrentApprover = chain[0] ? chain[0].name : route[0];
    doc.approvalCycle = 1;
    doc.version = doc.version || 1;
    doc.approvalCC = captured.cc || '';
    doc.approvalRemarks = captured.remarks || '';
    doc.approvalHistory = [];
    doc.approvalVersionHistory = [];
    addApprovalHistory(doc, 'Submitted', 'Approval request submitted through DRMS.', currentUser.name, currentUser.roleLabel || currentUser.role, 1);
    doc.status = 'Sent';
    doc.to = doc.approvalCurrentApprover;
    doc.currentHandler = doc.approvalCurrentApprover;
    doc.approvalLastActionAt = nowISO();
    doc.tracking.lastActor = currentUser.role;
    doc.tracking.lastUpdated = nowISO();
    var p = chain[0];
    notifyApprovalRecipient(doc, p, currentUser.name + ' submitted an approval request (' + doc.ref + ') for your review.', 'document_received');
    saveAMSState();
  }

  window.confirmApprovalRequest = function () {
    var captured = {
      mode: (document.getElementById('approval-workflow-mode') || {}).value || 'standard',
      selected: Array.from(document.querySelectorAll('.approval-approver:checked')).map(function (input) { return { name: input.getAttribute('data-name'), email: input.value, role: input.getAttribute('data-role') || 'Approver' }; }),
      cc: ((document.getElementById('approval-cc') || {}).value || '').trim(),
      remarks: ((document.getElementById('approval-remarks') || {}).value || '').trim()
    };
    var beforeRefs = (window.DOCS || []).map(function (d) { return d.ref; });
    originalConfirmApprovalRequest.apply(this, arguments);
    var newDoc = (window.DOCS || []).find(function (d) { return beforeRefs.indexOf(d.ref) === -1; });
    if (newDoc) decorateNewApprovalDocument(newDoc, captured);
    if (isStaffRole(currentUser.role)) {
      currentOutgoingTab = 'for-approval';
      renderNav();
      showPage('outgoing');
    }
  };

  function openAMSAction(ref, action) {
    var doc = getApprovalDoc(ref);
    if (!doc || !canActOnDoc(doc)) { showError('This request is no longer assigned to your approval stage.'); return; }
    amsActionState = { ref: ref, action: action };
    var role = currentApprovalRole();
    var title = action === 'return' ? 'Return Request' : action === 'reject' ? 'Reject Request' : 'Confirm ' + (roleKey(currentUser.role) === 'supervisor' || roleKey(currentUser.role) === 'dc' ? 'Endorse' : roleKey(currentUser.role) === 'ard' ? 'Clear' : roleKey(currentUser.role) === 'rd' ? 'Final Approve' : 'Action');
    document.getElementById('ams-action-title').textContent = title;
    document.getElementById('ams-action-reason-label').textContent = action === 'advance' ? 'Remarks (optional)' : (action === 'return' ? 'Reason for Return *' : 'Reason for Rejection *');
    document.getElementById('ams-action-reason').value = '';
    document.getElementById('ams-action-error').classList.remove('show');
    document.getElementById('ams-action-confirm').textContent = action === 'return' ? 'Return Request' : action === 'reject' ? 'Reject Request' : 'Confirm';
    document.getElementById('ams-action-summary').innerHTML = '<strong>' + escapeHtml(doc.ref) + '</strong><br>' + escapeHtml(doc.subject || 'Untitled Document') + '<br><span style="color:var(--muted)">Current stage: ' + escapeHtml(doc.approvalCurrentRole || '') + ' · Cycle ' + escapeHtml(doc.approvalCycle || 1) + '</span>';
    document.getElementById('ams-action-modal').classList.add('open'); document.body.classList.add('modal-open');
  }
  window.openAMSAction = openAMSAction;
  window.closeAMSActionModal = function () { document.getElementById('ams-action-modal').classList.remove('open'); document.body.classList.remove('modal-open'); amsActionState = {ref:null,action:null}; };

  window.confirmAMSAction = function () {
    var ref = amsActionState.ref, action = amsActionState.action;
    var doc = getApprovalDoc(ref); if (!doc || !canActOnDoc(doc)) { closeAMSActionModal(); return; }
    var remarks = (document.getElementById('ams-action-reason').value || '').trim();
    if ((action === 'return' || action === 'reject') && !remarks) { document.getElementById('ams-action-error').classList.add('show'); return; }
    var rk = roleKey(currentUser.role), role = currentApprovalRole(), idx = doc.approvalStageIndex;
    if (action === 'advance') {
      var act = rk === 'supervisor' || rk === 'dc' ? 'Endorsed' : rk === 'ard' ? 'Cleared' : rk === 'rd' ? 'Final Approved' : 'Completed';
      addApprovalHistory(doc, act, remarks || act + '.', currentUser.name, role, doc.approvalCycle);
      idx += 1; doc.approvalStageIndex = idx;
      if (idx >= doc.approvalRoute.length) {
        doc.approvalStatus = 'Completed'; doc.approvalCurrentRole = null; doc.approvalCurrentApprover = null; doc.status = 'Done'; doc.currentHandler = null;
        notifyRequestor(doc, 'Your approval request (' + doc.ref + ') received final approval.');
      } else {
        doc.approvalStatus = 'For Approval'; doc.approvalCurrentRole = doc.approvalRoute[idx]; var p = personForStage(doc, idx); doc.approvalCurrentApprover = p.name; doc.to = p.name; doc.currentHandler = p.name;
        notifyApprovalRecipient(doc, p, doc.ref + ' has been ' + act.toLowerCase() + ' and is now routed to you for ' + doc.approvalCurrentRole + '.', 'document_received');
        notifyRequestor(doc, 'Your request (' + doc.ref + ') was ' + act.toLowerCase() + ' by ' + role + ' and forwarded to ' + doc.approvalCurrentRole + '.');
      }
    } else if (action === 'return') {
      addApprovalHistory(doc, 'Returned', remarks, currentUser.name, role, doc.approvalCycle);
      doc.approvalReturnStageIndex = idx; doc.approvalStatus = 'Returned'; doc.approvalCurrentRole = role; doc.approvalCurrentApprover = 'Returned to Requestor'; doc.status = 'Needs Clarification'; doc.currentHandler = doc.uploadedBy || doc.from || currentUser.name;
      notifyRequestor(doc, doc.ref + ' was returned by ' + role + ' for revision.');
    } else if (action === 'reject') {
      addApprovalHistory(doc, 'Rejected', remarks, currentUser.name, role, doc.approvalCycle);
      doc.approvalStatus = 'Rejected'; doc.approvalCurrentRole = role; doc.approvalCurrentApprover = 'Rejected'; doc.status = 'Rejected'; doc.currentHandler = null;
      notifyRequestor(doc, doc.ref + ' was rejected by ' + role + '.');
    }
    doc.approvalLastActionAt = nowISO();
    saveAMSState(); closeAMSActionModal();
    showSuccess(action === 'return' ? 'Request returned for revision.' : action === 'reject' ? 'Request rejected.' : (rk === 'rd' ? 'Final approval recorded.' : 'Approval action recorded.'));
    showPage('approval-review', ref);
  };

  window.openAMSRevision = function (ref) {
    var doc = getApprovalDoc(ref);
    if (!doc || doc.approvalStatus !== 'Returned' || (doc.uploadedBy !== currentUser.name && doc.from !== currentUser.name)) return;
    amsRevisionRef = ref;
    document.getElementById('ams-revision-file').value = '';
    document.getElementById('ams-revision-remarks').value = '';
    document.getElementById('ams-revision-error').classList.remove('show');
    document.getElementById('ams-revision-summary').innerHTML = '<strong>' + escapeHtml(ref) + '</strong><br>' + escapeHtml(doc.subject || '') + '<br><span style="color:var(--muted)">Current Cycle ' + escapeHtml(doc.approvalCycle || 1) + ' · Current Version ' + escapeHtml(doc.version || 1) + '</span>';
    document.getElementById('ams-revision-current').textContent = 'Current file: ' + ((doc.attachments && doc.attachments[0] && doc.attachments[0].name) || doc.fileName || 'No file recorded');
    document.getElementById('ams-revision-modal').classList.add('open'); document.body.classList.add('modal-open');
  };
  window.closeAMSRevisionModal = function () { document.getElementById('ams-revision-modal').classList.remove('open'); document.body.classList.remove('modal-open'); amsRevisionRef = null; };

  window.confirmAMSRevision = function () {
    var doc = getApprovalDoc(amsRevisionRef); var input = document.getElementById('ams-revision-file'); var file = input && input.files && input.files[0];
    if (!doc || !file) { document.getElementById('ams-revision-error').classList.add('show'); return; }
    var oldVersion = doc.version || 1;
    if (!Array.isArray(doc.approvalVersionHistory)) doc.approvalVersionHistory = [];
    var oldAttachment = doc.attachments && doc.attachments[0];
    doc.approvalVersionHistory.push({ version: oldVersion, cycle: doc.approvalCycle || 1, status: doc.approvalStatus, file: oldAttachment ? oldAttachment.name : '', attachment: oldAttachment && typeof cloneAttachmentData === 'function' ? cloneAttachmentData(oldAttachment) : oldAttachment, timestamp: nowISO() });
    doc.version = oldVersion + 1;
    doc.approvalCycle = (doc.approvalCycle || 1) + 1;
    doc.approvalStageIndex = 0;
    doc.approvalStatus = 'For Approval';
    doc.approvalCurrentRole = doc.approvalRoute[0];
    var first = personForStage(doc, 0); doc.approvalCurrentApprover = first.name; doc.to = first.name; doc.currentHandler = first.name;
    doc.status = 'Sent';
    var att = typeof cloneAttachmentData === 'function' ? cloneAttachmentData(file) : { name:file.name, size:file.size, type:file.type, file:file, url:URL.createObjectURL(file) };
    doc.attachments = [att]; doc.fileName = file.name;
    var remark = (document.getElementById('ams-revision-remarks').value || '').trim();
    addApprovalHistory(doc, 'Resubmitted', 'Cycle ' + doc.approvalCycle + ' resubmitted with revised document.' + (remark ? ' ' + remark : ''), currentUser.name, currentUser.roleLabel || currentUser.role, doc.approvalCycle);
    notifyApprovalRecipient(doc, first, currentUser.name + ' resubmitted ' + doc.ref + ' (Cycle ' + doc.approvalCycle + ') for your review.', 'document_received');
    saveAMSState(); closeAMSRevisionModal(); showSuccess(doc.ref + ' has been resubmitted and routed to ' + doc.approvalCurrentRole + '.'); showPage('outgoing');
  };

  function seedDemoApprovalRequest() {
    normalizeExistingApprovalDocs();
    if (getApprovalDocs().length) return;
    if (!window.DOCS || !window.DOCS.length) return;
    var source = window.DOCS.find(function (d) { return d.uploadedBy === 'Staff Ana' && d.kind === 'outgoing'; }) || window.DOCS[0];
    if (!source) return;
    var demo = Object.assign({}, source);
    demo.ref = nextSystemReference(formatDateISO(new Date())); demo.subject = 'Regional Operations Memorandum — Demo Approval Request'; demo.type = 'Memorandum'; demo.status = 'Sent'; demo.direction = 'outgoing'; demo.kind = 'outgoing'; demo.uploadedBy = 'Staff Ana'; demo.from = 'Staff Ana'; demo.senderName = 'Staff Ana'; demo.division = 'Monitoring and Evaluation Division'; demo.isApprovalRequest = true; demo.approvalWorkflowMode = 'standard'; demo.approvalRoute = AMS_STANDARD_ROUTE.slice(); demo.approvalApproverChain = demo.approvalRoute.map(function (r) { var p = getPersonForRole(r, demo.division); return {name:p.name,email:p.email||'',role:r}; }); demo.approvalStageIndex = 0; demo.approvalCurrentRole = 'Supervisor'; demo.approvalCurrentApprover = demo.approvalApproverChain[0].name; demo.approvalCycle = 1; demo.version = 1; demo.approvalStatus = 'For Approval'; demo.approvalCC = ''; demo.approvalRemarks = 'Demo request created for the integrated DRMS + AMS approval flow.'; demo.approvalHistory = []; demo.approvalVersionHistory = []; demo.tracking = { lastActor:'staff', lastUpdated:nowISO(), trail:[] }; addApprovalHistory(demo,'Submitted',demo.approvalRemarks,'Staff Ana','Staff',1); window.DOCS.unshift(demo); saveDocuments();
  }

  function removeLegacyDemoApprovalRequest() {
    var before = window.DOCS.length;
    window.DOCS = window.DOCS.filter(function (doc) {
      return !(doc && /^DEP-\d{4}-\d{2}-AMS\d+$/.test(doc.ref || '') && doc.subject === 'Regional Operations Memorandum — Demo Approval Request');
    });
    if (window.DOCS.length !== before && typeof saveDocuments === 'function') saveDocuments();
  }

  function handleAMSMenu(ref, action) {
    var doc = getApprovalDoc(ref);
    if (!doc) return;
    if (action === 'approval') {
      if (isApproverRole(currentUser.role) && canActOnDoc(doc)) openAMSReview(ref);
      else showPage('approval-review', ref);
    } else if (action === 'revise' && doc.approvalStatus === 'Returned') {
      openAMSRevision(ref);
    } else if (action === 'document') {
      viewAMSOriginalDocument(ref);
    } else if (action === 'audit') {
      viewAMSAudit(ref);
    } else if (action === 'print' && typeof printDocument === 'function') {
      printDocument(ref);
    }
  }
  window.handleAMSMenu = handleAMSMenu;

  window.renderActionsMenu = function (ref, editFn) {
    var doc = typeof getDocByRef === 'function' ? getDocByRef(ref) : getApprovalDoc(ref);
    if (doc && doc.isApprovalRequest) {
      var opts = '<option value="" disabled selected hidden>Options</option>';
      if (isApproverRole(currentUser.role) && canActOnDoc(doc)) opts += '<option value="approval">Review Approval</option>';
      else opts += '<option value="approval">View Approval Request</option>';
      if ((doc.uploadedBy === currentUser.name || doc.from === currentUser.name) && doc.approvalStatus === 'Returned') opts += '<option value="revise">Revise &amp; Resubmit</option>';
      opts += '<option value="document">View Document</option><option value="audit">Audit Trail</option><option value="print">Print</option>';
      return '<select class="btn-sm primary" onchange="handleAMSMenu(\'' + escapeHtml(ref) + '\',this.value);this.value=\'\'">' + opts + '</select>';
    }
    return originalRenderActionsMenu.apply(this, arguments);
  };

  function install() {
    removeLegacyDemoApprovalRequest();
    patchAccountFeatures(); patchNav(); normalizeExistingApprovalDocs();
    // The integrated prototype includes one approval request only when no approval request exists,
    // making the end-to-end demo usable immediately while leaving ordinary DMS records untouched.
    seedDemoApprovalRequest();
    // Ensure account features are reflected immediately after login/nav rendering.
    if (typeof renderNav === 'function') renderNav();
  }

  // Expose the small public API for future backend wiring.
  window.AMS = {
    standardRoute: AMS_STANDARD_ROUTE.slice(),
    getRequests: getApprovalDocs,
    getRequest: getApprovalDoc,
    openReview: window.openAMSReview,
    openAction: openAMSAction,
    openRevision: window.openAMSRevision
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
