import type { Metadata } from "next";

export const metadata: Metadata = { title: "Address lookup terms and privacy | Rebate Portal" };

export default function AddressLookupPolicy() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 24px 56px", lineHeight: 1.65 }}>
      <a href="/calculator">Back to calculator</a>
      <h1 style={{ fontSize: 28, lineHeight: 1.2 }}>Address lookup terms and privacy</h1>
      <p>Rebate Portal uses Google Maps Platform to suggest and match installation addresses. This notice covers the installation-location review window in the quote calculator.</p>
      <h2 style={{ fontSize: 20 }}>Information sent to Google</h2>
      <p>When you enter at least three characters, the address text is sent through our server to Google Places for suggestions. Selecting a suggestion sends its Google place identifier to Google to retrieve the structured address. Your calculator email, customer name, quotes, prices and rebate amounts are not included in these Google requests.</p>
      <p>Google processes this information under the <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a>. Use of the Google Maps features is subject to the <a href="https://maps.google.com/help/terms_maps/" target="_blank" rel="noopener noreferrer">Google Maps / Google Earth Additional Terms of Service</a>.</p>
      <h2 style={{ fontSize: 20 }}>How the review uses your address</h2>
      <p>The review checks that the selected result is a physical address in NSW, Australia, with the same postcode you entered. It does not verify the electricity connection, BCA climate zone or rebate eligibility, and it does not change a saved quote or approve a rebate.</p>
      <p>This review window holds the match temporarily while it is open. Editing the address, changing postcode or closing the window clears it. The review does not write the address or distributor selection to our database. Network providers may process technical request information under their own policies.</p>
      <h2 style={{ fontSize: 20 }}>Sharing review details</h2>
      <p>Copy review details puts the selected installation address, business name, postcode and any distributor you supply on your clipboard. Open email draft passes these details to your email application in a draft addressed to daniel@electric-future.com. It does not send an email automatically. Check the address and remove information you do not want to share before sending. Do not include a full electricity bill or account number.</p>
      <p>A distributor you select is recorded in the draft as user-reported, not verified. A separate review is needed before any rebate calculation can use site-specific inputs.</p>
      <h2 style={{ fontSize: 20 }}>Questions</h2>
      <p>For questions about this review or a correction to details you have emailed, contact <a href="mailto:daniel@electric-future.com">daniel@electric-future.com</a>.</p>
    </main>
  );
}
