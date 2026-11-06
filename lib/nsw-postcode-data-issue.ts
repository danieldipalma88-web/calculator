// These are data gaps, not eligibility decisions. Never substitute a nearby postcode.
export function postcodeDataIssue(postcode: string) {
  if (["2611", "2618", "3691", "4375", "4377", "4380", "4383", "4385"].includes(postcode)) {
    return "Location verification required: this postcode crosses a state border. Confirm the NSW installation address, electricity distributor and BCA climate zone before calculating the rebate.";
  }
  if (postcode === "2678") return "Location verification required: use the physical installation address, not the university or mail-centre postal address. The site, electricity distributor and climate zone need confirmation.";
  if (postcode === "2898") return "Location verification required: Lord Howe Island has its own electricity network. A combined ESC/PERC estimate is unavailable; request a separate eligibility review.";
  if (postcode === "2619") return "Location verification required: the published calculator data is missing a network factor for Jerrabomberra. Confirm the installation address and electricity connection before calculating the rebate.";
  return "";
}
