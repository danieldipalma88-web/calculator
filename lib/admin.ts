export const ownerEmails = ["danieldipalma88@gmail.com"];

export function isOwnerEmail(email?: string | null) {
  return Boolean(email && ownerEmails.includes(email.toLowerCase()));
}

export function isAdminRole(role?: string | null) {
  return role === "admin";
}

export function canSeeCommissionDetails(role?: string | null) {
  return role === "admin" || role === "business_owner" || role === "agency";
}

export function canSeeProfitDetails(role?: string | null) {
  return canSeeCommissionDetails(role);
}

export function canSeeAgencyProfit(role?: string | null) {
  return role === "admin" || role === "business_owner";
}

export function canManageUsers(email?: string | null, role?: string | null) {
  return isOwnerEmail(email) || isAdminRole(role);
}
