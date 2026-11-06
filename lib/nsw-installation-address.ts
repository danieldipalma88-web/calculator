export type NswInstallationAddress = {
  placeId: string;
  formattedAddress: string;
  postcode: string;
  state: "NSW";
  country: "AU";
  locality: string;
};

export type NswInstallationAddressResult =
  | { ok: false; error: string }
  | { ok: true; address: NswInstallationAddress };

type AddressComponent = {
  longText?: unknown;
  shortText?: unknown;
  types?: unknown;
};

const MAIL_ONLY_TYPES = new Set([
  "pobox",
  "gpobox",
  "postofficebox",
  "lockedbag",
  "privatebag",
  "postbox",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedType(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function componentsOfType(components: AddressComponent[], type: string): AddressComponent[] {
  return components.filter((component) =>
    Array.isArray(component.types) && component.types.some((value) => value === type),
  );
}

function componentText(component: AddressComponent, preferred: "shortText" | "longText"): string {
  return text(component[preferred]) || text(component[preferred === "shortText" ? "longText" : "shortText"]);
}

export function matchNswInstallationAddress(
  place: unknown,
  expectedPostcode: string,
): NswInstallationAddressResult {
  if (!/^\d{4}$/.test(expectedPostcode)) {
    return { ok: false, error: "Enter a valid four-digit installation postcode." };
  }
  if (!place || typeof place !== "object" || Array.isArray(place)) {
    return { ok: false, error: "Choose a complete Google installation address." };
  }

  const candidate = place as Record<string, unknown>;
  const formattedAddress = text(candidate.formattedAddress);
  if (/(?:^|[,;\r\n])\s*(?:p\.?\s*o\.?\s*box|g\.?\s*p\.?\s*o\.?\s*box|post\s+office\s+box|locked\s+bag|private\s+bag)\b/i.test(formattedAddress)) {
    return { ok: false, error: "A physical street address is required; PO boxes and mail-only addresses cannot be used." };
  }
  const components = candidate.addressComponents;
  if (!Array.isArray(components) || !components.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    return { ok: false, error: "The Google address is missing required physical-address components." };
  }
  const addressComponents = components as AddressComponent[];
  const placeTypes = Array.isArray(candidate.types) ? candidate.types : [];
  const allTypes = [
    ...placeTypes,
    ...addressComponents.flatMap((component) => Array.isArray(component.types) ? component.types : []),
  ];
  if (allTypes.some((type) => MAIL_ONLY_TYPES.has(normalizedType(type)))) {
    return { ok: false, error: "A physical street address is required; PO boxes and mail-only addresses cannot be used." };
  }

  const country = componentsOfType(addressComponents, "country");
  const state = componentsOfType(addressComponents, "administrative_area_level_1");
  if ((country.length === 1 && componentText(country[0], "shortText") !== "AU") ||
      (state.length === 1 && componentText(state[0], "shortText") !== "NSW")) {
    return { ok: false, error: "The selected installation address is outside NSW, Australia." };
  }

  const postalCode = componentsOfType(addressComponents, "postal_code");
  if (postalCode.length === 1 && componentText(postalCode[0], "longText") !== expectedPostcode) {
    return { ok: false, error: "The selected address postcode does not match the entered installation postcode." };
  }

  const required = [country, state, postalCode,
    componentsOfType(addressComponents, "street_number"),
    componentsOfType(addressComponents, "route"),
    componentsOfType(addressComponents, "locality")];
  if (required.some((matches) => matches.length !== 1)) {
    return { ok: false, error: "The Google result is incomplete; a full physical street address with locality, state, and postcode is required." };
  }

  if (componentText(country[0], "shortText") !== "AU" || componentText(state[0], "shortText") !== "NSW") {
    return { ok: false, error: "The selected installation address is outside NSW, Australia." };
  }
  if (componentText(postalCode[0], "longText") !== expectedPostcode) {
    return { ok: false, error: "The selected address postcode does not match the entered installation postcode." };
  }

  const placeId = text(candidate.id);
  const streetNumber = componentText(required[3][0], "longText");
  const route = componentText(required[4][0], "longText");
  const locality = componentText(required[5][0], "longText");
  if (!placeId || !formattedAddress || !streetNumber || !route || !locality) {
    return { ok: false, error: "The Google result is incomplete; a full physical street address with locality, state, and postcode is required." };
  }

  return {
    ok: true,
    address: { placeId, formattedAddress, postcode: expectedPostcode, state: "NSW", country: "AU", locality },
  };
}
