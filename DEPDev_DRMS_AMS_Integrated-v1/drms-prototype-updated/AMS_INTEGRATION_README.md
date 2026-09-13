# DEPDev DRMS + AMS Integrated Prototype

This build keeps the existing DRMS/DMS as the single application shell and integrates the Approval Management System workflow as an internal module.

## Workflow preserved
- Standard: Supervisor → Division Chief → ARD → RD
- Supervisor / Division Chief: **Endorse**
- ARD: **Clear**
- RD: **Final Approve**
- All approval decisions require a review screen; Return and Reject require remarks.
- Returned requests become editable for the requestor.
- Resubmission creates a new approval cycle and increments the document version when the revised file is uploaded; the workflow restarts at Supervisor.
- Approval history and DRMS audit trail are recorded.
- Notifications are sent to the next approver and requestor for major approval events.
- E-signature is intentionally not forced in this build because it remains subject to client confirmation.

## Demo flow
1. Log in as Staff.
2. Upload a document and choose **Create Approval Request**.
3. Keep Standard Workflow or choose Custom Chain.
4. Submit for approval.
5. Log in as Supervisor → Approval Queue → Review → Endorse.
6. Log in as Division Chief → Approval Queue → Review → Endorse.
7. Log in as ARD → Approval Queue → Review → Clear.
8. Log in as RD → Approval Queue → Review → Final Approve.
9. To demonstrate revision, use Return at any approval stage, log back in as Staff, open the returned request, and use **Revise & Resubmit**.

## Important implementation boundary
DRMS continues to own document records/files. AMS owns approval state only. The integrated JavaScript is isolated in `ams-integration.js` so the existing DMS implementation remains intact and can later be replaced by API calls without rebuilding the UI.
