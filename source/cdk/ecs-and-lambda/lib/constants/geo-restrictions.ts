/**
 * Geographic restrictions for CloudFront distributions
 * Includes countries with:
 * - Major tech hubs
 * - AWS regions
 * - Significant cloud computing adoption
 * - Active developer communities
 */
export const ALLOWED_COUNTRIES = {
  // North America
  NORTH_AMERICA: [
    "US", // United States
    "CA", // Canada
    "MX", // Mexico
  ],

  // Europe
  EUROPE: [
    "GB", // United Kingdom
    "DE", // Germany
    "FR", // France
    "IE", // Ireland (AWS Region)
    "NL", // Netherlands
    "SE", // Sweden (AWS Region)
    "NO", // Norway
    "FI", // Finland
    "DK", // Denmark
    "ES", // Spain
    "IT", // Italy
    "CH", // Switzerland
    "AT", // Austria
    "BE", // Belgium
    "PL", // Poland
  ],

  // Asia Pacific
  ASIA_PACIFIC: [
    "JP", // Japan
    "KR", // South Korea
    "SG", // Singapore
    "AU", // Australia
    "NZ", // New Zealand
    "HK", // Hong Kong
    "TW", // Taiwan
    "IN", // India
    "ID", // Indonesia
    "MY", // Malaysia
    "TH", // Thailand
    "VN", // Vietnam
  ],

  // South America
  SOUTH_AMERICA: [
    "BR", // Brazil
    "AR", // Argentina
    "CL", // Chile
    "CO", // Colombia
    "PE", // Peru
  ],

  // Middle East
  MIDDLE_EAST: [
    "AE", // United Arab Emirates
    "BH", // Bahrain (AWS Region)
    "IL", // Israel
    "SA", // Saudi Arabia
  ],
};

/**
 * Get all allowed countries as a single array
 */
export const getAllowedCountries = (): string[] => {
  return Object.values(ALLOWED_COUNTRIES).flat();
};
