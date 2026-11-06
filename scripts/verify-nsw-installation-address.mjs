import assert from "node:assert/strict";
import { matchNswInstallationAddress } from "../lib/nsw-installation-address.ts";

const component = (type, longText, shortText = longText) => ({ longText, shortText, types: [type] });
const validPlace = () => ({
  id: "place-123",
  formattedAddress: "10 Example Street, Sydney NSW 2000, Australia",
  types: ["street_address"],
  addressComponents: [
    component("country", "Australia", "AU"),
    component("administrative_area_level_1", "New South Wales", "NSW"),
    component("postal_code", "2000"),
    component("street_number", "10"),
    component("route", "Example Street"),
    component("locality", "Sydney"),
  ],
});

const accepted = matchNswInstallationAddress(validPlace(), "2000");
assert.deepEqual(accepted, {
  ok: true,
  address: { placeId: "place-123", formattedAddress: "10 Example Street, Sydney NSW 2000, Australia", postcode: "2000", state: "NSW", country: "AU", locality: "Sydney" },
});
assert.equal("latitude" in accepted.address, false);
assert.equal("eligible" in accepted.address, false);
assert.equal("rebate" in accepted.address, false);

const rejected = (place, postcode = "2000") => {
  const result = matchNswInstallationAddress(place, postcode);
  assert.equal(result.ok, false);
  return result.error;
};

assert.match(rejected(null), /Google installation address/);
assert.match(rejected(validPlace(), "200"), /four-digit/);
assert.match(rejected({ ...validPlace(), addressComponents: null }), /missing required physical/);
assert.match(rejected({ ...validPlace(), addressComponents: [...validPlace().addressComponents, null] }), /missing required physical/);
assert.match(rejected({ ...validPlace(), addressComponents: validPlace().addressComponents.slice(0, 4) }), /incomplete/);
assert.match(rejected({ ...validPlace(), addressComponents: [...validPlace().addressComponents, component("route", "Other Street")] }), /incomplete/);
assert.match(rejected({ ...validPlace(), addressComponents: [...validPlace().addressComponents, component("country", "Australia", "AU")] }), /incomplete/);
assert.match(rejected({ ...validPlace(), addressComponents: [...validPlace().addressComponents, component("administrative_area_level_1", "Victoria", "VIC")] }), /incomplete/);
assert.match(rejected({ ...validPlace(), addressComponents: [...validPlace().addressComponents, component("postal_code", "2001")] }), /incomplete/);
assert.match(rejected({ ...validPlace(), addressComponents: validPlace().addressComponents.map((item) => item.types[0] === "country" ? component("country", "United States", "US") : item) }), /outside NSW/);
assert.match(rejected({ ...validPlace(), addressComponents: validPlace().addressComponents.map((item) => item.types[0] === "administrative_area_level_1" ? component("administrative_area_level_1", "Victoria", "VIC") : item) }), /outside NSW/);
assert.match(rejected(validPlace(), "2001"), /does not match/);
assert.match(rejected({ ...validPlace(), addressComponents: validPlace().addressComponents.map((item) => item.types[0] === "street_number" ? component("street_number", "") : item) }), /full physical/);
assert.match(rejected({ ...validPlace(), addressComponents: validPlace().addressComponents.filter((item) => item.types[0] !== "locality") }), /incomplete/);
assert.match(rejected({ ...validPlace(), id: "" }), /full physical/);
assert.match(rejected({ ...validPlace(), formattedAddress: "" }), /full physical/);

const subpremisePlace = validPlace();
subpremisePlace.addressComponents.push(component("subpremise", "Unit 4"));
assert.equal(matchNswInstallationAddress(subpremisePlace, "2000").ok, true);

for (const mailType of ["POBox", "GPOBox", "PostOfficeBox", "LockedBag", "PrivateBag", "post_box"]) {
  const place = validPlace();
  place.types.push(mailType);
  assert.match(rejected(place), /mail-only/);
}
for (const mailPrefix of ["PO Box 123", "P.O. Box 123", "GPO Box 123", "G.P.O. Box 123", "Post Office Box 123", "Locked Bag 123", "Private Bag 123"]) {
  assert.match(rejected({ ...validPlace(), formattedAddress: `${mailPrefix}, Sydney NSW 2000` }), /mail-only/);
}
for (const mailComponent of ["PO Box 123", "P.O. Box 123", "GPO Box 123", "G.P.O. Box 123", "Locked Bag 123", "Private Bag 123"]) {
  assert.match(rejected({ ...validPlace(), formattedAddress: `Example University, ${mailComponent}, Suburb NSW 2678` }), /mail-only/);
}
const localityOnly = validPlace();
localityOnly.addressComponents = localityOnly.addressComponents.filter((item) => !["street_number", "route"].includes(item.types[0]));
assert.match(rejected(localityOnly), /incomplete/);
for (const resultType of ["postal_code", "locality"]) {
  const place = validPlace();
  place.types = [resultType];
  place.addressComponents = place.addressComponents.filter((item) => !["street_number", "route"].includes(item.types[0]));
  assert.match(rejected(place), /incomplete/);
}

const hostileText = validPlace();
hostileText.addressComponents.find((item) => item.types[0] === "route").longText = "'; throw new Error('must remain data'); //";
assert.equal(matchNswInstallationAddress(hostileText, "2000").ok, true);

console.log("NSW installation address validator cases passed.");
