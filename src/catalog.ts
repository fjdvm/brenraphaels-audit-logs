export const authenticationActions = [
  'user.login', 'user.login_failed', 'user.logout', 'user.created', 'user.deleted', 'user.restored',
  'password.changed', 'password.forgot_requested', 'credentials.resent',
  'access_grant.granted', 'access_grant.revoked', 'audit_log.exported',
] as const;

const recordActions = ['record.created', 'record.updated', 'record.deleted', 'record.viewed'];
// Module names from the authentication portal's lib/seed-data.ts; SCMS is now IMS.
export const catalog = [
  { source: 'CRMS', modules: ['Dashboard', 'Customer Profiles', 'Campaigns', 'Conversations', 'Tickets'], actions: recordActions },
  { source: 'HRMS', modules: ['Dashboard', 'Recruitment and Hiring', 'Employee Information', 'Payroll & ESS', 'Attendance Biometrics', 'User Management'], actions: recordActions },
  { source: 'POS', modules: ['Dashboard', 'Sales Processing', 'Order Management', 'Product Management/Price Configuration', 'Sales Report Analytics', 'Location/Branch Management', 'Stock Management'], actions: recordActions },
  { source: 'IMS', modules: ['Dashboard', 'Resources & Suppliers', 'Orders & Procurement', 'Inventory Module', 'Production and Quality', 'Distribution'], actions: recordActions },
  { source: 'Authentication', modules: [], actions: authenticationActions },
  { source: 'File storage', modules: [], actions: ['file.uploaded', 'file.downloaded', 'file.deleted', 'file.shared'] },
  { source: 'Notifications', modules: [], actions: ['notification.sent', 'notification.failed'] },
  { source: 'Ecommerce', modules: [], actions: ['customer.signed_up', 'customer.signed_in', 'customer.password_changed', 'customer.address_changed', 'order.placed', 'order.cancelled', 'payment.completed', 'support_ticket.opened'] },
];
