import contractProductRegister from "./dcceew-contract-products.json";

export const DCCEEW_CONTRACT_RATE = 30;

// Central register for the DCCEEW $30-per-ESC contract. Add an exact approved
// `BRAND|MODEL` key to dcceew-contract-products.json when a new catalogue model
// is added; the calculator will match it automatically without changing rebate
// logic or any business-specific catalogue pricing.
export const DCCEEW_CONTRACT_PRODUCT_REGISTER = contractProductRegister as readonly string[];
export const DCCEEW_ELIGIBLE_PRODUCT_KEYS = DCCEEW_CONTRACT_PRODUCT_REGISTER;

// Approved regional postcodes marked Average in the 14 September 2026
// "01. Postcode Templates for supply contracts regional.csv" source.
export const DCCEEW_ELIGIBLE_POSTCODES = [
  2311, 2312, 2321, 2324, 2386, 2387, 2388, 2390, 2397, 2398, 2399, 2400, 2401, 2402,
  2405, 2406, 2408, 2409, 2410, 2411, 2415, 2420, 2421, 2422, 2423, 2424, 2425, 2426,
  2427, 2428, 2429, 2430, 2431, 2439, 2440, 2441, 2443, 2444, 2445, 2446, 2447, 2448,
  2449, 2450, 2452, 2454, 2455, 2456, 2460, 2462, 2463, 2464, 2465, 2466, 2469, 2470,
  2471, 2472, 2473, 2474, 2480, 2648, 2669, 2672, 2675, 2678, 2680, 2681, 2700, 2703,
  2705, 2706, 2707, 2710, 2711, 2713, 2714, 2715, 2716, 2717, 2731, 2732, 2733, 2734,
  2735, 2736, 2737, 2738, 2739, 2831, 2832, 2833, 2834, 2835, 2836, 2838, 2839, 2840,
  2877, 2878, 2879, 2880, 2898, 2899, 3691, 4375, 4377, 4380, 4383, 4385,
] as const;
