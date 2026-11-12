export const authenticationActions = [
  'user.login', 'user.login_failed', 'user.logout', 'user.created', 'user.deleted', 'user.restored',
  'password.changed', 'password.forgot_requested', 'credentials.resent',
  'access_grant.granted', 'access_grant.revoked', 'audit_log.exported',
  'password.forgot_completed', 'user.role_changed',
  'system.handoff_authorized', 'system.handoff_exchanged', 'system.handoff_denied',
] as const;

const recordActions = ['record.created', 'record.updated', 'record.deleted', 'record.viewed'] as const;
export const imsActions = [
  ...recordActions,
  'purchase_requisition.submitted',
  'purchase_requisition.approved',
  'purchase_requisition.rejected',
  'purchase_order.created',
  'purchase_order.approved',
  'purchase_order.rejected',
  'delivery.received',
  'delivery.discrepancy_logged',
  'goods_receipt.inspected',
  'return_to_vendor.submitted',
  'return_to_vendor.approved',
  'return_to_vendor.rejected',
  'stock_in.approved',
  'stock_in.rejected',
  'stock_in.put_away',
  'cycle_count.reconciled',
  'loss_report.submitted',
  'loss_report.approved',
  'loss_report.rejected',
  'lot.recalled',
  'production_request.submitted',
  'production_request.approved',
  'production_request.rejected',
  'material.issued',
  'production_batch.stage_changed',
  'production_batch.qa_approved',
  'production_batch.qa_rejected',
  'stock_transfer.requested',
  'stock_transfer.approved',
  'stock_transfer.rejected',
  'stock_transfer.dispatched',
  'stock_transfer.received',
  'ims.signed_in',
  'ims.access_denied',
] as const;

export const actionCatalog = {
  CRMS: [
    ...recordActions,
    'order.delivery_fee_quoted', 'order.confirmed', 'order.cancelled', 'order.marked_paid',
    'order.preparing', 'order.dispatched', 'order.delivered', 'order.delivery_photo_attached',
    'return.approved', 'return.declined', 'return.goods_received', 'return.refunded', 'return.replaced',
    'ticket.opened', 'ticket.claimed', 'ticket.released', 'ticket.status_changed', 'ticket.priority_changed',
    'walk_in_customer.created', 'walk_in_customer.updated', 'customer_profile.viewed',
    'feedback.analysis_run', 'crms.signed_in', 'crms.access_denied',
  ],
  HRMS: [
    ...recordActions,
    'job_posting.created', 'job_posting.updated', 'job_posting.published',
    'job_posting.closed', 'job_posting.filled',
    'job_template.created', 'job_template.updated', 'job_template.deleted',
  ],
  POS: recordActions, IMS: imsActions,
  Authentication: authenticationActions,
  'File storage': ['file.uploaded', 'file.downloaded', 'file.deleted', 'file.shared'],
  Notifications: ['notification.sent', 'notification.failed'],
  Ecommerce: ['customer.signed_up', 'customer.signed_in', 'customer.password_changed', 'customer.address_changed', 'order.placed', 'order.cancelled', 'payment.completed', 'support_ticket.opened', 'feedback.request_sent'],
} as const;
export const sources = Object.keys(actionCatalog) as Array<keyof typeof actionCatalog>;

// Portal Module names plus producer vocabulary; retain legacy names for earlier events.
export const moduleCatalog: Partial<Record<keyof typeof actionCatalog, readonly string[]>> = {
  CRMS: ['Dashboard', 'Customer Profiles', 'Campaigns', 'Conversations', 'Tickets', 'Orders', 'Payments', 'Fulfilment', 'Returns', 'Marketing', 'Feedback'],
  HRMS: ['Dashboard', 'Recruitment and Hiring', 'Employee Information', 'Payroll & ESS', 'Attendance Biometrics', 'User Management'],
  POS: ['Dashboard', 'Sales Processing', 'Order Management', 'Product Management/Price Configuration', 'Sales Report Analytics', 'Location/Branch Management', 'Stock Management'],
  IMS: ['Dashboard', 'Resources & Suppliers', 'Orders & Procurement', 'Goods Receiving', 'Inventory', 'Production & Quality', 'Stock Transfer',
    'Inventory Module', 'Production and Quality', 'Distribution'],
};
export const catalog = sources.map(source => ({ source, modules: moduleCatalog[source] ?? [], actions: actionCatalog[source] }));
