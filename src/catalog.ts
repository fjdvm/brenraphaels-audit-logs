export const authenticationActions = [
  'user.login', 'user.login_failed', 'user.logout', 'user.created', 'user.deleted', 'user.restored',
  'password.changed', 'password.forgot_requested', 'credentials.resent',
  'access_grant.granted', 'access_grant.revoked', 'audit_log.exported',
] as const;

const recordActions = ['record.created', 'record.updated', 'record.deleted', 'record.viewed'] as const;
export const actionCatalog = {
  CRMS: recordActions, HRMS: recordActions, POS: recordActions, IMS: recordActions,
  Authentication: authenticationActions,
  'File storage': ['file.uploaded', 'file.downloaded', 'file.deleted', 'file.shared'],
  Notifications: ['notification.sent', 'notification.failed'],
  Ecommerce: ['customer.signed_up', 'customer.signed_in', 'customer.password_changed', 'customer.address_changed', 'order.placed', 'order.cancelled', 'payment.completed', 'support_ticket.opened'],
} as const;
export const sources = Object.keys(actionCatalog) as Array<keyof typeof actionCatalog>;
