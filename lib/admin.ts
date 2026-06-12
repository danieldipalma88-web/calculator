export const ownerEmails = ["danieldipalma88@gmail.com"];

export function isOwnerEmail(email?: string | null) {
  return Boolean(email && ownerEmails.includes(email.toLowerCase()));
}

export function isAdminRole(role?: string | null) {
  return role === "admin";
}

export function canManageUsers(email?: string | null, role?: string | null) {
  return isOwnerEmail(email) || isAdminRole(role);
}
